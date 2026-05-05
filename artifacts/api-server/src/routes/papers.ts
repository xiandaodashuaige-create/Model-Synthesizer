import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, papersTable, sessionsTable } from "@workspace/db";
import {
  SearchPapersBody,
  LookupPaperBody,
  ListSessionPapersParams,
  AddPaperToSessionParams,
  AddPaperToSessionBody,
  RemovePaperFromSessionParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Simple in-memory search cache (TTL: 15 minutes)
const searchCache = new Map<string, { results: unknown[]; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

function getCacheKey(query: string, limit: number) {
  return `${query.toLowerCase().trim()}:${limit}`;
}

/** Reconstruct abstract from OpenAlex inverted index format */
function reconstructAbstract(invertedIndex: Record<string, number[]> | null | undefined): string | null {
  if (!invertedIndex || Object.keys(invertedIndex).length === 0) return null;
  const positions: [number, string][] = [];
  for (const [word, idxs] of Object.entries(invertedIndex)) {
    for (const idx of idxs) positions.push([idx, word]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ");
}

type OpenAlexWork = {
  id: string;
  title: string;
  authorships: Array<{ author: { display_name: string } }>;
  publication_year: number | null;
  cited_by_count: number | null;
  primary_location: {
    landing_page_url?: string;
    pdf_url?: string | null;
    source?: { display_name?: string };
  } | null;
  abstract_inverted_index: Record<string, number[]> | null;
};

type PaperResult = {
  externalId: string; title: string; abstract: string | null;
  authors: string[]; year: number | null; venue: string | null;
  citationCount: number | null; openAccessUrl: string | null; url: string;
};

const OPENALEX_HEADERS = {
  "User-Agent": "ResearchModelBuilder/1.0 (mailto:research@researchmodelbuilder.app)",
};
const SELECT_FIELDS =
  "id,title,authorships,publication_year,cited_by_count,primary_location,abstract_inverted_index";

function workToPaper(work: OpenAlexWork): PaperResult {
  const externalId = work.id.replace("https://openalex.org/", "");
  const authors = (work.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean) as string[];
  const venue = work.primary_location?.source?.display_name ?? null;
  const openAccessUrl = work.primary_location?.pdf_url ?? null;
  const url = work.primary_location?.landing_page_url ?? `https://openalex.org/${externalId}`;
  const abstract = reconstructAbstract(work.abstract_inverted_index);

  return {
    externalId,
    title: work.title,
    abstract,
    authors,
    year: work.publication_year,
    venue,
    citationCount: work.cited_by_count,
    openAccessUrl,
    url,
  };
}

async function fetchFromOpenAlex(query: string, limit: number): Promise<PaperResult[]> {
  const url = new URL("https://api.openalex.org/works");
  // Use the dedicated full-text search filter on title+abstract for higher precision
  // than the default `search` param (which also matches body text and is much noisier).
  // Strip OpenAlex filter delimiters (`,` `:` `|`) and surrounding quotes from the user
  // query so they can't break the filter grammar.
  const safeQuery = query.replace(/["',:|]+/g, " ").replace(/\s+/g, " ").trim();
  url.searchParams.set("filter", "title_and_abstract.search:" + safeQuery + ",is_paratext:false,has_abstract:true");
  url.searchParams.set("per-page", String(Math.min(limit, 50)));
  // Sort by OpenAlex relevance score (best for short / ambiguous queries).
  url.searchParams.set("sort", "relevance_score:desc");
  url.searchParams.set("select", SELECT_FIELDS);
  url.searchParams.set("mailto", "research@researchmodelbuilder.app");

  const response = await fetch(url.toString(), { headers: OPENALEX_HEADERS });
  if (!response.ok) throw new Error(`OpenAlex API error: ${response.status}`);

  const data = (await response.json()) as { results: OpenAlexWork[] };
  return (data.results ?? []).map(workToPaper);
}

/**
 * Parse a free-form identifier into an OpenAlex API URL.
 * Supports: bare DOI, doi.org URL, OpenAlex W-id or URL, arXiv id, openalex.org URL.
 */
function buildLookupUrl(identifier: string): string | null {
  const raw = identifier.trim();
  if (!raw) return null;

  // OpenAlex W ID (e.g. W2741809807) or full URL
  const wMatch = raw.match(/W\d{5,}/i);
  if (wMatch && (raw.includes("openalex.org") || /^W\d+$/i.test(raw))) {
    return `https://api.openalex.org/works/${wMatch[0].toUpperCase()}`;
  }

  // DOI: bare (10.xxxx/yyyy) or full URL (https://doi.org/...)
  // Stop at whitespace, quotes, query-string markers, or HTML/markdown wrappers.
  const doiMatch = raw.match(/10\.\d{4,9}\/[^\s"'<>?#)\]]+/);
  if (doiMatch) {
    const doi = doiMatch[0].replace(/[.,;:)\]]+$/, "");
    return `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`;
  }

  // arXiv: arxiv:1706.03762, arxiv.org/abs/1706.03762, optional vN suffix.
  // Modern numeric IDs (YYMM.NNNNN) — indexed in OpenAlex via 10.48550/arXiv.<id>.
  const arxivModern = raw.match(/arxiv(?:\.org\/(?:abs|pdf))?[:/](\d{4}\.\d{4,5})(v\d+)?/i);
  if (arxivModern) {
    return `https://api.openalex.org/works/doi:${encodeURIComponent("10.48550/arXiv." + arxivModern[1])}`;
  }
  // Legacy arXiv IDs (e.g. cs/0501001).
  const arxivLegacy = raw.match(/arxiv(?:\.org\/(?:abs|pdf))?[:/]([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  if (arxivLegacy) {
    return `https://api.openalex.org/works/doi:${encodeURIComponent("10.48550/arXiv." + arxivLegacy[1])}`;
  }

  return null;
}

async function lookupOnOpenAlex(identifier: string): Promise<PaperResult | null> {
  const lookupUrl = buildLookupUrl(identifier);
  if (!lookupUrl) return null;

  const url = new URL(lookupUrl);
  url.searchParams.set("select", SELECT_FIELDS);
  url.searchParams.set("mailto", "research@researchmodelbuilder.app");

  const response = await fetch(url.toString(), { headers: OPENALEX_HEADERS });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenAlex lookup error: ${response.status}`);

  const work = (await response.json()) as OpenAlexWork;
  return workToPaper(work);
}

function formatPaper(paper: typeof papersTable.$inferSelect) {
  return {
    ...paper,
    extracted: paper.extracted === "true",
    createdAt: paper.createdAt.toISOString(),
  };
}

router.post("/papers/search", async (req, res): Promise<void> => {
  const parsed = SearchPapersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { query, limit = 20 } = parsed.data;
  const cacheKey = getCacheKey(query, limit);

  // Return cached results if fresh
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    req.log.info({ cacheKey }, "Returning cached search results");
    res.json(cached.results);
    return;
  }

  try {
    const results = await fetchFromOpenAlex(query, limit);
    searchCache.set(cacheKey, { results, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json(results);
  } catch (err) {
    req.log.error({ err }, "Error fetching papers from OpenAlex");
    res.status(502).json({ error: "Failed to search papers. Please try again." });
  }
});

router.post("/papers/lookup", async (req, res): Promise<void> => {
  const parsed = LookupPaperBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = await lookupOnOpenAlex(parsed.data.identifier);
    if (!result) {
      res.status(404).json({
        error:
          "Could not find this paper. Please paste a valid DOI (e.g. 10.1234/abcd), an OpenAlex/arXiv ID, or a doi.org URL.",
      });
      return;
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error looking up paper");
    res.status(502).json({ error: "Failed to look up paper. Please try again." });
  }
});

router.get("/sessions/:id/papers", async (req, res): Promise<void> => {
  const params = ListSessionPapersParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const papers = await db
    .select()
    .from(papersTable)
    .where(eq(papersTable.sessionId, params.data.id))
    .orderBy(papersTable.createdAt);

  res.json(papers.map(formatPaper));
});

router.post("/sessions/:id/papers", async (req, res): Promise<void> => {
  const params = AddPaperToSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = AddPaperToSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, params.data.id));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const existing = await db
    .select()
    .from(papersTable)
    .where(and(eq(papersTable.sessionId, params.data.id), eq(papersTable.externalId, parsed.data.externalId)));

  if (existing.length > 0) {
    res.status(201).json(formatPaper(existing[0]));
    return;
  }

  const [paper] = await db
    .insert(papersTable)
    .values({
      sessionId: params.data.id,
      externalId: parsed.data.externalId,
      title: parsed.data.title,
      abstract: parsed.data.abstract ?? null,
      authors: parsed.data.authors,
      year: parsed.data.year ?? null,
      venue: parsed.data.venue ?? null,
      citationCount: parsed.data.citationCount ?? null,
      openAccessUrl: parsed.data.openAccessUrl ?? null,
      url: parsed.data.url,
      extracted: "false",
    })
    .returning();

  res.status(201).json(formatPaper(paper));
});

router.delete("/sessions/:sessionId/papers/:paperId", async (req, res): Promise<void> => {
  const params = RemovePaperFromSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [paper] = await db
    .delete(papersTable)
    .where(and(eq(papersTable.sessionId, params.data.sessionId), eq(papersTable.id, params.data.paperId)))
    .returning();

  if (!paper) {
    res.status(404).json({ error: "Paper not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;

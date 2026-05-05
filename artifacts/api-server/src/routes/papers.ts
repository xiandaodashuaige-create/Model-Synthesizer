import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, papersTable, sessionsTable } from "@workspace/db";
import {
  SearchPapersBody,
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

async function fetchFromOpenAlex(query: string, limit: number): Promise<Array<{
  externalId: string; title: string; abstract: string | null;
  authors: string[]; year: number | null; venue: string | null;
  citationCount: number | null; openAccessUrl: string | null; url: string;
}>> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(Math.min(limit, 50)));
  url.searchParams.set("sort", "cited_by_count:desc");
  url.searchParams.set("select", "id,title,authorships,publication_year,cited_by_count,primary_location,abstract_inverted_index");
  url.searchParams.set("mailto", "research@researchmodelbuilder.app");

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "ResearchModelBuilder/1.0 (mailto:research@researchmodelbuilder.app)" },
  });

  if (!response.ok) {
    throw new Error(`OpenAlex API error: ${response.status}`);
  }

  const data = await response.json() as { results: OpenAlexWork[] };

  return (data.results ?? []).map((work) => {
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
  });
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

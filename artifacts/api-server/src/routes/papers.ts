import { Router, type IRouter } from "express";
import { createRequire } from "node:module";
import multer from "multer";
import { eq, and } from "drizzle-orm";
import { db, papersTable, sessionsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";

// pdf-parse v2 ships an ESM-native class API (`PDFParse`); load lazily via
// createRequire so it is only initialised on first upload, not at boot time.
const require = createRequire(import.meta.url);
type PdfParseCtor = new (opts: { data: Buffer | Uint8Array }) => {
  getText: () => Promise<{ text: string; total: number }>;
};
let PDFParseClass: PdfParseCtor | null = null;
function getPdfParser(): PdfParseCtor {
  if (PDFParseClass) return PDFParseClass;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("pdf-parse") as { PDFParse?: PdfParseCtor };
  if (!mod.PDFParse) throw new Error("pdf-parse did not export PDFParse class");
  PDFParseClass = mod.PDFParse;
  return PDFParseClass;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});
import {
  SearchPapersBody,
  LookupPaperBody,
  BulkImportPapersBody,
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

class RateLimitedError extends Error {
  constructor() { super("OpenAlex rate-limited (429)"); }
}

async function lookupOnOpenAlex(identifier: string): Promise<PaperResult | null> {
  const lookupUrl = buildLookupUrl(identifier);
  if (!lookupUrl) return null;

  const url = new URL(lookupUrl);
  url.searchParams.set("select", SELECT_FIELDS);
  url.searchParams.set("mailto", "research@researchmodelbuilder.app");

  const response = await fetch(url.toString(), { headers: OPENALEX_HEADERS });
  if (response.status === 404) return null;
  if (response.status === 429) throw new RateLimitedError();
  if (!response.ok) throw new Error(`OpenAlex lookup error: ${response.status}`);

  const work = (await response.json()) as OpenAlexWork;
  return workToPaper(work);
}

/**
 * Query Unpaywall for a legal open-access PDF URL given a DOI.
 * Returns null if no DOI, no record, or no OA copy is available.
 * Unpaywall is a free, legitimate index of OA versions authorized by publishers.
 */
async function fetchUnpaywallOaUrl(externalIdOrDoi: string): Promise<string | null> {
  // Accept either a bare DOI or an OpenAlex W-id from which we can't extract a DOI; bail in the latter case.
  const doiMatch = externalIdOrDoi.match(/10\.\d{4,9}\/[^\s"'<>?#)\]]+/);
  if (!doiMatch) return null;
  const doi = doiMatch[0].replace(/[.,;:)\]]+$/, "");

  try {
    const resp = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=research@researchmodelbuilder.app`,
      { headers: { "User-Agent": OPENALEX_HEADERS["User-Agent"] } },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      best_oa_location?: { url_for_pdf?: string | null; url?: string | null } | null;
    };
    return data.best_oa_location?.url_for_pdf ?? data.best_oa_location?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Enrich a PaperResult with a legal OA PDF URL from Unpaywall when openAccessUrl is missing.
 * Best-effort: failures are silently ignored.
 */
async function enrichWithUnpaywall(paper: PaperResult): Promise<PaperResult> {
  if (paper.openAccessUrl) return paper;
  // Try the OpenAlex landing-page URL first (often a doi.org URL), then externalId.
  const candidates = [paper.url, paper.externalId];
  for (const c of candidates) {
    const oa = await fetchUnpaywallOaUrl(c);
    if (oa) return { ...paper, openAccessUrl: oa };
  }
  return paper;
}

/**
 * Extract DOIs from raw BibTeX or RIS file content.
 * - BibTeX: `doi = {10.xxxx/yyyy}` or `doi = "..."`
 * - RIS: `DO  - 10.xxxx/yyyy` or `DI  - ...`
 * - Also catches plain DOIs / doi.org URLs anywhere in the text as a fallback.
 * Returns deduplicated DOIs in original order.
 */
function extractDoisFromCitations(content: string): string[] {
  const dois = new Set<string>();
  const ordered: string[] = [];
  const push = (raw: string) => {
    const cleaned = raw.replace(/[.,;:)\]}>"']+$/, "").toLowerCase();
    if (!dois.has(cleaned)) {
      dois.add(cleaned);
      ordered.push(cleaned);
    }
  };

  // BibTeX / RIS field patterns
  const fieldPatterns = [
    /doi\s*=\s*[{"]\s*(10\.\d{4,9}\/[^\s"}{]+)\s*[}"]/gi, // BibTeX
    /^(?:DO|DI|M3)\s+-\s+(10\.\d{4,9}\/[^\s]+)/gim, // RIS / EndNote
  ];
  for (const re of fieldPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) push(m[1]);
  }

  // Catch-all: any DOI-shaped substring
  const plain = /10\.\d{4,9}\/[^\s"'<>?#)\]}]+/g;
  let m: RegExpExecArray | null;
  while ((m = plain.exec(content)) !== null) push(m[0]);

  return ordered;
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
    const enriched = await enrichWithUnpaywall(result);
    res.json(enriched);
  } catch (err) {
    req.log.error({ err }, "Error looking up paper");
    res.status(502).json({ error: "Failed to look up paper. Please try again." });
  }
});

router.post("/sessions/:id/papers/bulk-import", async (req, res): Promise<void> => {
  const params = ListSessionPapersParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = BulkImportPapersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Hard cap the payload size to bound regex CPU even if a client bypasses the UI 5MB limit.
  const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
  if (parsed.data.content.length > MAX_CONTENT_BYTES) {
    res.status(413).json({ error: "Bulk import content exceeds 5MB limit" });
    return;
  }

  const sessionId = params.data.id;
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const dois = extractDoisFromCitations(parsed.data.content);
  if (dois.length === 0) {
    res.json({
      importedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      totalDois: 0,
      failures: [],
    });
    return;
  }

  // Cap to a reasonable batch size to avoid hammering OpenAlex / blowing request time.
  const MAX_BATCH = 50;
  const limited = dois.slice(0, MAX_BATCH);

  const existing = await db
    .select({ externalId: papersTable.externalId })
    .from(papersTable)
    .where(eq(papersTable.sessionId, sessionId));
  const existingIds = new Set(existing.map((e) => e.externalId));

  let importedCount = 0;
  let skippedCount = 0;
  const failures: Array<{ identifier: string; reason: string }> = [];
  let rateLimited = false;

  // Process in small parallel batches to stay well under OpenAlex's 10 req/s polite-pool limit
  // while keeping total wall-clock time within typical proxy timeouts (~30s).
  const CONCURRENCY = 4;
  for (let i = 0; i < limited.length && !rateLimited; i += CONCURRENCY) {
    const slice = limited.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (doi) => {
        try {
          const paper = await lookupOnOpenAlex(doi);
          if (!paper) return { kind: "notfound" as const, doi };
          const enriched = await enrichWithUnpaywall(paper);
          return { kind: "ok" as const, doi, paper: enriched };
        } catch (err) {
          if (err instanceof RateLimitedError) return { kind: "ratelimited" as const, doi };
          req.log.warn({ err, doi }, "Bulk import: failed for one DOI");
          return { kind: "error" as const, doi };
        }
      }),
    );

    for (const r of results) {
      if (r.kind === "ratelimited") {
        rateLimited = true;
        failures.push({ identifier: r.doi, reason: "Rate limited by OpenAlex; remaining DOIs were skipped" });
        continue;
      }
      if (r.kind === "notfound") {
        failures.push({ identifier: r.doi, reason: "Not found in OpenAlex" });
        continue;
      }
      if (r.kind === "error") {
        failures.push({ identifier: r.doi, reason: "Lookup failed" });
        continue;
      }
      const p = r.paper;
      if (existingIds.has(p.externalId)) {
        skippedCount++;
        continue;
      }
      try {
        await db.insert(papersTable).values({
          sessionId,
          externalId: p.externalId,
          title: p.title,
          abstract: p.abstract ?? null,
          authors: p.authors,
          year: p.year ?? null,
          venue: p.venue ?? null,
          citationCount: p.citationCount ?? null,
          openAccessUrl: p.openAccessUrl ?? null,
          url: p.url,
          extracted: "false",
        });
        existingIds.add(p.externalId);
        importedCount++;
      } catch (err) {
        req.log.warn({ err, doi: r.doi }, "Bulk import: DB insert failed");
        failures.push({ identifier: r.doi, reason: "Database insert failed" });
      }
    }
  }

  res.json({
    importedCount,
    skippedCount,
    failedCount: failures.length,
    totalDois: dois.length,
    failures,
  });
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

/**
 * Upload a PDF: extract text, find a DOI in the first ~3 pages,
 * if found use OpenAlex; otherwise ask the LLM to extract metadata
 * from the first chunk of text. The full text is stored on the paper
 * row so variable extraction can use it instead of just the abstract.
 */
router.post(
  "/sessions/:id/papers/upload-pdf",
  upload.single("file"),
  async (req, res): Promise<void> => {
    const params = ListSessionPapersParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
      return;
    }

    const sessionId = params.data.id;
    const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    let parsed: { text: string; total: number };
    try {
      const PDFParse = getPdfParser();
      const parser = new PDFParse({ data: req.file.buffer });
      parsed = await parser.getText();
    } catch (err) {
      req.log.warn({ err }, "PDF parse failed");
      res.status(400).json({ error: "Could not read this PDF. Make sure it's a real PDF (not scanned images)." });
      return;
    }
    const fullText = parsed.text.trim();
    if (fullText.length < 200) {
      res.status(400).json({
        error:
          "The PDF contains almost no extractable text (often the case for scanned documents). Please use a text-based PDF, or paste the DOI manually.",
      });
      return;
    }

    // Look for a DOI in the first ~6000 characters (≈ first 2 pages).
    const head = fullText.slice(0, 6000);
    const doiMatch = head.match(/10\.\d{4,9}\/[^\s"'<>?#)\]]+/);
    let metadata: PaperResult | null = null;

    if (doiMatch) {
      const doi = doiMatch[0].replace(/[.,;:)\]]+$/, "");
      try {
        metadata = await lookupOnOpenAlex(doi);
        if (metadata) metadata = await enrichWithUnpaywall(metadata);
      } catch (err) {
        req.log.warn({ err, doi }, "OpenAlex lookup from PDF DOI failed");
      }
    }

    // Fall back to AI metadata extraction from the first chunk of text.
    if (!metadata) {
      try {
        const aiPrompt = `Extract bibliographic metadata from this academic paper's first page. Return JSON only:
{"title": "...", "authors": ["First Last", "..."], "year": 2023, "venue": "Journal Name or Conference", "abstract": "..."}

If a field is unknown, use null. Authors should be an array of strings. Year is a number.

First page text:
${head}`;
        const completion = await openai.chat.completions.create({
          model: "gpt-5.4",
          max_completion_tokens: 800,
          messages: [{ role: "user", content: aiPrompt }],
        });
        const content = completion.choices[0]?.message?.content ?? "{}";
        const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const aiMeta = JSON.parse(cleaned) as {
          title?: string | null; authors?: string[] | null; year?: number | null;
          venue?: string | null; abstract?: string | null;
        };
        if (!aiMeta.title) {
          res.status(422).json({ error: "Could not extract a title from this PDF. Please paste the DOI manually." });
          return;
        }
        metadata = {
          externalId: `upload:${Date.now()}:${(req.file.originalname || "pdf").slice(0, 40)}`,
          title: aiMeta.title,
          authors: Array.isArray(aiMeta.authors) ? aiMeta.authors.filter((s) => typeof s === "string") : [],
          year: typeof aiMeta.year === "number" ? aiMeta.year : null,
          venue: aiMeta.venue ?? null,
          citationCount: null,
          abstract: aiMeta.abstract ?? null,
          openAccessUrl: null,
          url: `pdf-upload://${(req.file.originalname || "uploaded.pdf").slice(0, 100)}`,
        };
      } catch (err) {
        req.log.error({ err }, "AI metadata extraction failed");
        res.status(502).json({ error: "Failed to extract metadata from this PDF. Please paste the DOI manually." });
        return;
      }
    }

    // Dedupe: if a paper with this externalId already exists in the session, just update full text.
    const existing = await db
      .select()
      .from(papersTable)
      .where(and(eq(papersTable.sessionId, sessionId), eq(papersTable.externalId, metadata.externalId)));

    // Cap stored full text to keep DB rows bounded (≈ 80k chars / ~20k tokens worth of context).
    const storedFullText = fullText.slice(0, 80000);

    if (existing.length > 0) {
      const [updated] = await db
        .update(papersTable)
        .set({ fullText: storedFullText, openAccessUrl: metadata.openAccessUrl ?? existing[0].openAccessUrl })
        .where(eq(papersTable.id, existing[0].id))
        .returning();
      res.status(200).json({ ...formatPaper(updated), fullTextChars: storedFullText.length, alreadyExisted: true });
      return;
    }

    const [paper] = await db
      .insert(papersTable)
      .values({
        sessionId,
        externalId: metadata.externalId,
        title: metadata.title,
        abstract: metadata.abstract ?? null,
        authors: metadata.authors,
        year: metadata.year ?? null,
        venue: metadata.venue ?? null,
        citationCount: metadata.citationCount ?? null,
        openAccessUrl: metadata.openAccessUrl ?? null,
        url: metadata.url,
        fullText: storedFullText,
        extracted: "false",
      })
      .returning();

    res.status(201).json({ ...formatPaper(paper), fullTextChars: storedFullText.length, alreadyExisted: false });
  },
);

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

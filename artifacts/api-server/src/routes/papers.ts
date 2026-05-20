import { Router, type IRouter } from "express";
import { createRequire } from "node:module";
import multer from "multer";
import { eq, and, sql } from "drizzle-orm";
import { db, papersTable, sessionsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logAiUsageFromOpenAI } from "../lib/ai-usage";

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
  AddExternalPaperParams,
  AddExternalPaperBody,
  IndustrySearchPapersParams,
  IndustrySearchPapersBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Simple in-memory search cache (TTL: 15 minutes)
// Relevance pool cache: keyed by (query, page) ONLY — NOT by sort or limit.
// Every search now fetches the same top-50 relevance-sorted pool, then resorts
// in memory for the user's chosen sort. That means switching the 排序 tabs
// (相关度 / 最新发表 / 高引用) never re-hits OpenAlex, eliminating the 429-rate-
// limit failures users were seeing as "搜索失败 / 无法连接学术资料库" toasts
// when toggling sort tabs quickly.
const searchCache = new Map<string, { pool: PaperResult[]; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;
// Always pull a generous relevance pool so in-memory resort by year /
// citations stays inside the topic. 50 is OpenAlex's per-page max.
const RELEVANCE_POOL_SIZE = 50;

function getPoolCacheKey(query: string, page: number) {
  return `${query.toLowerCase().trim()}::p${page}`;
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

// Network failure from OpenAlex (timeout, DNS, 5xx, 429). Carries a stable
// `code` so the route handler can map it to the right HTTP status + message.
class OpenAlexError extends Error {
  code: "timeout" | "rate_limited" | "upstream" | "network";
  status?: number;
  constructor(code: OpenAlexError["code"], message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Single fetch attempt with a hard 15s timeout via AbortController.
async function fetchOpenAlexOnce(url: string): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { headers: OPENALEX_HEADERS, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new OpenAlexError("timeout", "OpenAlex request timed out after 15s");
    }
    throw new OpenAlexError("network", `Network error reaching OpenAlex: ${(err as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

// Wraps fetchOpenAlexOnce with one retry on transient failures (timeout, 5xx,
// network). 429 (rate-limited) is NOT retried — the cooldown would exceed our
// budget and we want to surface it cleanly to the user.
async function fetchOpenAlexWithRetry(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchOpenAlexOnce(url);
      if (r.status === 429) throw new OpenAlexError("rate_limited", "OpenAlex rate-limited", 429);
      if (r.status >= 500) throw new OpenAlexError("upstream", `OpenAlex returned ${r.status}`, r.status);
      return r;
    } catch (err) {
      const isLastAttempt = attempt === 1;
      const isRetryable =
        err instanceof OpenAlexError && (err.code === "timeout" || err.code === "upstream" || err.code === "network");
      if (isLastAttempt || !isRetryable) throw err;
      await new Promise((res) => setTimeout(res, 800));
    }
  }
  // Unreachable; the loop either returns or throws.
  throw new OpenAlexError("network", "Unreachable");
}

type SortMode = "relevance" | "year" | "citations";

// Fetch the relevance-sorted pool of up to 50 results for (query, page).
// Always sorted by relevance_score:desc so the pool stays topically focused;
// the caller resorts in memory for year / citations modes. This is the ONLY
// function that hits OpenAlex for the search route.
//
// Why pool-by-relevance instead of sort-at-API-side: a query like
// "AI broadcast" matches tens of thousands of works (OpenAlex tokenizes and
// stems, so "AI" alone matches almost any modern paper). When the user picks
// 最新发表 (sort=publication_year:desc), the API returns the NEWEST among the
// entire matching set — typically completely off-topic papers that happen to
// mention "AI" or "broadcast" (e.g. "Real Time Collaborative Code Editor"
// from 2026). 高引用 has the same failure mode (e.g. a 2010 social-media paper
// with 579 citations). Oversampling by relevance and resorting client-side
// keeps the universe topically constrained while still honoring the user's
// "I want recent" / "I want cited" preference.
async function fetchRelevancePool(query: string, page: number): Promise<PaperResult[]> {
  const url = new URL("https://api.openalex.org/works");
  // title_and_abstract.search performs AND across whitespace-separated terms
  // (stop words removed, basic stemming). We strip OpenAlex filter delimiters
  // (`,` `:` `|`) and quotes so they can't break the filter grammar.
  const safeQuery = query.replace(/["',:|]+/g, " ").replace(/\s+/g, " ").trim();
  url.searchParams.set("filter", "title_and_abstract.search:" + safeQuery + ",is_paratext:false,has_abstract:true");
  url.searchParams.set("per-page", String(RELEVANCE_POOL_SIZE));
  url.searchParams.set("page", String(Math.max(1, Math.floor(page))));
  url.searchParams.set("sort", "relevance_score:desc");
  url.searchParams.set("select", SELECT_FIELDS);
  url.searchParams.set("mailto", "research@researchmodelbuilder.app");

  const response = await fetchOpenAlexWithRetry(url.toString());
  const data = (await response.json()) as { results: OpenAlexWork[] };
  return (data.results ?? []).map(workToPaper);
}

// In-memory resort. Stable sort: when two papers tie on the chosen criterion
// we preserve OpenAlex's relevance order so the more-relevant paper wins —
// e.g. two papers both from 2024 keep the higher-relevance one on top.
function resortPool(pool: PaperResult[], sort: SortMode): PaperResult[] {
  if (sort === "relevance") return pool;
  // Decorate-sort-undecorate to preserve original index for stable ordering.
  const indexed = pool.map((p, i) => ({ p, i }));
  if (sort === "year") {
    indexed.sort((a, b) => {
      const ya = a.p.year ?? -Infinity;
      const yb = b.p.year ?? -Infinity;
      if (yb !== ya) return yb - ya;
      return a.i - b.i;
    });
  } else {
    indexed.sort((a, b) => {
      const ca = a.p.citationCount ?? -Infinity;
      const cb = b.p.citationCount ?? -Infinity;
      if (cb !== ca) return cb - ca;
      return a.i - b.i;
    });
  }
  return indexed.map((x) => x.p);
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

// Backwards-compat alias: legacy call sites (e.g. bulk-import) check for
// `RateLimitedError`; OpenAlexError with code "rate_limited" satisfies the same
// contract via `instanceof` since RateLimitedError now refers to OpenAlexError.
const RateLimitedError = OpenAlexError;

async function lookupOnOpenAlex(identifier: string): Promise<PaperResult | null> {
  const lookupUrl = buildLookupUrl(identifier);
  if (!lookupUrl) return null;

  const url = new URL(lookupUrl);
  url.searchParams.set("select", SELECT_FIELDS);
  url.searchParams.set("mailto", "research@researchmodelbuilder.app");

  // Single attempt with timeout — DOI lookup needs to detect 404 cleanly,
  // and the bulk-import loop already iterates many DOIs so retrying each one
  // would multiply the wall-clock unacceptably. The 15s timeout still bounds
  // hangs; transient 5xx surfaces as `upstream` for the caller to handle.
  const response = await fetchOpenAlexOnce(url.toString());
  if (response.status === 404) return null;
  if (response.status === 429) throw new OpenAlexError("rate_limited", "OpenAlex rate-limited", 429);
  if (response.status >= 500) {
    throw new OpenAlexError("upstream", `OpenAlex returned ${response.status}`, response.status);
  }

  const work = (await response.json()) as OpenAlexWork;
  return workToPaper(work);
}

// Map an OpenAlexError to an HTTP status + Chinese error body (shared by
// /papers/search and /papers/lookup so users get the same vocabulary).
function openAlexErrorResponse(err: OpenAlexError): { status: number; body: { error: string; code: string } } {
  const map = {
    timeout: { status: 504, msg: "学术数据库响应超时，请稍后再试。" },
    rate_limited: { status: 429, msg: "学术数据库当前限流，请等几秒后再试。" },
    upstream: { status: 502, msg: `学术数据库暂时不可用 (${err.status ?? "5xx"})，请稍后再试。` },
    network: { status: 502, msg: "无法连接学术数据库，请检查网络后重试。" },
  } as const;
  const m = map[err.code];
  return { status: m.status, body: { error: m.msg, code: err.code } };
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
    relevanceSkipped: paper.extracted === "skipped",
    createdAt: paper.createdAt.toISOString(),
  };
}

router.post("/papers/search", async (req, res): Promise<void> => {
  const parsed = SearchPapersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { query, limit: rawLimit = 20, sort = "relevance", page: rawPage = 1 } = parsed.data;
  // Normalize BEFORE building the cache key so equivalent inputs (e.g. page=1
  // vs page=1.4) hit the same cache bucket.
  const page = Math.max(1, Math.floor(rawPage));
  const limit = Math.max(1, Math.min(50, Math.floor(rawLimit)));
  const poolKey = getPoolCacheKey(query, page);

  // Try cached pool first. Sort tab toggles always hit this path (we never
  // re-fetch from OpenAlex for a sort change), which is the whole point of
  // pool caching.
  const cached = searchCache.get(poolKey);
  if (cached && Date.now() < cached.expiresAt) {
    req.log.info({ poolKey, sort }, "Serving search from cached relevance pool");
    res.json(resortPool(cached.pool, sort).slice(0, limit));
    return;
  }

  try {
    const pool = await fetchRelevancePool(query, page);
    searchCache.set(poolKey, { pool, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json(resortPool(pool, sort).slice(0, limit));
  } catch (err) {
    req.log.error({ err }, "Error fetching papers from OpenAlex");
    if (err instanceof OpenAlexError) {
      const { status, body } = openAlexErrorResponse(err);
      res.status(status).json(body);
      return;
    }
    res.status(502).json({ error: "搜索失败，请稍后再试。", code: "unknown" });
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
    if (err instanceof OpenAlexError) {
      const { status, body } = openAlexErrorResponse(err);
      res.status(status).json(body);
      return;
    }
    res.status(502).json({ error: "查找论文失败，请稍后再试。", code: "unknown" });
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

  // Hide the per-session "[手动添加]" sentinel paper that backs manual /
  // custom variables (see routes/variables.ts MANUAL_PAPER_PREFIX). It must
  // exist as a real `papers` row so the variables FK is satisfied, but it's
  // not a real paper and the user must never see it in the papers tab.
  res.json(
    papers
      .filter((p) => !p.externalId.startsWith("manual:"))
      // Tangential papers (Phase 1 scope-check gate) are still listed —
      // the UI can show a "tangential" badge — but never counted as in-corpus.
      // The list endpoint keeps them visible so users can audit the verdict.
      .map(formatPaper),
  );
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
 * Add an external document (industry report, government file, whitepaper, etc.)
 * supplied entirely by the user — no OpenAlex lookup.
 * externalId uses the "report:" prefix so it is clearly distinguishable from
 * OpenAlex IDs (openalex:W…) and sentinel papers (manual:…).
 */
router.post("/sessions/:id/papers/external", async (req, res): Promise<void> => {
  const params = AddExternalPaperParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = AddExternalPaperBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const sessionId = params.data.id;
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const { title, sourceOrg, year, sourceType, abstract, fullText } = parsed.data;

  // Build a stable URL for external documents — a no-op placeholder that is
  // still a valid non-empty string (the url column is NOT NULL).
  const externalId = `report:${crypto.randomUUID()}`;
  const url = `report:${externalId}`;

  // authors field = [sourceOrg] when provided, else empty — keeps the
  // existing paper card rendering working without any special-casing.
  const authors: string[] = sourceOrg ? [sourceOrg] : [];

  const [paper] = await db
    .insert(papersTable)
    .values({
      sessionId,
      externalId,
      title,
      abstract: abstract ?? null,
      authors,
      year: year ?? null,
      venue: sourceOrg ?? null,
      citationCount: null,
      openAccessUrl: null,
      url,
      fullText: fullText ?? null,
      sourceType,
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
    // Postgres TEXT rejects NUL bytes; extracted PDF text frequently contains them
    // (font encoding artefacts), and a few other control chars also cause issues.
    const fullText = parsed.text
      .replace(/\u0000/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
      .trim();
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
          // Cost optimisation: parsing a fixed bibliographic-metadata schema
          // (title / authors / year / venue / abstract) from a single page of
          // text is exactly the kind of high-volume structured extraction
          // gpt-5-mini is built for.
          model: "gpt-5-mini",
          max_completion_tokens: 800,
          messages: [{ role: "user", content: aiPrompt }],
        });
        logAiUsageFromOpenAI(completion, { route: "papers/upload-pdf-metadata", sessionId: Number(req.params["id"]) || null, userId: req.user?.id ?? null });
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

    try {
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
    } catch (err) {
      req.log.error({ err, externalId: metadata.externalId, fullTextChars: storedFullText.length }, "DB insert/update for uploaded PDF failed");
      const msg = err instanceof Error ? err.message : "Database error";
      res.status(500).json({ error: `Failed to save paper: ${msg}` });
    }
  },
);

router.get("/sessions/:id/papers/full-text-search", async (req, res): Promise<void> => {
  const sessionId = Number(req.params["id"]);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const q = (typeof req.query["q"] === "string" ? req.query["q"] : "").trim();
  if (!q) {
    res.status(400).json({ error: "Missing query parameter q" });
    return;
  }

  // Split the query on whitespace; require ALL tokens to appear (AND semantics)
  // across (title || abstract || full_text). ILIKE is used for Unicode-friendly
  // matching (Postgres tsvector does not stem CJK text). Cap at 50 hits.
  const tokens = q.split(/\s+/).filter((t) => t.length > 0).slice(0, 8);
  if (tokens.length === 0) {
    res.json([]);
    return;
  }

  const conds = tokens.map((tok) => {
    const like = `%${tok.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    return sql`(${papersTable.title} ILIKE ${like} OR coalesce(${papersTable.abstract},'') ILIKE ${like} OR coalesce(${papersTable.fullText},'') ILIKE ${like})`;
  });
  const combined = conds.reduce((acc, c) => sql`${acc} AND ${c}`);
  const rows = await db
    .select({
      id: papersTable.id,
      title: papersTable.title,
      authors: papersTable.authors,
      year: papersTable.year,
      abstract: papersTable.abstract,
      fullText: papersTable.fullText,
    })
    .from(papersTable)
    .where(sql`${papersTable.sessionId} = ${sessionId} AND ${combined}`)
    .limit(50);

  // Build a snippet around the first matching token in title/abstract/fullText.
  const lowerTokens = tokens.map((t) => t.toLowerCase());
  function snippetOf(text: string): string {
    const lower = text.toLowerCase();
    let pos = -1;
    let matched = "";
    for (const tok of lowerTokens) {
      const i = lower.indexOf(tok);
      if (i >= 0 && (pos < 0 || i < pos)) { pos = i; matched = tok; }
    }
    if (pos < 0) return text.slice(0, 200);
    const start = Math.max(0, pos - 80);
    const end = Math.min(text.length, pos + matched.length + 120);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  }

  const hits = rows.map((r) => {
    const haystack = `${r.title}\n${r.abstract ?? ""}\n${(r.fullText ?? "").slice(0, 4000)}`;
    const lowerHay = haystack.toLowerCase();
    let rank = 0;
    for (const tok of lowerTokens) {
      let idx = 0;
      while ((idx = lowerHay.indexOf(tok, idx)) !== -1) { rank++; idx += tok.length; }
    }
    return {
      id: r.id,
      title: r.title,
      authors: r.authors ?? [],
      year: r.year ?? null,
      snippet: snippetOf((r.abstract && r.abstract.length > 50) ? r.abstract : (r.fullText ?? r.title)),
      rank,
    };
  }).sort((a, b) => b.rank - a.rank);

  res.json(hits);
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

// --- Per-paper model figure search -----------------------------------------
// Lightweight, lazy: triggered when the user expands "查看论文模型图" on an
// edge card. Single SerpAPI call (no AI gate, no expansion) keyed by paper
// title. Result is cached on the paper row so repeated views are free.

const FIGURE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STOCK_DOMAINS_FIG = ["shutterstock", "gettyimages", "istockphoto", "pinterest", "freepik", "canva.com", "alamy", "depositphotos", "stock.adobe", "dreamstime"];
const FIGURE_HINT_PAPER = /\b(framework|model|figure|fig\.|diagram|hypothes|conceptual|theoretical|construct|sem |path|moderat|mediat|antecedent|outcome)/i;

function isStockDomainFig(d: string): boolean {
  const lower = d.toLowerCase();
  return STOCK_DOMAINS_FIG.some((s) => lower.includes(s));
}

interface CachedFigure {
  title: string;
  thumbnailUrl: string;
  imageUrl?: string;
  sourceUrl: string;
  sourceDomain: string;
}

async function searchFiguresForPaperTitle(
  title: string,
  log: { warn: (o: object, m: string) => void },
): Promise<CachedFigure[]> {
  const serpKey = process.env.SERPAPI_API_KEY;
  if (!serpKey) return [];
  const isHttp = (u: string) => /^https?:\/\//i.test(u);
  // Quote the title so SerpAPI biases hard toward this exact paper.
  const trimmedTitle = title.length > 140 ? title.slice(0, 140) : title;
  const q = `"${trimmedTitle}" conceptual model OR framework figure`;
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", q);
  url.searchParams.set("num", "20");
  url.searchParams.set("api_key", serpKey);
  url.searchParams.set("safe", "active");
  url.searchParams.set("tbs", "isz:m");

  let data: any;
  try {
    const r = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!r.ok) {
      log.warn({ status: r.status, q }, "Per-paper figure search HTTP error");
      return [];
    }
    data = await r.json();
  } catch (err) {
    log.warn({ err: (err as Error).message, q }, "Per-paper figure search threw");
    return [];
  }
  if (data.error) {
    log.warn({ error: data.error, q }, "Per-paper figure search SerpAPI error");
    return [];
  }
  const items = (data.images_results ?? []) as Array<{
    title?: string; link?: string; source?: string; original?: string; thumbnail?: string;
  }>;

  const seenSrc = new Set<string>();
  const seenThumb = new Set<string>();
  const out: CachedFigure[] = [];
  for (const it of items) {
    const sourceUrl = it.link ?? "";
    const thumbnailUrl = it.thumbnail ?? "";
    if (!sourceUrl || !thumbnailUrl || !isHttp(sourceUrl) || !isHttp(thumbnailUrl)) continue;
    let domain = it.source ?? "";
    if (!domain) {
      try { domain = new URL(sourceUrl).hostname; } catch { continue; }
    }
    if (isStockDomainFig(domain)) continue;
    if (seenSrc.has(sourceUrl) || seenThumb.has(thumbnailUrl)) continue;
    // Prefer items with figure-hint title OR academic-looking domain.
    const looksFigure = FIGURE_HINT_PAPER.test(it.title ?? "") || /\b(rg|sd|sciencedirect|springer|wiley|tandfonline|emerald|sagepub|frontiersin|mdpi|ncbi|researchgate|arxiv|nature|cambridge|oup)\b/i.test(domain);
    if (!looksFigure) continue;
    seenSrc.add(sourceUrl);
    seenThumb.add(thumbnailUrl);
    out.push({
      title: (it.title ?? "").slice(0, 200),
      thumbnailUrl,
      imageUrl: it.original && isHttp(it.original) ? it.original : undefined,
      sourceUrl,
      sourceDomain: domain,
    });
    if (out.length >= 3) break;
  }
  return out;
}

router.get("/sessions/:sessionId/papers/:paperId/model-figures", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.sessionId, 10);
  const paperId = parseInt(req.params.paperId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(paperId)) {
    res.status(400).json({ error: "Invalid session or paper id" });
    return;
  }
  const refresh = String(req.query.refresh ?? "").toLowerCase() === "true";

  const [paper] = await db
    .select()
    .from(papersTable)
    .where(and(eq(papersTable.id, paperId), eq(papersTable.sessionId, sessionId)))
    .limit(1);
  if (!paper) {
    res.status(404).json({ error: "Paper not found in this session" });
    return;
  }

  const cachedAt = paper.figuresFetchedAt ? new Date(paper.figuresFetchedAt).getTime() : 0;
  const fresh = cachedAt && Date.now() - cachedAt < FIGURE_TTL_MS;
  if (!refresh && fresh && Array.isArray(paper.figureResults)) {
    res.json({
      paperId,
      cached: true,
      fetchedAt: new Date(cachedAt).toISOString(),
      results: paper.figureResults as CachedFigure[],
    });
    return;
  }

  if (!process.env.SERPAPI_API_KEY) {
    res.status(503).json({ error: "Image search is not configured (missing SERPAPI_API_KEY)" });
    return;
  }

  const results = await searchFiguresForPaperTitle(paper.title, req.log);
  const now = new Date();
  await db
    .update(papersTable)
    .set({ figureResults: results, figuresFetchedAt: now })
    .where(eq(papersTable.id, paperId));

  res.json({
    paperId,
    cached: false,
    fetchedAt: now.toISOString(),
    results,
  });
});

// ---------------------------------------------------------------------------
// Industry-source search (Task #38 — 行业资料搜索三层漏斗)
// ---------------------------------------------------------------------------

type IndustrySearchResultItem = {
  id: string;
  title: string;
  url: string;
  domain: string;
  publishDate: string | null;
  snippet: string | null;
  relevanceScore: number;
  keyVariables: string[];
  summary: string;
  bodyFetchFailed: boolean;
};

const industrySearchCache = new Map<string, { results: IndustrySearchResultItem[]; expiresAt: number }>();
const INDUSTRY_SEARCH_TTL_MS = 30 * 60 * 1000;

const SITE_RESTRICTIONS: Record<string, string> = {
  gov: "site:gov.cn OR site:mofcom.gov.cn OR site:stats.gov.cn OR site:miit.gov.cn OR site:ndrc.gov.cn OR site:nea.gov.cn",
  org: "site:*.org.cn OR site:cnnic.org.cn OR site:caict.ac.cn OR site:ccidnet.com",
  think_tank: "site:*.edu.cn OR site:drcnet.com.cn OR site:casted.org.cn OR site:amr.gov.cn",
  all: "site:gov.cn OR site:*.gov OR site:*.org.cn OR site:*.edu.cn",
};

async function fetchBodyText(url: string): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8_000);
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ResearchBot/1.0)" },
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const html = await r.text();
    // Strip HTML tags and collapse whitespace; limit to ~6000 chars (~1500 tokens)
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 6000) || null;
  } catch {
    return null;
  }
}

async function scoreWithAI(
  topic: string,
  title: string,
  bodyText: string | null,
  snippet: string | null,
  log: { warn: (obj: object, msg: string) => void },
): Promise<{ relevanceScore: number; keyVariables: string[]; summary: string }> {
  const content = bodyText || snippet || "";
  if (!content.trim()) return { relevanceScore: 0, keyVariables: [], summary: "" };

  const prompt = `You are a research assistant. Given a research topic and a document excerpt, return a JSON object with:
- "relevanceScore": integer 0-100 indicating how relevant this document is to the research topic (100 = directly relevant, 0 = irrelevant)
- "keyVariables": array of 2-3 key construct/variable names found in the document (e.g. ["用户满意度", "技术接受度"])
- "summary": 1-2 sentence summary in Chinese of how this document relates to the research topic

RESEARCH TOPIC: ${topic}

DOCUMENT TITLE: ${title}

DOCUMENT CONTENT (excerpt):
${content.slice(0, 5000)}

Return only valid JSON, no markdown.`;

  try {
    const resp = await openai.chat.completions.create(
      {
        model: "gpt-5-mini",
        max_completion_tokens: 300,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      },
      { signal: AbortSignal.timeout(15_000) },
    );
    logAiUsageFromOpenAI(resp, { route: "papers/industry-search-score", sessionId: null, userId: null });
    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { relevanceScore?: unknown; keyVariables?: unknown; summary?: unknown };
    return {
      relevanceScore: typeof parsed.relevanceScore === "number" ? Math.min(100, Math.max(0, Math.round(parsed.relevanceScore))) : 0,
      keyVariables: Array.isArray(parsed.keyVariables) ? (parsed.keyVariables as unknown[]).filter((v): v is string => typeof v === "string").slice(0, 3) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  } catch (err) {
    log.warn({ err, title }, "industry-search: AI scoring failed, returning defaults");
    return { relevanceScore: 0, keyVariables: [], summary: "" };
  }
}

router.post("/sessions/:id/papers/industry-search", async (req, res): Promise<void> => {
  const params = IndustrySearchPapersParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = IndustrySearchPapersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const sessionId = params.data.id;
  const [session] = await db.select({ topic: sessionsTable.topic }).from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const serpKey = process.env.SERPAPI_API_KEY;
  if (!serpKey) {
    res.status(503).json({ error: "行业搜索未配置（缺少 SERPAPI_API_KEY）" });
    return;
  }

  const { query, sourceFilter = "all" } = parsed.data;
  const cacheKey = `industrySearch:${sessionId}:${query.trim().toLowerCase()}:${sourceFilter}`;
  const cached = industrySearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.json({ results: cached.results, cached: true });
    return;
  }

  // Call SerpAPI (google engine) with site restrictions
  const siteRestriction = SITE_RESTRICTIONS[sourceFilter] ?? SITE_RESTRICTIONS.all;
  const serpQuery = `${query.trim()} (${siteRestriction})`;
  const serpUrl = new URL("https://serpapi.com/search.json");
  serpUrl.searchParams.set("engine", "google");
  serpUrl.searchParams.set("q", serpQuery);
  serpUrl.searchParams.set("num", "8");
  serpUrl.searchParams.set("hl", "zh-cn");
  serpUrl.searchParams.set("gl", "cn");
  serpUrl.searchParams.set("api_key", serpKey);

  let organicResults: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    date?: string;
    displayed_link?: string;
  }> = [];

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    const r = await fetch(serpUrl.toString(), { headers: { Accept: "application/json" }, signal: ctl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const data = await r.json() as { organic_results?: typeof organicResults; error?: string };
      if (!data.error) organicResults = data.organic_results ?? [];
    }
  } catch (err) {
    req.log.warn({ err }, "industry-search: SerpAPI call failed");
  }

  // Fetch body text and score in parallel (max 4 concurrent)
  const CONCURRENCY = 4;
  const results: IndustrySearchResultItem[] = [];
  const topic = session.topic ?? query;

  for (let i = 0; i < organicResults.length; i += CONCURRENCY) {
    const batch = organicResults.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (hit) => {
        if (!hit.title || !hit.link) return null;
        const url = hit.link;
        let domain = "";
        try { domain = new URL(url).hostname; } catch { domain = url.slice(0, 50); }

        const bodyText = await fetchBodyText(url);
        const scored = await scoreWithAI(topic, hit.title, bodyText, hit.snippet ?? null, req.log);

        const id = Buffer.from(url).toString("base64url").slice(0, 32);
        return {
          id,
          title: hit.title,
          url,
          domain,
          publishDate: hit.date ?? null,
          snippet: hit.snippet ?? null,
          relevanceScore: scored.relevanceScore,
          keyVariables: scored.keyVariables,
          summary: scored.summary,
          bodyFetchFailed: bodyText === null,
        } satisfies IndustrySearchResultItem;
      }),
    );
    for (const r of batchResults) if (r) results.push(r);
  }

  // Sort by relevance descending
  results.sort((a, b) => b.relevanceScore - a.relevanceScore);

  industrySearchCache.set(cacheKey, { results, expiresAt: Date.now() + INDUSTRY_SEARCH_TTL_MS });
  res.json({ results, cached: false });
});

export default router;

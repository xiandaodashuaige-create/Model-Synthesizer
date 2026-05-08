// AI-powered evidence matcher.
// Given a research model (set of edges) and a session, find papers — from the
// session library and/or the open web (OpenAlex) — that support each edge,
// returning a relevance score, a short rationale, and (per-edge) a verbatim
// evidence quote pulled from the abstract.
//
// Used by both the candidate-model and live-model evidence-search endpoints.

import { eq, and, sql } from "drizzle-orm";
import { db, papersTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";

export type EdgeInput = {
  edgeKey: string;
  fromVariableId: number;
  toVariableId: number;
  fromVariableName: string;
  toVariableName: string;
  relationship: string;
};

export type PaperHit = {
  source: "library" | "web" | "scholar";
  paperId?: number | null;
  externalId?: string | null;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  url: string | null;
  score: number;
  rationale: string;
  evidenceQuote?: string | null;
};

export type ImageHit = {
  title: string | null;
  thumbnailUrl: string;
  imageUrl: string | null;
  sourceUrl: string;
  sourceDomain: string;
};

export type EdgeMatch = {
  edgeKey: string;
  fromVariableId: number;
  toVariableId: number;
  fromVariableName: string;
  toVariableName: string;
  relationship: string;
  hits: PaperHit[];
  imageHits?: ImageHit[];
};

export type SearchOptions = {
  scopes: Array<"library" | "web" | "scholar">;
  granularity: Array<"overall" | "per-edge">;
  instructions?: string | null;
  // When set, restrict the search to ONLY this edgeKey. Other edges in the
  // model are dropped before any web/scholar fetch or AI scoring runs.
  // Overall granularity is suppressed in this mode (it makes no sense for a
  // single edge). Defaults: focused mode also auto-enables image search.
  focusEdgeKey?: string | null;
  includeImages?: boolean | null;
};

const MODEL = "gpt-5-mini";
const ABSTRACT_TRUNC = 800;
const LIBRARY_CAP = 30;
const WEB_PER_EDGE = 5;
const TOP_HITS_PER_EDGE = 3;
const TOP_OVERALL = 8;

const OPENALEX_HEADERS = {
  "User-Agent": "ResearchModelBuilder/1.0 (mailto:research@researchmodelbuilder.app)",
};
const OPENALEX_SELECT =
  "id,title,authorships,publication_year,primary_location,abstract_inverted_index";

type OpenAlexWork = {
  id: string;
  title: string;
  authorships: Array<{ author: { display_name: string } }>;
  publication_year: number | null;
  primary_location: { landing_page_url?: string } | null;
  abstract_inverted_index: Record<string, number[]> | null;
};

function reconstructAbstract(idx: Record<string, number[]> | null | undefined): string | null {
  if (!idx || Object.keys(idx).length === 0) return null;
  const positions: Array<[number, string]> = [];
  for (const [w, ps] of Object.entries(idx)) for (const p of ps) positions.push([p, w]);
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ");
}

function trunc(s: string | null, n = ABSTRACT_TRUNC): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const RELATION_NL: Record<string, string> = {
  positive: "positively predicts / increases",
  negative: "negatively predicts / decreases",
  mediates: "mediates the effect on",
  moderates: "moderates the relationship with",
};

function edgeAsQuery(e: EdgeInput): string {
  const verb = e.relationship === "moderates" ? "moderates" : e.relationship === "mediates" ? "mediates" : "effect";
  return `${e.fromVariableName} ${verb} ${e.toVariableName}`.replace(/\s+/g, " ").trim();
}

// ---- Google Scholar via SerpAPI ------------------------------------------
// Used as an additional `web`-style scope. SerpAPI returns title / authors /
// year / publication info / snippet for top scholar results. We treat snippets
// as the abstract surrogate for downstream AI scoring.

type ScholarCandidate = {
  externalId: string; // "scholar:<result_id>" or "scholar:<hash>"
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  url: string | null;
};

async function fetchGoogleScholar(query: string, perPage: number): Promise<ScholarCandidate[]> {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return [];
  const safe = query.replace(/["',:|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!safe) return [];
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_scholar");
  url.searchParams.set("q", safe);
  url.searchParams.set("num", String(Math.min(perPage, 10)));
  url.searchParams.set("api_key", key);
  let data: {
    organic_results?: Array<{
      result_id?: string;
      title?: string;
      link?: string;
      snippet?: string;
      publication_info?: { summary?: string; authors?: Array<{ name?: string }> };
    }>;
    error?: string;
  };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    const r = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    data = await r.json();
  } catch {
    return [];
  }
  if (data.error) return [];
  const out: ScholarCandidate[] = [];
  for (const it of data.organic_results ?? []) {
    if (!it?.title || !it.link) continue;
    const id = it.result_id || `${it.link.slice(0, 80)}`;
    const summary = it.publication_info?.summary ?? "";
    // SerpAPI summary is typically "Authors - Venue, Year - Domain". Pull the
    // first 4-digit year if present, fall back to null. Authors come from the
    // structured publication_info.authors when available, else from the
    // summary head.
    const yearMatch = summary.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : null;
    const structuredAuthors = (it.publication_info?.authors ?? [])
      .map((a) => a?.name)
      .filter((n): n is string => !!n);
    const fallbackAuthors = summary ? summary.split(" - ")[0]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [] : [];
    const authors = (structuredAuthors.length > 0 ? structuredAuthors : fallbackAuthors).slice(0, 6);
    out.push({
      externalId: `scholar:${id}`,
      title: it.title,
      authors,
      year,
      abstract: it.snippet ?? null,
      url: it.link,
    });
  }
  return out;
}

// ---- Per-edge figure search via SerpAPI google_images --------------------

const STOCK_DOMAINS_IMG = ["shutterstock.", "istockphoto.", "gettyimages.", "alamy.", "dreamstime.", "depositphotos.", "stock.adobe."];

async function fetchEdgeFigures(edge: EdgeInput): Promise<ImageHit[]> {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return [];
  const verb = edge.relationship === "moderates" ? "moderating" : edge.relationship === "mediates" ? "mediating" : "effect";
  const q = `"${edge.fromVariableName}" ${verb} "${edge.toVariableName}" conceptual model OR framework figure`;
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", q);
  url.searchParams.set("num", "20");
  url.searchParams.set("api_key", key);
  url.searchParams.set("safe", "active");
  url.searchParams.set("tbs", "isz:m");
  let data: {
    error?: string;
    images_results?: Array<{ title?: string; link?: string; source?: string; original?: string; thumbnail?: string }>;
  };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    const r = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    data = await r.json();
  } catch {
    return [];
  }
  if (data.error) return [];
  const isHttp = (u: string) => /^https?:\/\//i.test(u);
  const seen = new Set<string>();
  const out: ImageHit[] = [];
  for (const it of data.images_results ?? []) {
    const sourceUrl = it.link ?? "";
    const thumb = it.thumbnail ?? "";
    if (!sourceUrl || !thumb || !isHttp(sourceUrl) || !isHttp(thumb)) continue;
    let domain = it.source ?? "";
    if (!domain) {
      try { domain = new URL(sourceUrl).hostname; } catch { continue; }
    }
    const lower = domain.toLowerCase();
    if (STOCK_DOMAINS_IMG.some((s) => lower.includes(s))) continue;
    if (seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    out.push({
      title: (it.title ?? "").slice(0, 200) || null,
      thumbnailUrl: thumb,
      imageUrl: it.original && isHttp(it.original) ? it.original : null,
      sourceUrl,
      sourceDomain: domain,
    });
    if (out.length >= 3) break;
  }
  return out;
}

async function fetchOpenAlex(query: string, perPage: number): Promise<OpenAlexWork[]> {
  const url = new URL("https://api.openalex.org/works");
  const safe = query.replace(/["',:|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!safe) return [];
  url.searchParams.set("filter", `title_and_abstract.search:${safe},is_paratext:false,has_abstract:true`);
  url.searchParams.set("per-page", String(Math.min(perPage, 25)));
  url.searchParams.set("sort", "relevance_score:desc");
  url.searchParams.set("select", OPENALEX_SELECT);
  url.searchParams.set("mailto", "research@researchmodelbuilder.app");
  const r = await fetch(url.toString(), { headers: OPENALEX_HEADERS });
  if (!r.ok) return [];
  const data = (await r.json()) as { results?: OpenAlexWork[] };
  return data.results ?? [];
}

function workToCandidate(w: OpenAlexWork): {
  externalId: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  url: string | null;
} {
  const externalId = w.id.replace("https://openalex.org/", "");
  return {
    externalId,
    title: w.title,
    authors: (w.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean) as string[],
    year: w.publication_year,
    abstract: reconstructAbstract(w.abstract_inverted_index),
    url: w.primary_location?.landing_page_url ?? `https://openalex.org/${externalId}`,
  };
}

type LibCandidate = {
  paperId: number;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  url: string | null;
};

async function loadLibraryCandidates(sessionId: number): Promise<LibCandidate[]> {
  const rows = await db
    .select()
    .from(papersTable)
    .where(
      and(
        eq(papersTable.sessionId, sessionId),
        // Exclude the per-session manual-additions sentinel paper and any
        // out-of-scope (tangential) papers — neither belongs in evidence search.
        sql`${papersTable.externalId} NOT LIKE 'manual:%' AND ${papersTable.tangential} IS NOT TRUE`,
      ),
    )
    .limit(LIBRARY_CAP);
  return rows.map((p) => {
    // Prefer the first ~2000 chars of fullText (PDF body) over the abstract:
    // the abstract often omits the specific edge-level claims we want to cite.
    // This keeps token cost bounded while letting the AI quote real method /
    // results sentences when fullText is available.
    const ft = (p.fullText ?? "").trim();
    const evidenceText = ft.length > 0 ? ft.slice(0, 2000) : (p.abstract ?? null);
    return {
      paperId: p.id,
      title: p.title,
      authors: (p.authors as string[]) ?? [],
      year: p.year ?? null,
      abstract: evidenceText,
      url: p.url ?? null,
    };
  });
}

// ---- AI prompts ----------------------------------------------------------

type AiCandidate = {
  ref: string; // "L:123" for library paperId or "W:W12345" for web externalId
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
};

function buildPerEdgePrompt(edges: EdgeInput[], cands: AiCandidate[], userInstructions: string): string {
  const edgeBlock = edges
    .map((e) => `  - "${e.edgeKey}" — "${e.fromVariableName}" ${RELATION_NL[e.relationship] ?? e.relationship} "${e.toVariableName}"`)
    .join("\n");
  const candBlock = cands
    .map((c, i) => {
      const auth = c.authors.slice(0, 3).join(", ");
      return `[${i + 1}] ref=${c.ref} | ${c.title} (${auth}, ${c.year ?? "n.d."})\nAbstract: ${c.abstract || "(no abstract available)"}\n`;
    })
    .join("\n");
  return `You are matching scholarly papers to specific causal/relational edges in a research model.

EDGES TO MATCH:
${edgeBlock}

CANDIDATE PAPERS:
${candBlock}

${userInstructions ? `USER GUIDANCE: ${userInstructions}\n\n` : ""}For EACH edge, return up to ${TOP_HITS_PER_EDGE} candidate papers whose abstract supports that edge.
- score: 0..1 — how directly the abstract evidences this specific edge (not just the topic area).
- rationale: 1 short Chinese or English sentence explaining the match.
- evidenceQuote: a VERBATIM sentence (or sub-sentence) from the abstract that supports the edge. If no such sentence exists, OMIT this candidate (do not invent quotes).
- Only include papers with score >= 0.45.

Return ONLY this JSON (no prose, no markdown):
{
  "perEdge": [
    {
      "edgeKey": "...",
      "hits": [
        { "ref": "L:123" or "W:W123", "score": 0.0, "rationale": "...", "evidenceQuote": "..." }
      ]
    }
  ]
}`;
}

function buildOverallPrompt(modelSummary: string, cands: AiCandidate[], userInstructions: string): string {
  const candBlock = cands
    .map((c, i) => `[${i + 1}] ref=${c.ref} | ${c.title} (${c.authors.slice(0, 3).join(", ")}, ${c.year ?? "n.d."})\nAbstract: ${c.abstract || "(no abstract)"}\n`)
    .join("\n");
  return `You are ranking scholarly papers by overall relevance to a research model.

MODEL OVERVIEW:
${modelSummary}

CANDIDATE PAPERS:
${candBlock}

${userInstructions ? `USER GUIDANCE: ${userInstructions}\n\n` : ""}Pick up to ${TOP_OVERALL} papers most relevant to the model AS A WHOLE (theory, constructs, or empirical context).
- score: 0..1 — overall relevance, not just one edge.
- rationale: 1 short sentence on how it relates to the whole model.

Return ONLY this JSON:
{
  "overall": [
    { "ref": "L:123" or "W:W123", "score": 0.0, "rationale": "..." }
  ]
}`;
}

async function aiPerEdge(edges: EdgeInput[], cands: AiCandidate[], userInstructions: string) {
  if (edges.length === 0 || cands.length === 0) return new Map<string, Array<{ ref: string; score: number; rationale: string; evidenceQuote?: string }>>();
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: "You match papers to research-model edges using only abstract evidence. Output strict JSON." },
      { role: "user", content: buildPerEdgePrompt(edges, cands, userInstructions) },
    ],
    response_format: { type: "json_object" },
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  const out = new Map<string, Array<{ ref: string; score: number; rationale: string; evidenceQuote?: string }>>();
  try {
    const parsed = JSON.parse(raw) as { perEdge?: Array<{ edgeKey: string; hits?: Array<{ ref: string; score: number; rationale: string; evidenceQuote?: string }> }> };
    for (const row of parsed.perEdge ?? []) {
      if (!row?.edgeKey) continue;
      const hits = (row.hits ?? []).filter((h) => h && typeof h.ref === "string" && typeof h.score === "number");
      out.set(row.edgeKey, hits);
    }
  } catch {
    /* swallow — return whatever we got */
  }
  return out;
}

async function aiOverall(modelSummary: string, cands: AiCandidate[], userInstructions: string) {
  if (cands.length === 0) return [] as Array<{ ref: string; score: number; rationale: string }>;
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: "You rank papers by overall relevance to a research model. Output strict JSON." },
      { role: "user", content: buildOverallPrompt(modelSummary, cands, userInstructions) },
    ],
    response_format: { type: "json_object" },
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(raw) as { overall?: Array<{ ref: string; score: number; rationale: string }> };
    return (parsed.overall ?? []).filter((h) => h && typeof h.ref === "string" && typeof h.score === "number");
  } catch {
    return [];
  }
}

// ---- public API ----------------------------------------------------------

export async function findEvidenceForModel(args: {
  sessionId: number;
  edges: EdgeInput[];
  modelSummary: string;
  options: SearchOptions;
}): Promise<{ overallMatches: PaperHit[]; perEdgeMatches: EdgeMatch[]; durationMs: number }> {
  const t0 = Date.now();
  const wantLib = args.options.scopes.includes("library");
  const wantWeb = args.options.scopes.includes("web");
  const wantScholar = args.options.scopes.includes("scholar");

  // Focused-edge mode: the user clicked "搜索出处" on ONE specific edge in the
  // relationship list. Drop every other edge BEFORE we fan out web/scholar
  // fetches or build the AI prompt — otherwise we'd burn tokens on unrelated
  // edges and dilute per-edge precision. Overall granularity is also
  // suppressed (it only makes sense for the whole model). Image hits are
  // auto-enabled here since the user is asking for evidence of one specific
  // claim and figures are the most informative artifact.
  const focusKey = (args.options.focusEdgeKey ?? "").trim();
  const isFocused = focusKey.length > 0;
  const edges = isFocused ? args.edges.filter((e) => e.edgeKey === focusKey) : args.edges;

  const wantOverall = !isFocused && args.options.granularity.includes("overall");
  const wantPerEdge = isFocused || args.options.granularity.includes("per-edge");
  const wantImages = args.options.includeImages ?? isFocused;
  const userInstructions = (args.options.instructions ?? "").slice(0, 500).trim();

  // ---------- gather candidate pool ----------
  const refToCand = new Map<
    string,
    | { kind: "library"; cand: LibCandidate }
    | { kind: "web"; cand: ReturnType<typeof workToCandidate> }
    | { kind: "scholar"; cand: ScholarCandidate }
  >();
  const aiCandidates: AiCandidate[] = [];

  if (wantLib) {
    const lib = await loadLibraryCandidates(args.sessionId);
    for (const p of lib) {
      const ref = `L:${p.paperId}`;
      refToCand.set(ref, { kind: "library", cand: p });
      aiCandidates.push({ ref, title: p.title, authors: p.authors, year: p.year, abstract: trunc(p.abstract) });
    }
  }

  // In focused mode we ONLY have one edge, so per-edge and overall both
  // become "search by this edge's natural-language query". Bump per-edge
  // pool size since we're not splitting the budget across many edges.
  const focusedPerEdge = isFocused ? Math.max(WEB_PER_EDGE * 2, 10) : WEB_PER_EDGE;

  if (wantWeb && wantPerEdge) {
    const seen = new Set<string>();
    const results = await Promise.all(edges.map((e) => fetchOpenAlex(edgeAsQuery(e), focusedPerEdge).catch(() => [])));
    for (const works of results) {
      for (const w of works) {
        const c = workToCandidate(w);
        const ref = `W:${c.externalId}`;
        if (seen.has(ref) || refToCand.has(ref)) continue;
        seen.add(ref);
        refToCand.set(ref, { kind: "web", cand: c });
        aiCandidates.push({ ref, title: c.title, authors: c.authors, year: c.year, abstract: trunc(c.abstract) });
      }
    }
  } else if (wantWeb && !wantPerEdge) {
    const works = await fetchOpenAlex(args.modelSummary.slice(0, 200), WEB_PER_EDGE * 2).catch(() => []);
    for (const w of works) {
      const c = workToCandidate(w);
      const ref = `W:${c.externalId}`;
      if (refToCand.has(ref)) continue;
      refToCand.set(ref, { kind: "web", cand: c });
      aiCandidates.push({ ref, title: c.title, authors: c.authors, year: c.year, abstract: trunc(c.abstract) });
    }
  }

  if (wantScholar && wantPerEdge) {
    const seen = new Set<string>();
    const results = await Promise.all(edges.map((e) => fetchGoogleScholar(edgeAsQuery(e), focusedPerEdge).catch(() => [])));
    for (const cands of results) {
      for (const c of cands) {
        const ref = `S:${c.externalId}`;
        if (seen.has(ref) || refToCand.has(ref)) continue;
        seen.add(ref);
        refToCand.set(ref, { kind: "scholar", cand: c });
        aiCandidates.push({ ref, title: c.title, authors: c.authors, year: c.year, abstract: trunc(c.abstract) });
      }
    }
  } else if (wantScholar && !wantPerEdge) {
    const cands = await fetchGoogleScholar(args.modelSummary.slice(0, 200), WEB_PER_EDGE * 2).catch(() => []);
    for (const c of cands) {
      const ref = `S:${c.externalId}`;
      if (refToCand.has(ref)) continue;
      refToCand.set(ref, { kind: "scholar", cand: c });
      aiCandidates.push({ ref, title: c.title, authors: c.authors, year: c.year, abstract: trunc(c.abstract) });
    }
  }

  // ---------- AI scoring ----------
  type PerEdgeHit = { ref: string; score: number; rationale: string; evidenceQuote?: string };
  type OverallHit = { ref: string; score: number; rationale: string };
  const [perEdgeMap, overallList] = await Promise.all([
    wantPerEdge
      ? aiPerEdge(args.edges, aiCandidates, userInstructions)
      : Promise.resolve(new Map<string, PerEdgeHit[]>()),
    wantOverall
      ? aiOverall(args.modelSummary, aiCandidates, userInstructions)
      : Promise.resolve([] as OverallHit[]),
  ]);

  // ---------- materialise hits ----------
  function hydrate(ref: string, score: number, rationale: string, evidenceQuote?: string): PaperHit | null {
    const entry = refToCand.get(ref);
    if (!entry) return null;
    if (entry.kind === "library") {
      const p = entry.cand;
      return {
        source: "library",
        paperId: p.paperId,
        externalId: null,
        title: p.title,
        authors: p.authors,
        year: p.year,
        abstract: p.abstract,
        url: p.url,
        score,
        rationale,
        evidenceQuote: evidenceQuote ?? null,
      };
    }
    if (entry.kind === "scholar") {
      const c = entry.cand;
      return {
        source: "scholar",
        paperId: null,
        externalId: c.externalId,
        title: c.title,
        authors: c.authors,
        year: c.year,
        abstract: c.abstract,
        url: c.url,
        score,
        rationale,
        evidenceQuote: evidenceQuote ?? null,
      };
    }
    const c = entry.cand;
    return {
      source: "web",
      paperId: null,
      externalId: c.externalId,
      title: c.title,
      authors: c.authors,
      year: c.year,
      abstract: c.abstract,
      url: c.url,
      score,
      rationale,
      evidenceQuote: evidenceQuote ?? null,
    };
  }

  // Per-edge image hits: only fetched when wantImages is on AND we have a
  // small edge set (avoid fanning out 10+ google_images calls). In focused
  // mode this is always exactly one call.
  const imageHitsByEdge = new Map<string, ImageHit[]>();
  if (wantImages && wantPerEdge && edges.length <= 3) {
    const results = await Promise.all(edges.map((e) => fetchEdgeFigures(e).catch(() => [] as ImageHit[])));
    edges.forEach((e, i) => imageHitsByEdge.set(e.edgeKey, results[i] ?? []));
  }

  // Walk the FILTERED edge set (not args.edges) so focused mode returns
  // exactly one block instead of N empty ones for unrelated edges.
  const perEdgeMatches: EdgeMatch[] = edges.map((e) => {
    const raw = perEdgeMap.get(e.edgeKey) ?? [];
    const hits = raw
      .map((h) => hydrate(h.ref, h.score, h.rationale, h.evidenceQuote))
      .filter((x): x is PaperHit => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_HITS_PER_EDGE);
    return {
      edgeKey: e.edgeKey,
      fromVariableId: e.fromVariableId,
      toVariableId: e.toVariableId,
      fromVariableName: e.fromVariableName,
      toVariableName: e.toVariableName,
      relationship: e.relationship,
      hits,
      imageHits: imageHitsByEdge.get(e.edgeKey) ?? [],
    };
  });

  const overallMatches: PaperHit[] = (overallList as Array<{ ref: string; score: number; rationale: string }>)
    .map((h) => hydrate(h.ref, h.score, h.rationale))
    .filter((x): x is PaperHit => !!x)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_OVERALL);

  return { overallMatches, perEdgeMatches, durationMs: Date.now() - t0 };
}

// Build a stable edge key so the client can round-trip it through evidence-apply.
export function makeEdgeKey(fromVarId: number, toVarId: number, relationship: string): string {
  return `${fromVarId}-${toVarId}-${relationship}`;
}

// Helper used by evidence-apply: import a chosen web hit into the session library
// (idempotent — returns the existing paperId if a row with the same externalId
// already exists for this session).
export async function importWebPaper(args: {
  sessionId: number;
  externalId: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  url: string | null;
}): Promise<number> {
  const dup = await db
    .select({ id: papersTable.id })
    .from(papersTable)
    .where(and(eq(papersTable.sessionId, args.sessionId), eq(papersTable.externalId, args.externalId)))
    .limit(1);
  if (dup[0]) return dup[0].id;

  const [row] = await db
    .insert(papersTable)
    .values({
      sessionId: args.sessionId,
      externalId: args.externalId,
      title: args.title,
      authors: args.authors as unknown as string[],
      year: args.year ?? null,
      abstract: args.abstract ?? "",
      url: args.url ?? "",
      venue: "",
      citationCount: 0,
      openAccessUrl: "",
      extracted: "false",
    })
    .returning({ id: papersTable.id });
  return row.id;
}

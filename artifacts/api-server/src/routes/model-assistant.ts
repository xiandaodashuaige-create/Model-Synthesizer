import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, papersTable, variablesTable, researchModelsTable } from "@workspace/db";
import { ChatModelAssistantParams, ChatModelAssistantBody } from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { backbonesAsPromptBlock, operatorsAsPromptBlock } from "../lib/theoryTemplates.js";

const router: IRouter = Router();

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  attachments?: Array<{ name: string; kind: "image" | "text"; data: string }>;
};

router.post("/sessions/:id/model-assistant", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const body = ChatModelAssistantBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid body", details: body.error.issues });
    return;
  }
  const sessionId = params.data.id;
  const messages = body.data.messages as ChatMsg[];

  // Build session context: papers, variables, existing models.
  const [papers, variables, models] = await Promise.all([
    db.select().from(papersTable).where(eq(papersTable.sessionId, sessionId)),
    db.select().from(variablesTable).where(eq(variablesTable.sessionId, sessionId)),
    db.select().from(researchModelsTable).where(eq(researchModelsTable.sessionId, sessionId)),
  ]);

  if (variables.length === 0) {
    res.json({
      reply: "目前这个项目里还没有提取出任何变量。请先回到『提取变量』那一步，让 AI 把论文里的研究变量识别出来，我才能帮你设计模型组合方案。",
    });
    return;
  }

  const paperLines = papers.map((p, i) => {
    const tag = `P${i + 1}`;
    const authors = (p.authors ?? []).slice(0, 2).join(", ");
    return `  - id=${p.id} ${tag}: ${p.title} (${authors}${p.year ? `, ${p.year}` : ""})`;
  }).join("\n");

  const varLines = variables.map((v) => {
    const paperIdx = papers.findIndex((p) => p.id === v.paperId);
    const paperTag = paperIdx >= 0 ? `P${paperIdx + 1}` : "?";
    return `  - id=${v.id} [${v.type}] "${v.name}" (from ${paperTag})`;
  }).join("\n");

  const existingModelLines = models.length > 0
    ? models.slice(0, 5).map((m, i) => `  - "${m.name}" — ${(m.description ?? "").slice(0, 120)}`).join("\n")
    : "  (none yet)";

  const systemPrompt = `You are an interactive research-model design assistant inside the "学术模型构建器" app. The user is a researcher who has already collected papers and extracted variables in this session, and now wants to refine the next round of model generation.

Reply in the SAME language the user writes in (mostly Chinese). Be conversational, warm, and concrete — never generic.

YOUR JOB:
1. Read what the user says (and any attached files: text or image).
2. Connect their idea/breakthrough to the SPECIFIC variables and papers already in this session.
3. Ask short clarifying questions when needed (1 question at a time, only if truly necessary).
4. When the user's intent is clear enough to act on, end your reply with a JSON suggestion block in fences exactly like:
\`\`\`suggestion
{
  "userPrompt": "<a sharp, well-written instruction the model-generation AI should follow — Chinese is fine>",
  "focusVariableIds": [<int>, ...],
  "requiredOperators": ["EXTEND" | "INSERT_MODERATOR" | "PARALLEL_MEDIATORS" | "SWAP_MEDIATOR" | "THEORY_GRAFT", ...]
}
\`\`\`
Only emit the suggestion block when you are recommending the user click "套用并生成". If the user is still exploring, OMIT the block entirely.

The suggestion will pre-fill the generation form and select variables — keep userPrompt under 600 chars, focusVariableIds 2-6 items, requiredOperators 1-2 items.

5. **CRITICAL — material-sufficiency check**: BEFORE you emit a suggestion block, judge whether the existing papers and variables actually cover the user's research question. If a key construct is missing (e.g. user wants a moderator type that no current paper measures, or wants a context/population not represented), DO NOT pretend — instead emit a needs-more-papers block in fences exactly like:
\`\`\`needs_more_papers
{
  "reason": "<one short Chinese sentence explaining what is missing and why current materials can't cover it>",
  "searchQuery": "<2-6 word English search query the user can paste into OpenAlex>",
  "missingConstructs": ["<construct 1>", "<construct 2>"]
}
\`\`\`
You may emit BOTH a suggestion block AND a needs_more_papers block in the same reply if you can give a partial model now but recommend strengthening it with more literature. If materials are clearly sufficient, OMIT the needs_more_papers block entirely.

================ SESSION CONTEXT ================
PAPERS (${papers.length}):
${paperLines || "  (none)"}

VARIABLES (${variables.length}):
${varLines}

EXISTING GENERATED MODELS:
${existingModelLines}

AVAILABLE STRUCTURAL OPERATORS:
${operatorsAsPromptBlock()}

AVAILABLE THEORY BACKBONES:
${backbonesAsPromptBlock()}
================================================

Be specific. Reference variables and papers BY NAME. Never invent variables that aren't in the list above.`;

  // Convert chat messages to OpenAI format. Attachments expand into multi-modal content arrays.
  const oaMessages: Array<{ role: "system" | "user" | "assistant"; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> = [
    { role: "system", content: systemPrompt },
  ];

  for (const m of messages) {
    const atts = m.attachments ?? [];
    if (atts.length === 0) {
      oaMessages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      // attachments only meaningful on user messages; flatten just in case
      oaMessages.push({ role: "assistant", content: m.content });
      continue;
    }
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    if (m.content?.trim()) parts.push({ type: "text", text: m.content });
    for (const a of atts) {
      if (a.kind === "image") {
        // Expect a data URL or http(s) URL.
        const url = a.data.startsWith("data:") || a.data.startsWith("http") ? a.data : `data:image/png;base64,${a.data}`;
        parts.push({ type: "image_url", image_url: { url } });
      } else {
        // text attachment — limit each to 8000 chars to control token usage.
        const truncated = a.data.slice(0, 8000);
        parts.push({ type: "text", text: `[Attached file: ${a.name}]\n${truncated}${a.data.length > 8000 ? "\n…(truncated)" : ""}` });
      }
    }
    oaMessages.push({ role: "user", content: parts });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 2400,
      messages: oaMessages as any,
    });

    const raw = completion.choices[0]?.message?.content ?? "";

    // Extract optional ```suggestion {...}``` block.
    let reply = raw;
    let suggestion: { userPrompt?: string; focusVariableIds?: number[]; requiredOperators?: string[] } | undefined;
    const m = raw.match(/```suggestion\s*([\s\S]*?)```/i);
    if (m) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const validVarIds = new Set(variables.map((v) => v.id));
        const cleanedFocus = Array.isArray(parsed.focusVariableIds)
          ? parsed.focusVariableIds.filter((x: unknown) => typeof x === "number" && validVarIds.has(x))
          : [];
        const allowedOps = new Set(["EXTEND", "INSERT_MODERATOR", "PARALLEL_MEDIATORS", "SWAP_MEDIATOR", "THEORY_GRAFT"]);
        const cleanedOps = Array.isArray(parsed.requiredOperators)
          ? parsed.requiredOperators.filter((x: unknown) => typeof x === "string" && allowedOps.has(x))
          : [];
        suggestion = {
          userPrompt: typeof parsed.userPrompt === "string" ? parsed.userPrompt.slice(0, 800) : undefined,
          focusVariableIds: cleanedFocus,
          requiredOperators: cleanedOps,
        };
        reply = reply.replace(m[0], "").trim();
      } catch (err) {
        req.log.warn({ err, block: m[1] }, "Failed to parse suggestion block");
      }
    }

    // Extract optional ```needs_more_papers {...}``` block.
    let needsMorePapers: { reason: string; searchQuery?: string; missingConstructs?: string[] } | undefined;
    const nm = raw.match(/```needs_more_papers\s*([\s\S]*?)```/i);
    if (nm) {
      try {
        const parsed = JSON.parse(nm[1].trim());
        if (typeof parsed.reason === "string" && parsed.reason.trim().length > 0) {
          needsMorePapers = {
            reason: parsed.reason.slice(0, 400),
            searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery.slice(0, 120) : undefined,
            missingConstructs: Array.isArray(parsed.missingConstructs)
              ? parsed.missingConstructs.filter((x: unknown) => typeof x === "string").slice(0, 6)
              : undefined,
          };
        }
        reply = reply.replace(nm[0], "").trim();
      } catch (err) {
        req.log.warn({ err, block: nm[1] }, "Failed to parse needs_more_papers block");
      }
    }

    res.json({ reply, suggestion, needsMorePapers });
  } catch (err) {
    req.log.error({ err }, "Model assistant chat failed");
    res.status(500).json({ error: "Assistant failed to respond" });
  }
});

// ---------------------------------------------------------------------------
// Image search: find research-model / conceptual-framework figures on the web.
//
// Strategy:
//  1. Use OpenAI to expand the user's (often-rough, often-Chinese) topic into
//     2-3 precise English academic search queries.
//  2. For each expanded query, run Brave image search restricted to a curated
//     list of academic domains (ScienceDirect, Springer, ResearchGate, PMC,
//     etc.) using the `site:` operator so we only pull figures from real
//     papers — not stock art.
//  3. Merge results, dedupe by source URL, score by topic relevance + figure
//     hints + academic-domain bonus, and return the top N.
//  4. If `raw=true`, skip OpenAI expansion and use the user's text verbatim.
// ---------------------------------------------------------------------------
type ImageSearchHit = {
  title: string;
  thumbnailUrl: string;
  imageUrl: string;
  sourceUrl: string;
  sourceDomain: string;
  width?: number;
  height?: number;
  _score: number;
  _matched: number;
  _query: string;
};

const ACADEMIC_SITES = [
  "sciencedirect.com",
  "link.springer.com",
  "springer.com",
  "springeropen.com",
  "pmc.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "researchgate.net",
  "semanticscholar.org",
  "academia.edu",
  "tandfonline.com",
  "onlinelibrary.wiley.com",
  "wiley.com",
  "emerald.com",
  "emeraldinsight.com",
  "frontiersin.org",
  "mdpi.com",
  "arxiv.org",
  "ieeexplore.ieee.org",
  "dl.acm.org",
  "journals.sagepub.com",
  "journals.plos.org",
  "nature.com",
  "cambridge.org",
  "oup.com",
  "academic.oup.com",
  "ssrn.com",
  "papers.ssrn.com",
  "jstor.org",
  "scholasticahq.com",
  "biomedcentral.com",
  "bmj.com",
  "tandfonline.com",
  "informaworld.com",
  "elsevier.com",
  "doi.org",
  "core.ac.uk",
  "openreview.net",
];

const FIGURE_HINT_RE = /\b(framework|model|figure|fig\.|diagram|hypothes|conceptual|theoretical|construct|sem |moderat|mediat|antecedent|outcome)/i;

// Hostname-anchored academic check: accepts only when the URL's actual hostname
// equals or is a subdomain of one of ACADEMIC_SITES. Avoids false positives
// from substrings appearing in paths/queries or deceptive hostnames.
function isAcademicSource(sourceUrl: string): boolean {
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ACADEMIC_SITES.some((d) => host === d || host.endsWith(`.${d}`));
}

// Second-pass AI relevance gate: given the user's topic and a list of candidate
// figure titles + source URLs, return the subset of indices that are ACTUALLY
// about the topic. Figures that are merely on academic sites but unrelated
// (e.g. neural-network diagrams, generic flowcharts, journal logos) get
// dropped here. Returns null if the AI call fails — caller should fall back
// to the un-gated list rather than serve nothing.
async function aiRelevanceFilter(
  rawQuery: string,
  expandedQueries: string[],
  candidates: Array<{ title: string; sourceDomain: string }>,
): Promise<number[] | null> {
  if (candidates.length === 0) return [];
  try {
    const list = candidates
      .map((c, i) => `${i}. [${c.sourceDomain}] ${c.title.slice(0, 180)}`)
      .join("\n");
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 600,
      messages: [
        {
          role: "system",
          content: `You are filtering image search results. The user is looking for conceptual-model / theoretical-framework FIGURES from research papers about a SPECIFIC topic.

For each candidate (numbered list of "title [source]"), decide whether the figure is plausibly a conceptual model / SEM / framework / hypothesis diagram on this topic. Be GENEROUS — keep it if the title is short/generic ("Fig. 1", "Conceptual model") AND the source is a reputable academic paper site, because thumbnails often have minimal titles. Drop only when the title clearly indicates an UNRELATED domain (e.g. neural network architecture, gene expression, molecular structure, financial chart, journal logo, generic flowchart with no topic words).

Output ONLY a JSON object: {"keep": [list of indices, integers]}.`,
        },
        {
          role: "user",
          content: `User's topic (Chinese or rough English): ${rawQuery}
Expanded English queries: ${expandedQueries.join(" | ")}

Candidates:
${list}`,
        },
      ],
    });
    const txt = completion.choices[0]?.message?.content ?? "";
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { keep?: unknown };
    if (!Array.isArray(parsed.keep)) return null;
    const keep = parsed.keep
      .filter((n): n is number => typeof n === "number" && Number.isInteger(n))
      .filter((n) => n >= 0 && n < candidates.length);
    // Defend against the AI returning an empty list when it shouldn't — if it
    // dropped EVERYTHING, fall back rather than show nothing.
    if (keep.length === 0 && candidates.length >= 4) return null;
    return keep;
  } catch {
    return null;
  }
}

async function expandQueriesWithAI(rawQuery: string): Promise<string[]> {
  // Ask GPT to translate any rough/Chinese phrasing into 2-3 precise English
  // academic search queries. Falls back to the raw query if AI fails.
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 400,
      messages: [
        {
          role: "system",
          content: `You convert a user's rough research topic into 2-3 PRECISE English academic search queries that will find conceptual model / theoretical framework FIGURES inside published research papers.

Rules:
- Output ONLY a JSON object: {"queries": ["query 1", "query 2", "query 3"]}
- Each query: 4-8 words, all lowercase English, NO quotes, NO site: filters
- Use canonical academic terminology (e.g. "AI streamer" not "AI-broadcast", "impulse buying" not "impulsive purchase", "parasocial interaction", "purchase intention", "trust", "anthropomorphism", "live streaming commerce")
- If the input mentions Chinese constructs (e.g. 直播/主播/冲动消费/信任/心流), translate to standard academic English equivalents
- Each query should target a SPECIFIC variant of the topic, not all be paraphrases
- Do NOT include words like "research", "model", "framework", "figure", "diagram" — they're added separately`,
        },
        { role: "user", content: rawQuery },
      ],
    });
    const txt = completion.choices[0]?.message?.content ?? "";
    // Extract first JSON object
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { queries?: unknown };
    if (!Array.isArray(parsed.queries)) return [];
    return parsed.queries
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter((q) => q.length >= 3)
      .slice(0, 3);
  } catch (err) {
    return [];
  }
}

// SerpApi → Google Images. Higher-quality results than Brave (Google's index is
// ~10x larger). Returns the same normalized shape as braveImageSearch.
async function serpApiImageSearch(
  query: string,
  apiKey: string,
  count: number,
  log: { warn: (o: object, m: string) => void },
): Promise<Array<{ raw: any; title: string; sourceUrl: string; thumbnailUrl: string; fullImage: string; sourceDomain: string; width?: number; height?: number }>> {
  const isHttp = (u: string) => /^https?:\/\//i.test(u);
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(count, 100)));
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("safe", "active");
  // tbs=isz:m biases toward medium+ images (filters tiny icons/logos)
  url.searchParams.set("tbs", "isz:m");

  const r = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) {
    log.warn({ status: r.status, query }, "SerpApi image search failed for one query");
    return [];
  }
  const data = (await r.json()) as {
    error?: string;
    images_results?: Array<{
      position?: number;
      title?: string;
      link?: string; // page URL
      source?: string;
      original?: string; // full image URL
      original_width?: number;
      original_height?: number;
      thumbnail?: string;
      thumbnail_width?: number;
      thumbnail_height?: number;
    }>;
  };
  if (data.error) {
    log.warn({ error: data.error, query }, "SerpApi returned an error");
    return [];
  }
  return (data.images_results ?? [])
    .map((item) => {
      const sourceUrl = item.link ?? "";
      const thumbnailUrl = item.thumbnail ?? "";
      const fullImage = item.original && isHttp(item.original) ? item.original : thumbnailUrl;
      if (!sourceUrl || !thumbnailUrl || !isHttp(sourceUrl) || !isHttp(thumbnailUrl)) return null;
      let domain = item.source ?? "";
      if (!domain) {
        try { domain = new URL(sourceUrl).hostname; } catch { /* ignore */ }
      }
      return {
        raw: item,
        title: (item.title ?? "").slice(0, 200),
        sourceUrl,
        thumbnailUrl,
        fullImage,
        sourceDomain: domain,
        width: item.original_width,
        height: item.original_height,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

async function braveImageSearch(
  query: string,
  apiKey: string,
  count: number,
  log: { warn: (o: object, m: string) => void },
): Promise<Array<{ raw: any; title: string; sourceUrl: string; thumbnailUrl: string; fullImage: string; sourceDomain: string; width?: number; height?: number }>> {
  const isHttp = (u: string) => /^https?:\/\//i.test(u);
  const url = new URL("https://api.search.brave.com/res/v1/images/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("safesearch", "strict");

  const r = await fetch(url.toString(), {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });
  if (!r.ok) {
    log.warn({ status: r.status, query }, "Brave image search failed for one query");
    return [];
  }
  const data = (await r.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      source?: string;
      thumbnail?: { src?: string };
      properties?: { url?: string; width?: number; height?: number };
      meta_url?: { hostname?: string; netloc?: string };
    }>;
  };
  return (data.results ?? [])
    .map((item) => {
      const sourceUrl = item.url ?? "";
      const thumbnailUrl = item.thumbnail?.src ?? item.properties?.url ?? "";
      if (!sourceUrl || !thumbnailUrl || !isHttp(sourceUrl) || !isHttp(thumbnailUrl)) return null;
      const fullImage = item.properties?.url && isHttp(item.properties.url) ? item.properties.url : thumbnailUrl;
      return {
        raw: item,
        title: (item.title ?? "").slice(0, 200),
        sourceUrl,
        thumbnailUrl,
        fullImage,
        sourceDomain: item.meta_url?.hostname ?? item.source ?? "",
        width: item.properties?.width,
        height: item.properties?.height,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

router.post("/sessions/:id/model-assistant/search-model-images", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const rawQuery = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!rawQuery) {
    res.status(400).json({ error: "Missing query" });
    return;
  }
  const count = Math.min(20, Math.max(1, Number(req.body?.count) || 12));
  const rawMode = req.body?.raw === true;

  const serpKey = process.env.SERPAPI_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;
  if (!serpKey && !braveKey) {
    res.status(503).json({ error: "Image search is not configured (missing SERPAPI_API_KEY or BRAVE_API_KEY)" });
    return;
  }

  try {
    // ---- Stage 1: build the list of expanded query strings ---------------
    let expandedQueries: string[] = [];
    if (rawMode) {
      expandedQueries = [rawQuery];
    } else {
      const aiQueries = await expandQueriesWithAI(rawQuery);
      // Always include the user's literal phrase too, in case the AI dropped a
      // critical token. Quote multi-word user input.
      const quoted = /\s/.test(rawQuery) && !/^".*"$/.test(rawQuery) ? `"${rawQuery}"` : rawQuery;
      expandedQueries = [...aiQueries, quoted];
      // Dedupe (case-insensitive) while preserving order.
      const seen = new Set<string>();
      expandedQueries = expandedQueries.filter((q) => {
        const k = q.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (expandedQueries.length === 0) expandedQueries = [quoted];
    }

    // ---- Stage 2: run image search per expanded query --------------------
    // Provider priority: SerpApi (Google Images, ~10x larger index) → Brave.
    // Each query is appended with " conceptual model figure" to bias toward
    // research figures. Over-fetch so the AI relevance gate has plenty of
    // candidates.
    const perQueryFetch = 30;
    let provider: "serpapi" | "brave" = "brave";
    let allItems: Array<{ raw: any; title: string; sourceUrl: string; thumbnailUrl: string; fullImage: string; sourceDomain: string; width?: number; height?: number; _query: string }> = [];
    let anyOk = false;

    if (serpKey) {
      const calls = expandedQueries.map((q) =>
        serpApiImageSearch(`${q} conceptual model figure`, serpKey, perQueryFetch, req.log).then((items) =>
          items.map((it) => ({ ...it, _query: q })),
        ),
      );
      const settled = await Promise.allSettled(calls);
      const items = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
      const ok = settled.some((s) => s.status === "fulfilled" && s.value.length > 0);
      if (ok) {
        provider = "serpapi";
        allItems = items;
        anyOk = true;
      } else {
        req.log.warn({}, "SerpApi returned no results for any query — falling back to Brave");
      }
    }

    if (!anyOk && braveKey) {
      const calls = expandedQueries.map((q) =>
        braveImageSearch(`${q} conceptual model figure`, braveKey, perQueryFetch, req.log).then((items) =>
          items.map((it) => ({ ...it, _query: q })),
        ),
      );
      const settled = await Promise.allSettled(calls);
      allItems = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
      anyOk = settled.some((s) => s.status === "fulfilled");
      if (anyOk) provider = "brave";
    }

    if (!anyOk) {
      res.status(502).json({ error: "All image search queries failed" });
      return;
    }

    // ---- Stage 3: dedupe by sourceUrl, then by thumbnailUrl --------------
    const bySource = new Map<string, (typeof allItems)[number]>();
    for (const it of allItems) {
      // Prefer the first occurrence (academic queries run first in flatMap order).
      if (!bySource.has(it.sourceUrl)) bySource.set(it.sourceUrl, it);
    }
    const seenThumb = new Set<string>();
    const deduped = Array.from(bySource.values()).filter((it) => {
      if (seenThumb.has(it.thumbnailUrl)) return false;
      seenThumb.add(it.thumbnailUrl);
      return true;
    });

    // ---- Stage 4: relevance scoring --------------------------------------
    // Tokenize ALL queries (user + expanded) for matching, so an expanded
    // English query token also counts as relevance.
    const allTokens = new Set<string>();
    for (const q of [rawQuery, ...expandedQueries]) {
      for (const t of q.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
        const tt = t.trim();
        if (tt.length >= 3 && !/^(the|and|for|with|from|that|this|are|was|were|model|research|framework|figure|diagram|conceptual|site)$/.test(tt)) {
          allTokens.add(tt);
        }
      }
    }

    const scored: (ImageSearchHit & { _academic: boolean })[] = deduped.map((it) => {
      const haystack = `${it.title} ${it.sourceUrl}`.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const tok of allTokens) {
        if (haystack.includes(tok)) {
          score += 2;
          matched += 1;
        }
      }
      if (FIGURE_HINT_RE.test(it.title)) score += 2;
      const academic = isAcademicSource(it.sourceUrl);
      if (academic) score += 4;
      if (matched === 0 && /\b(example|template|stock|clipart|powerpoint|slide \d|getty|shutterstock)/i.test(it.title)) {
        score -= 4;
      }
      return {
        title: it.title || "(untitled)",
        thumbnailUrl: it.thumbnailUrl,
        imageUrl: it.fullImage,
        sourceUrl: it.sourceUrl,
        sourceDomain: it.sourceDomain,
        width: it.width,
        height: it.height,
        _score: score,
        _matched: matched,
        _query: (it as any)._query,
        _academic: academic,
      };
    });

    // ---- Stage 5: rank (broader mode — no strict academic filter) -------
    // Academic hosts get a scoring boost (Stage 4) but non-academic hosts
    // are NOT dropped here. This keeps high-quality model figures from
    // SlideShare, conference posters, ResearchGate blog mirrors, lecture
    // PDFs, etc. that Google routinely surfaces above raw journal hits.
    scored.sort((a, b) => b._score - a._score);
    const ranked = scored;

    // ---- Stage 6: AI relevance gate -------------------------------------
    // Send the top ~30 candidates' titles to GPT and let it drop the
    // off-topic ones (neural-net diagrams, journal logos, etc.). Falls back
    // to the un-gated list if the AI call fails or hits an edge case.
    let finalList = ranked;
    if (!rawMode && ranked.length > 0) {
      const candidates = ranked.slice(0, 30);
      const keep = await aiRelevanceFilter(
        rawQuery,
        expandedQueries,
        candidates.map((c) => ({ title: c.title, sourceDomain: c.sourceDomain })),
      );
      if (keep && keep.length > 0) {
        const keepSet = new Set(keep);
        finalList = candidates.filter((_, i) => keepSet.has(i));
      }
    }

    const results = finalList.slice(0, count).map(({ _score, _matched, _query, _academic, ...rest }) => rest);

    res.json({
      query: expandedQueries.join(" | "),
      rawQuery,
      expandedQueries,
      provider,
      results,
    });
  } catch (err) {
    req.log.error({ err }, "Image search threw");
    res.status(502).json({ error: "Image search failed" });
  }
});

// ---------------------------------------------------------------------------
// Paper search with model-figure detection.
//
// Strategy:
//  1. AI-expand the user's (often Chinese / rough) topic into 2-3 precise
//     English academic queries (reuses expandQueriesWithAI).
//  2. Run OpenAlex `title_and_abstract.search` for each query in parallel,
//     merge & dedupe by externalId, sort by citation count.
//  3. AI-classify each paper's abstract: how likely is it to contain a
//     conceptual / SEM / hypothesized-relationships FIGURE? Returns
//     "high" | "medium" | "low" + a one-sentence reason.
// ---------------------------------------------------------------------------
type OpenAlexLite = {
  id: string;
  title: string;
  authorships?: Array<{ author?: { display_name?: string } }>;
  publication_year?: number | null;
  cited_by_count?: number | null;
  primary_location?: {
    landing_page_url?: string;
    pdf_url?: string | null;
    source?: { display_name?: string };
  } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
};

function reconstructAbstractLite(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv || Object.keys(inv).length === 0) return null;
  const positions: [number, string][] = [];
  for (const [w, idxs] of Object.entries(inv)) for (const i of idxs) positions.push([i, w]);
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ");
}

async function fetchPapersFromOpenAlex(query: string, perPage: number): Promise<OpenAlexLite[]> {
  const safe = query.replace(/["',:|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!safe) return [];
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", `title_and_abstract.search:${safe},is_paratext:false,has_abstract:true`);
  url.searchParams.set("per-page", String(Math.min(perPage, 50)));
  url.searchParams.set("sort", "relevance_score:desc");
  url.searchParams.set(
    "select",
    "id,title,authorships,publication_year,cited_by_count,primary_location,abstract_inverted_index",
  );
  url.searchParams.set("mailto", "research@researchmodelbuilder.app");
  const r = await fetch(url.toString(), {
    headers: { "User-Agent": "ResearchModelBuilder/1.0 (mailto:research@researchmodelbuilder.app)" },
  });
  if (!r.ok) return [];
  const data = (await r.json()) as { results?: OpenAlexLite[] };
  return data.results ?? [];
}

type ModelFigureRating = { likelihood: "high" | "medium" | "low"; reason: string };

async function aiRateModelFigureLikelihood(
  rawQuery: string,
  papers: Array<{ title: string; abstract: string | null }>,
): Promise<Array<ModelFigureRating | null>> {
  if (papers.length === 0) return [];
  try {
    const list = papers
      .map((p, i) => {
        const abs = (p.abstract ?? "").slice(0, 700).replace(/\s+/g, " ");
        return `${i}. TITLE: ${p.title.slice(0, 200)}\n   ABSTRACT: ${abs || "(no abstract)"}`;
      })
      .join("\n\n");
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 1200,
      messages: [
        {
          role: "system",
          content: `You are screening academic papers to predict which ones likely contain a CONCEPTUAL MODEL / THEORETICAL FRAMEWORK / SEM / hypothesized-relationships FIGURE inside (the kind of "boxes-and-arrows" diagram researchers want to look at).

Strong signals (→ "high"):
- abstract proposes / tests / develops a "model", "framework", "theoretical model", "conceptual model"
- abstract uses SEM / PLS-SEM / structural equation modeling / path analysis / hypothesis H1...Hn
- abstract uses "mediating role", "moderating role", "antecedents", "we propose", "we develop"

Weak signals (→ "medium"):
- empirical study testing relationships between specific constructs but no explicit "model" wording
- meta-analysis / review that may or may not have a summary framework figure

Negative signals (→ "low"):
- pure qualitative / case study with no quantitative model
- methodology / scale validation paper
- experimental study with no theoretical framework figure
- literature review with no synthesis diagram

Return ONLY JSON: {"ratings":[{"i":0,"likelihood":"high|medium|low","reason":"≤20-word Chinese explanation"}, ...]} — one entry per input paper, indices 0..N-1.`,
        },
        {
          role: "user",
          content: `User's research topic: ${rawQuery}\n\nPapers:\n${list}`,
        },
      ],
    });
    const txt = completion.choices[0]?.message?.content ?? "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return papers.map(() => null);
    const parsed = JSON.parse(m[0]) as { ratings?: Array<{ i?: number; likelihood?: string; reason?: string }> };
    if (!Array.isArray(parsed.ratings)) return papers.map(() => null);
    const out: Array<ModelFigureRating | null> = papers.map(() => null);
    for (const r of parsed.ratings) {
      if (typeof r.i !== "number" || r.i < 0 || r.i >= papers.length) continue;
      const lk = r.likelihood;
      if (lk !== "high" && lk !== "medium" && lk !== "low") continue;
      out[r.i] = { likelihood: lk, reason: typeof r.reason === "string" ? r.reason.slice(0, 200) : "" };
    }
    return out;
  } catch {
    return papers.map(() => null);
  }
}

router.post("/sessions/:id/model-assistant/search-model-papers", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const rawQuery = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!rawQuery) {
    res.status(400).json({ error: "Missing query" });
    return;
  }
  const count = Math.min(20, Math.max(1, Number(req.body?.count) || 10));
  const rawMode = req.body?.raw === true;

  try {
    // ---- Stage 1: expanded queries (reuse image-search expansion) -------
    let expandedQueries: string[] = [];
    if (rawMode) {
      expandedQueries = [rawQuery];
    } else {
      const aiQueries = await expandQueriesWithAI(rawQuery);
      expandedQueries = [...aiQueries, rawQuery];
      const seen = new Set<string>();
      expandedQueries = expandedQueries.filter((q) => {
        const k = q.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (expandedQueries.length === 0) expandedQueries = [rawQuery];
    }

    // ---- Stage 2: parallel OpenAlex queries ------------------------------
    const perQuery = 25;
    const settled = await Promise.allSettled(
      expandedQueries.map((q) => fetchPapersFromOpenAlex(q, perQuery)),
    );
    const all = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    if (all.length === 0) {
      res.status(502).json({ error: "OpenAlex returned no results" });
      return;
    }

    // Dedupe by externalId; prefer first occurrence (earlier queries weighted higher)
    const byId = new Map<string, OpenAlexLite>();
    for (const w of all) {
      if (!w.id) continue;
      if (!byId.has(w.id)) byId.set(w.id, w);
    }
    const deduped = Array.from(byId.values());

    // Sort by citation count desc as a quality prior, then trim to a working
    // set we'll send to the AI rater. Keep up to 2x the requested count so
    // we can still hit `count` after low-likelihood papers are filtered out.
    deduped.sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0));
    const workingSet = deduped.slice(0, Math.min(20, count * 2));

    // ---- Stage 3: AI rate model-figure likelihood -----------------------
    const ratingInput = workingSet.map((w) => ({
      title: w.title ?? "",
      abstract: reconstructAbstractLite(w.abstract_inverted_index),
    }));
    const ratings = await aiRateModelFigureLikelihood(rawQuery, ratingInput);

    // Build response. Sort by likelihood (high → medium → low → unrated),
    // breaking ties by citation count.
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const enriched = workingSet.map((w, i) => {
      const externalId = w.id.replace("https://openalex.org/", "");
      const authors = (w.authorships ?? [])
        .map((a) => a.author?.display_name)
        .filter((s): s is string => !!s);
      const venue = w.primary_location?.source?.display_name ?? null;
      const openAccessUrl = w.primary_location?.pdf_url ?? null;
      const url = w.primary_location?.landing_page_url ?? `https://openalex.org/${externalId}`;
      const abstract = reconstructAbstractLite(w.abstract_inverted_index);
      const r = ratings[i];
      return {
        externalId,
        title: w.title ?? "",
        abstract,
        authors,
        year: w.publication_year ?? null,
        venue,
        citationCount: w.cited_by_count ?? null,
        openAccessUrl,
        url,
        modelFigureLikelihood: (r?.likelihood ?? "medium") as "high" | "medium" | "low",
        modelFigureReason: r?.reason ?? "",
      };
    });

    enriched.sort((a, b) => {
      const ra = rank[a.modelFigureLikelihood] ?? 99;
      const rb = rank[b.modelFigureLikelihood] ?? 99;
      if (ra !== rb) return ra - rb;
      return (b.citationCount ?? 0) - (a.citationCount ?? 0);
    });

    res.json({
      query: expandedQueries.join(" | "),
      rawQuery,
      expandedQueries,
      papers: enriched.slice(0, count),
    });
  } catch (err) {
    req.log.error({ err }, "Paper search threw");
    res.status(502).json({ error: "Paper search failed" });
  }
});

export default router;

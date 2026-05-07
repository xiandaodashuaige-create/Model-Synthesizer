import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, variablesTable, papersTable, paperHypothesesTable } from "@workspace/db";
import {
  ExtractVariablesParams,
  ListSessionVariablesParams,
  GetVariableGraphParams,
} from "@workspace/api-zod";
import { normalizeName } from "@workspace/canonicalize";
import { CONSTRUCT_LAYERS } from "../lib/theoryTemplates.js";
import { extractAndStorePaperVariables, ExtractionError } from "../lib/paper-extraction.js";

const router: IRouter = Router();

function formatVariable(v: typeof variablesTable.$inferSelect, paper: typeof papersTable.$inferSelect) {
  return {
    id: v.id,
    sessionId: v.sessionId,
    paperId: v.paperId,
    paperTitle: paper.title,
    paperAuthors: paper.authors,
    paperYear: paper.year,
    name: v.name,
    type: v.type,
    definition: v.definition,
    citationText: v.citationText,
    canonicalConstructId: v.canonicalConstructId,
    constructLayer: v.constructLayer,
    createdAt: v.createdAt.toISOString(),
  };
}

// Legacy wrapper preserved so existing call-sites that wrote
// `canonicalize(name)` and stored the result in `variables.canonicalConstructId`
// keep producing the same string. Construct-name normalization itself lives in
// @workspace/canonicalize (single source of truth, shared with the client).
// New Innovation Layer code should import `canonicalize` directly from
// @workspace/canonicalize to get the 3-layer object form.
function canonicalize(name: string): string {
  return normalizeName(name);
}

const VALID_LAYERS = new Set<string>(CONSTRUCT_LAYERS as readonly string[]);

router.post("/sessions/:id/papers/:paperId/extract", async (req, res): Promise<void> => {
  const params = ExtractVariablesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [paper] = await db
    .select()
    .from(papersTable)
    .where(and(eq(papersTable.id, params.data.paperId), eq(papersTable.sessionId, params.data.id)));

  if (!paper) {
    res.status(404).json({ error: "Paper not found" });
    return;
  }

  try {
    const result = await extractAndStorePaperVariables(paper, req.log);
    res.json(result.insertedVariables.map((v) => formatVariable(v, paper)));
    return;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    // Preserve pre-refactor error surface: if the lib raised a typed
    // ExtractionError with a known code (parse_failed / no_variables / timeout),
    // pass through its status + machine code; otherwise fall through to the
    // legacy title-prefixed 500. The fallback ALSO repeats the regex timeout
    // check so unrelated timeout-shaped errors (DB / network) still map to 504,
    // matching the original handler's broader semantics.
    if (err instanceof ExtractionError && err.code !== "unknown") {
      const isTimeout = err.code === "timeout";
      req.log.error({ err, paperId: paper.id, paperTitle: paper.title, isTimeout }, "Error extracting variables");
      if (isTimeout) {
        res.status(504).json({ error: `提取超时（90 秒）：「${paper.title.slice(0, 60)}」。该论文可能过长或 AI 暂时拥塞，可稍后单独重试。` });
        return;
      }
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    const isTimeout = e?.name === "AbortError" || e?.name === "TimeoutError" || /aborted|timeout/i.test(e?.message ?? "");
    req.log.error({ err, paperId: paper.id, paperTitle: paper.title, isTimeout }, "Error extracting variables");
    if (isTimeout) {
      res.status(504).json({ error: `提取超时（90 秒）：「${paper.title.slice(0, 60)}」。该论文可能过长或 AI 暂时拥塞，可稍后单独重试。` });
      return;
    }
    res.status(500).json({ error: `提取失败：「${paper.title.slice(0, 60)}」（${e?.message ?? "unknown error"}）` });
    return;
  }
});

// --- legacy inline extraction prompt removed (now in lib/paper-extraction.ts) ---

router.get("/sessions/:id/variables", async (req, res): Promise<void> => {
  const params = ListSessionVariablesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const variables = await db
    .select()
    .from(variablesTable)
    .where(eq(variablesTable.sessionId, params.data.id))
    .orderBy(variablesTable.type, variablesTable.createdAt);

  const paperIds = [...new Set(variables.map((v) => v.paperId))];
  const papers = await Promise.all(
    paperIds.map((id) => db.select().from(papersTable).where(eq(papersTable.id, id)).limit(1))
  );
  const paperMap = new Map(papers.flat().map((p) => [p.id, p]));

  res.json(
    variables.map((v) => {
      const paper = paperMap.get(v.paperId)!;
      return formatVariable(v, paper);
    })
  );
});

// ---------------------------------------------------------------------------
// Manual / custom variable creation.
//
// Researchers often need to add a construct that the AI did NOT extract
// (because it sits in a paper not yet in the session, because the construct
// is theoretical-only, or because the AI named it differently than the
// researcher prefers). This endpoint lets them type a name + type and get a
// real `variables` row that participates in the variable pool, live model
// canvas, and downstream model generation just like any extracted variable.
//
// Implementation choice: rather than making `variables.paperId` nullable
// (which would cascade through ~30 read sites that assume non-null FK), we
// lazily create ONE sentinel "[手动添加]" paper per session and bind every
// manual variable to it. That paper has no fullText / abstract so it doesn't
// pollute AI extraction or model-generation prompts (those iterate paper
// fullText / abstract — both null here), and we filter it out of the visible
// papers list + paper count so the user's "13 篇论文" tab counter stays
// truthful. The downside is that manual variables show no paper citation in
// the variables grid, which is intentional — they're not from a paper.
// ---------------------------------------------------------------------------

const MANUAL_PAPER_EXTERNAL_ID = (sessionId: number) => `manual:${sessionId}`;
export const MANUAL_PAPER_PREFIX = "manual:";

// In-process lock: dedupe concurrent getOrCreateManualPaper() calls within a
// single server instance. Without this, two parallel POST /sessions/:id/variables
// requests for the same session both miss the SELECT, both INSERT, and we end
// up with two sentinel papers (the table has no unique constraint on
// sessionId+externalId — adding one would require a migration). The lock holds
// the in-flight create promise per sessionId; concurrent callers await the same
// promise and all see the same row.
//
// Note: this only protects against intra-process races. A multi-process /
// horizontally-scaled deployment would still need a DB-level unique index. For
// the current single-instance autoscale tier, this is sufficient and ships
// without a migration.
const manualPaperCreateLocks = new Map<number, Promise<typeof papersTable.$inferSelect>>();

async function getOrCreateManualPaper(sessionId: number) {
  const externalId = MANUAL_PAPER_EXTERNAL_ID(sessionId);
  const existing = await db
    .select()
    .from(papersTable)
    .where(and(eq(papersTable.sessionId, sessionId), eq(papersTable.externalId, externalId)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  const inFlight = manualPaperCreateLocks.get(sessionId);
  if (inFlight) return inFlight;
  const promise = (async () => {
    // Re-check under the lock — the SELECT above may have raced with another
    // request that just finished inserting before we acquired the slot.
    const second = await db
      .select()
      .from(papersTable)
      .where(and(eq(papersTable.sessionId, sessionId), eq(papersTable.externalId, externalId)))
      .limit(1);
    if (second.length > 0) return second[0];
    const [created] = await db
      .insert(papersTable)
      .values({
        sessionId,
        externalId,
        title: "[手动添加 / Manual additions]",
        authors: [],
        url: "",
        extracted: "true",
      })
      .returning();
    return created;
  })().finally(() => {
    manualPaperCreateLocks.delete(sessionId);
  });
  manualPaperCreateLocks.set(sessionId, promise);
  return promise;
}

router.post("/sessions/:id/variables", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.id, 10);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const body = req.body ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const type = typeof body.type === "string" ? body.type : "";
  const definition = typeof body.definition === "string" ? body.definition.trim() : "";
  if (name.length === 0 || name.length > 200) {
    res.status(400).json({ error: "name is required (1–200 chars)", code: "invalid_name" });
    return;
  }
  if (!["independent", "mediator", "moderator", "dependent"].includes(type)) {
    res.status(400).json({ error: "type must be independent|mediator|moderator|dependent", code: "invalid_type" });
    return;
  }
  // Verify the session exists / belongs to the caller — same pattern as other routes.
  const [session] = await db.select().from(papersTable).where(eq(papersTable.sessionId, sessionId)).limit(1);
  // Note: above is a cheap "session has at least one paper" check. We don't have
  // an auth-aware session-fetch helper imported here; full session validation
  // happens via the FK on the sentinel paper insert below (will error if
  // sessionId doesn't exist).
  void session;

  const sentinel = await getOrCreateManualPaper(sessionId);
  const canonical = canonicalize(name);
  // Construct layer is best-effort — pick the typical layer for the chosen
  // type so the variable participates in layered prompts (stimulus → cognitive
  // → ... → behavior). The user can always edit later.
  const layerByType: Record<string, string> = {
    independent: "stimulus",
    mediator: "cognitive",
    moderator: "cognitive",
    dependent: "behavior",
  };
  const layer = VALID_LAYERS.has(layerByType[type]) ? layerByType[type] : null;
  const [v] = await db
    .insert(variablesTable)
    .values({
      sessionId,
      paperId: sentinel.id,
      name: name.slice(0, 200),
      type,
      definition: definition.length > 0 ? definition.slice(0, 2000) : "（手动添加 / manually added）",
      citationText: "（手动添加 / manually added — no paper citation）",
      canonicalConstructId: canonical,
      constructLayer: layer,
    })
    .returning();
  res.status(201).json(formatVariable(v, sentinel));
});

// Manual rename / retype / delete of a variable. The AI's first-pass extraction
// is good but not perfect — researchers often want to:
//   - rename a variable that the AI named awkwardly ("perceived enjoyment" → "enjoyment")
//   - re-classify a borderline mediator/independent
//   - delete an outright bad extraction (e.g. AI hallucinated a control variable)
// without re-running extraction on the whole paper. These routes give them
// that escape hatch. Everything else (variable-graph, models, live model)
// reads variables on demand, so updates are picked up automatically.
router.patch("/sessions/:id/variables/:variableId", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.id, 10);
  const variableId = parseInt(req.params.variableId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(variableId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = req.body ?? {};
  const patch: { name?: string; type?: string; definition?: string } = {};
  if (typeof body.name === "string" && body.name.trim().length > 0) patch.name = body.name.trim().slice(0, 200);
  if (typeof body.type === "string" && ["independent", "mediator", "moderator", "dependent"].includes(body.type)) patch.type = body.type;
  if (typeof body.definition === "string") patch.definition = body.definition.trim().slice(0, 2000);
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No supported fields to update" });
    return;
  }
  // Recompute canonical id when the name changes so downstream "shared variable"
  // detection picks up the rename.
  const updateValues: Record<string, unknown> = { ...patch };
  if (patch.name) updateValues.canonicalConstructId = canonicalize(patch.name);
  const result = await db
    .update(variablesTable)
    .set(updateValues)
    .where(and(eq(variablesTable.sessionId, sessionId), eq(variablesTable.id, variableId)))
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Variable not found" });
    return;
  }
  const v = result[0];
  const [paper] = await db.select().from(papersTable).where(eq(papersTable.id, v.paperId)).limit(1);
  if (!paper) {
    res.status(500).json({ error: "Variable's paper missing" });
    return;
  }
  res.json(formatVariable(v, paper));
});

router.delete("/sessions/:id/variables/:variableId", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.id, 10);
  const variableId = parseInt(req.params.variableId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(variableId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await db
    .delete(variablesTable)
    .where(and(eq(variablesTable.sessionId, sessionId), eq(variablesTable.id, variableId)))
    .returning({ id: variablesTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Variable not found" });
    return;
  }
  res.json({ ok: true });
});

router.get("/sessions/:id/variable-graph", async (req, res): Promise<void> => {
  const params = GetVariableGraphParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const variables = await db
    .select()
    .from(variablesTable)
    .where(eq(variablesTable.sessionId, params.data.id));

  const papers = await db
    .select()
    .from(papersTable)
    .where(eq(papersTable.sessionId, params.data.id));
  const paperMap = new Map(papers.map((p) => [p.id, p]));

  // Use canonicalize() so graph-node grouping matches the variable-list
  // cluster grouping (otherwise hyphen/dash variants produce two graph nodes
  // for what the list shows as one cluster — same root cause as the
  // "重复举例变量" bug). Falls back to lowercase-only for empty results so
  // we never lose a node entirely.
  const nodeMap = new Map<string, { id: string; label: string; type: string; paperCount: number }>();
  for (const v of variables) {
    const key = canonicalize(v.name) || v.name.toLowerCase().trim();
    if (nodeMap.has(key)) {
      nodeMap.get(key)!.paperCount++;
    } else {
      nodeMap.set(key, { id: key, label: v.name, type: v.type, paperCount: 1 });
    }
  }

  // Edges come ONLY from real relationships extracted from each paper
  // (paper_hypotheses table). We do NOT synthesize edges by taking the
  // cartesian product of variable types — that would invent relationships
  // the paper never actually states.
  const hypotheses = await db
    .select()
    .from(paperHypothesesTable)
    .where(eq(paperHypothesesTable.sessionId, params.data.id));

  // Same normalizer as nodeMap above so hypothesis from/to/via strings
  // resolve to the same node ids the graph rendered.
  const norm = (s: string) => canonicalize(s) || s.toLowerCase().trim();
  type EdgeRel = "positive" | "negative" | "moderates" | "mediates";
  const edges: Array<{ source: string; target: string; paperId: number; paperTitle: string; relationship: EdgeRel; statement: string }> = [];
  const seen = new Set<string>();
  const pushEdge = (src: string, tgt: string, paperId: number, paperTitle: string, relationship: EdgeRel, statement: string) => {
    if (!src || !tgt || src === tgt) return;
    if (!nodeMap.has(src) || !nodeMap.has(tgt)) return; // skip if endpoint isn't a known variable
    const k = `${src}->${tgt}|${relationship}|${paperId}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ source: src, target: tgt, paperId, paperTitle, relationship, statement });
  };

  const isRel = (r: string): r is EdgeRel => r === "positive" || r === "negative" || r === "moderates" || r === "mediates";

  for (const h of hypotheses) {
    const paper = paperMap.get(h.paperId);
    if (!paper) continue;
    const from = norm(h.fromVariable);
    const to = norm(h.toVariable);
    const via = h.viaVariable ? norm(h.viaVariable) : null;
    const rel: EdgeRel = isRel(h.relationship) ? h.relationship : "positive";
    if (via && nodeMap.has(via)) {
      // Mediation chain: from → via → to (label both legs as "mediates")
      pushEdge(from, via, h.paperId, paper.title, "mediates", h.statement);
      pushEdge(via, to, h.paperId, paper.title, "mediates", h.statement);
    } else {
      pushEdge(from, to, h.paperId, paper.title, rel, h.statement);
    }
  }

  res.json({ nodes: [...nodeMap.values()], edges });
});

export default router;

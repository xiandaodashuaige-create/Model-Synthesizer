import { Router, type IRouter } from "express";
import { eq, and, or, inArray, sql } from "drizzle-orm";
import {
  db,
  liveModelsTable,
  liveModelNodesTable,
  liveModelEdgesTable,
  variablesTable,
  papersTable,
  researchModelsTable,
  sessionsTable,
  modelVersionsTable,
} from "@workspace/db";
import { desc } from "drizzle-orm";
import { findEvidenceForModel, importWebPaper, makeEdgeKey, type EdgeInput } from "../lib/evidence-matching.js";

const router: IRouter = Router();

// PostgreSQL unique-violation SQLSTATE
const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

// --- helpers ---------------------------------------------------------------

// Race-safe lazy create: ON CONFLICT DO NOTHING then SELECT.
async function getOrCreateLiveModel(sessionId: number) {
  await db.insert(liveModelsTable).values({ sessionId }).onConflictDoNothing({ target: liveModelsTable.sessionId });
  const [row] = await db.select().from(liveModelsTable).where(eq(liveModelsTable.sessionId, sessionId)).limit(1);
  if (!row) throw new Error("failed to create live model");
  return row;
}

async function loadLiveModelDetail(sessionId: number) {
  const liveModel = await getOrCreateLiveModel(sessionId);

  const nodeRows = await db
    .select({
      id: liveModelNodesTable.id,
      variableId: liveModelNodesTable.variableId,
      sourceModelId: liveModelNodesTable.sourceModelId,
      userAdded: liveModelNodesTable.userAdded,
      positionX: liveModelNodesTable.positionX,
      positionY: liveModelNodesTable.positionY,
      createdAt: liveModelNodesTable.createdAt,
      variableName: variablesTable.name,
      variableType: variablesTable.type,
      paperId: variablesTable.paperId,
    })
    .from(liveModelNodesTable)
    .leftJoin(variablesTable, eq(liveModelNodesTable.variableId, variablesTable.id))
    .where(eq(liveModelNodesTable.liveModelId, liveModel.id));

  const edgeRows = await db
    .select({
      id: liveModelEdgesTable.id,
      fromVariableId: liveModelEdgesTable.fromVariableId,
      toVariableId: liveModelEdgesTable.toVariableId,
      relationship: liveModelEdgesTable.relationship,
      provenancePaperId: liveModelEdgesTable.provenancePaperId,
      provenanceCitationText: liveModelEdgesTable.provenanceCitationText,
      provenanceFigureThumbnailUrl: liveModelEdgesTable.provenanceFigureThumbnailUrl,
      provenanceFigureSourceUrl: liveModelEdgesTable.provenanceFigureSourceUrl,
      provenanceFigureSourceDomain: liveModelEdgesTable.provenanceFigureSourceDomain,
      confidence: liveModelEdgesTable.confidence,
      sourceModelId: liveModelEdgesTable.sourceModelId,
      userAdded: liveModelEdgesTable.userAdded,
      moderatesEdgeId: liveModelEdgesTable.moderatesEdgeId,
      additionalEvidence: liveModelEdgesTable.additionalEvidence,
      createdAt: liveModelEdgesTable.createdAt,
    })
    .from(liveModelEdgesTable)
    .where(eq(liveModelEdgesTable.liveModelId, liveModel.id));

  // Resolve variable names for edge endpoints (may not yet be in nodes table if dangling)
  const varIds = new Set<number>();
  edgeRows.forEach((e) => { varIds.add(e.fromVariableId); varIds.add(e.toVariableId); });
  const paperIds = new Set<number>();
  edgeRows.forEach((e) => { if (e.provenancePaperId) paperIds.add(e.provenancePaperId); });

  const varNameById = new Map<number, string>();
  if (varIds.size > 0) {
    const vs = await db.select({ id: variablesTable.id, name: variablesTable.name })
      .from(variablesTable).where(inArray(variablesTable.id, [...varIds]));
    vs.forEach((v) => varNameById.set(v.id, v.name));
  }

  const paperTitleById = new Map<number, string>();
  if (paperIds.size > 0) {
    const ps = await db.select({ id: papersTable.id, title: papersTable.title })
      .from(papersTable).where(inArray(papersTable.id, [...paperIds]));
    ps.forEach((p) => paperTitleById.set(p.id, p.title));
  }

  const nodes = nodeRows.map((n) => ({
    id: n.id,
    variableId: n.variableId,
    variableName: n.variableName ?? `#${n.variableId}`,
    variableType: n.variableType ?? "independent",
    paperId: n.paperId ?? 0,
    sourceModelId: n.sourceModelId,
    userAdded: n.userAdded,
    positionX: n.positionX,
    positionY: n.positionY,
    createdAt: n.createdAt.toISOString(),
  }));

  const edges = edgeRows.map((e) => {
    const hasProvenance = !!(e.provenancePaperId && e.provenanceCitationText);
    return {
      id: e.id,
      fromVariableId: e.fromVariableId,
      toVariableId: e.toVariableId,
      fromVariableName: varNameById.get(e.fromVariableId) ?? `#${e.fromVariableId}`,
      toVariableName: varNameById.get(e.toVariableId) ?? `#${e.toVariableId}`,
      relationship: e.relationship,
      provenancePaperId: e.provenancePaperId,
      provenancePaperTitle: e.provenancePaperId ? paperTitleById.get(e.provenancePaperId) ?? null : null,
      provenanceCitationText: e.provenanceCitationText,
      provenanceFigureThumbnailUrl: e.provenanceFigureThumbnailUrl,
      provenanceFigureSourceUrl: e.provenanceFigureSourceUrl,
      provenanceFigureSourceDomain: e.provenanceFigureSourceDomain,
      confidence: e.confidence,
      sourceModelId: e.sourceModelId,
      userAdded: e.userAdded,
      moderatesEdgeId: e.moderatesEdgeId,
      hasProvenance,
      additionalEvidence: (e.additionalEvidence as unknown as unknown[]) ?? [],
      createdAt: e.createdAt.toISOString(),
    };
  });

  const unsupportedEdgeCount = edges.filter((e) => !e.hasProvenance).length;

  return {
    liveModel: {
      id: liveModel.id,
      sessionId: liveModel.sessionId,
      notes: liveModel.notes,
      version: liveModel.version,
      createdAt: liveModel.createdAt.toISOString(),
      updatedAt: liveModel.updatedAt.toISOString(),
    },
    nodes,
    edges,
    unsupportedEdgeCount,
  };
}

async function ensureSessionExists(sessionId: number): Promise<boolean> {
  const r = await db.select({ id: sessionsTable.id }).from(sessionsTable).where(eq(sessionsTable.id, sessionId)).limit(1);
  return !!r[0];
}

// --- routes ----------------------------------------------------------------

router.get("/sessions/:id/live-model", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ error: "invalid session id" });
  if (!(await ensureSessionExists(sessionId))) return res.status(404).json({ error: "session not found" });
  const detail = await loadLiveModelDetail(sessionId);
  return res.json(detail);
});

router.post("/sessions/:id/live-model/nodes", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ error: "invalid session id" });
  const variableId = Number(req.body?.variableId);
  if (!Number.isFinite(variableId)) return res.status(400).json({ error: "variableId required" });
  const sourceModelId = req.body?.sourceModelId != null ? Number(req.body.sourceModelId) : null;
  const userAdded = Boolean(req.body?.userAdded);

  // Validate variable belongs to this session
  const v = await db.select({ id: variablesTable.id, sessionId: variablesTable.sessionId })
    .from(variablesTable).where(eq(variablesTable.id, variableId)).limit(1);
  if (!v[0] || v[0].sessionId !== sessionId) {
    return res.status(400).json({ error: "variable does not belong to this session" });
  }

  // Validate sourceModelId session-scope if provided
  if (sourceModelId != null) {
    const m = await db.select({ id: researchModelsTable.id, sessionId: researchModelsTable.sessionId })
      .from(researchModelsTable).where(eq(researchModelsTable.id, sourceModelId)).limit(1);
    if (!m[0] || m[0].sessionId !== sessionId) {
      return res.status(400).json({ error: "sourceModelId does not belong to this session" });
    }
  }

  await db.transaction(async (tx) => {
    await tx.insert(liveModelsTable).values({ sessionId }).onConflictDoNothing({ target: liveModelsTable.sessionId });
    const [liveModel] = await tx.select().from(liveModelsTable).where(eq(liveModelsTable.sessionId, sessionId)).limit(1);
    await tx.insert(liveModelNodesTable).values({
      liveModelId: liveModel.id, variableId, sourceModelId, userAdded,
    }).onConflictDoNothing();
    await tx.update(liveModelsTable)
      .set({ version: sql`${liveModelsTable.version} + 1`, updatedAt: new Date() })
      .where(eq(liveModelsTable.id, liveModel.id));
  });

  const detail = await loadLiveModelDetail(sessionId);
  return res.json(detail);
});

router.delete("/sessions/:id/live-model/nodes/:nodeId", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const nodeId = parseInt(req.params.nodeId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(nodeId)) return res.status(400).json({ error: "invalid id" });

  const liveModel = await getOrCreateLiveModel(sessionId);
  const node = await db.select().from(liveModelNodesTable)
    .where(and(eq(liveModelNodesTable.id, nodeId), eq(liveModelNodesTable.liveModelId, liveModel.id))).limit(1);
  if (!node[0]) return res.status(404).json({ error: "node not found in this session's live model" });

  await db.transaction(async (tx) => {
    await tx.delete(liveModelEdgesTable).where(and(
      eq(liveModelEdgesTable.liveModelId, liveModel.id),
      or(
        eq(liveModelEdgesTable.fromVariableId, node[0].variableId),
        eq(liveModelEdgesTable.toVariableId, node[0].variableId),
      ),
    ));
    await tx.delete(liveModelNodesTable).where(eq(liveModelNodesTable.id, nodeId));
    await tx.update(liveModelsTable)
      .set({ version: sql`${liveModelsTable.version} + 1`, updatedAt: new Date() })
      .where(eq(liveModelsTable.id, liveModel.id));
  });

  const detail = await loadLiveModelDetail(sessionId);
  return res.json(detail);
});

// Drag-to-reposition: update the canvas (x,y) of a single live-model node.
// Lightweight — debounced/throttled by the client. Bumps the live-model version
// counter so other tabs notice the change on next refresh.
router.patch("/sessions/:id/live-model/nodes/:nodeId", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const nodeId = parseInt(req.params.nodeId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(nodeId)) return res.status(400).json({ error: "invalid id" });

  const positionX = Number(req.body?.positionX);
  const positionY = Number(req.body?.positionY);
  if (!Number.isFinite(positionX) || !Number.isFinite(positionY)) {
    return res.status(400).json({ error: "positionX and positionY (numbers) required" });
  }

  const liveModel = await getOrCreateLiveModel(sessionId);
  const [node] = await db.select().from(liveModelNodesTable)
    .where(and(eq(liveModelNodesTable.id, nodeId), eq(liveModelNodesTable.liveModelId, liveModel.id))).limit(1);
  if (!node) return res.status(404).json({ error: "node not found in this session's live model" });

  await db.transaction(async (tx) => {
    await tx.update(liveModelNodesTable)
      .set({ positionX, positionY })
      .where(eq(liveModelNodesTable.id, nodeId));
    await tx.update(liveModelsTable)
      .set({ version: sql`${liveModelsTable.version} + 1`, updatedAt: new Date() })
      .where(eq(liveModelsTable.id, liveModel.id));
  });

  const detail = await loadLiveModelDetail(sessionId);
  return res.json(detail);
});

router.post("/sessions/:id/live-model/edges", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ error: "invalid session id" });
  const fromVariableId = Number(req.body?.fromVariableId);
  const toVariableId = Number(req.body?.toVariableId);
  const relationship = String(req.body?.relationship ?? "");
  const allowedRel = new Set(["positive", "negative", "mediates", "moderates"]);
  if (!Number.isFinite(fromVariableId) || !Number.isFinite(toVariableId) || !allowedRel.has(relationship)) {
    return res.status(400).json({ error: "fromVariableId, toVariableId, valid relationship required" });
  }
  if (fromVariableId === toVariableId) return res.status(400).json({ error: "self-loops not allowed" });

  const provenancePaperId = req.body?.provenancePaperId != null ? Number(req.body.provenancePaperId) : null;
  const provenanceCitationText = req.body?.provenanceCitationText ?? null;
  const userAdded = Boolean(req.body?.userAdded);
  const sourceModelId = req.body?.sourceModelId != null ? Number(req.body.sourceModelId) : null;
  const moderatesEdgeId = req.body?.moderatesEdgeId != null ? Number(req.body.moderatesEdgeId) : null;
  if (moderatesEdgeId != null && relationship !== "moderates") {
    return res.status(400).json({ error: "moderatesEdgeId only valid when relationship=moderates" });
  }

  if (!userAdded && (!provenancePaperId || !provenanceCitationText)) {
    return res.status(400).json({
      error: "Edge requires provenance (provenancePaperId + provenanceCitationText) OR userAdded=true",
    });
  }

  const vs = await db.select({ id: variablesTable.id, sessionId: variablesTable.sessionId })
    .from(variablesTable).where(inArray(variablesTable.id, [fromVariableId, toVariableId]));
  if (vs.length !== 2 || vs.some((v) => v.sessionId !== sessionId)) {
    return res.status(400).json({ error: "both variables must belong to this session" });
  }

  if (provenancePaperId != null) {
    const p = await db.select({ id: papersTable.id, sessionId: papersTable.sessionId })
      .from(papersTable).where(eq(papersTable.id, provenancePaperId)).limit(1);
    if (!p[0] || p[0].sessionId !== sessionId) {
      return res.status(400).json({ error: "provenancePaperId does not belong to this session" });
    }
  }
  if (sourceModelId != null) {
    const m = await db.select({ id: researchModelsTable.id, sessionId: researchModelsTable.sessionId })
      .from(researchModelsTable).where(eq(researchModelsTable.id, sourceModelId)).limit(1);
    if (!m[0] || m[0].sessionId !== sessionId) {
      return res.status(400).json({ error: "sourceModelId does not belong to this session" });
    }
  }

  // Pre-check duplicates outside the transaction so we can return 409 instead of
  // raising a unique-constraint error. The DB unique index is still the ultimate
  // guard against races, but this gives a friendlier message in the common case.
  const liveModel = await getOrCreateLiveModel(sessionId);
  const existing = await db.select({ id: liveModelEdgesTable.id })
    .from(liveModelEdgesTable)
    .where(and(
      eq(liveModelEdgesTable.liveModelId, liveModel.id),
      eq(liveModelEdgesTable.fromVariableId, fromVariableId),
      eq(liveModelEdgesTable.toVariableId, toVariableId),
      eq(liveModelEdgesTable.relationship, relationship),
    ))
    .limit(1);
  if (existing[0]) {
    return res.status(409).json({ error: "duplicate edge: this relationship already exists in the live model", existingEdgeId: existing[0].id });
  }

  try {
    await db.transaction(async (tx) => {
      // Auto-add nodes if not present (UX: user can add an edge without first adding nodes)
      for (const vid of [fromVariableId, toVariableId]) {
        await tx.insert(liveModelNodesTable).values({
          liveModelId: liveModel.id, variableId: vid, userAdded,
        }).onConflictDoNothing();
      }

      // Validate moderated edge belongs to this live model.
      let validModeratesEdgeId: number | null = null;
      if (moderatesEdgeId != null) {
        const target = await tx.select({ id: liveModelEdgesTable.id })
          .from(liveModelEdgesTable)
          .where(and(eq(liveModelEdgesTable.id, moderatesEdgeId), eq(liveModelEdgesTable.liveModelId, liveModel.id)))
          .limit(1);
        if (target[0]) validModeratesEdgeId = target[0].id;
      }

      await tx.insert(liveModelEdgesTable).values({
        liveModelId: liveModel.id,
        fromVariableId,
        toVariableId,
        relationship,
        provenancePaperId,
        provenanceCitationText,
        provenanceFigureThumbnailUrl: req.body?.provenanceFigureThumbnailUrl ?? null,
        provenanceFigureSourceUrl: req.body?.provenanceFigureSourceUrl ?? null,
        provenanceFigureSourceDomain: req.body?.provenanceFigureSourceDomain ?? null,
        confidence: ["high", "medium", "low"].includes(req.body?.confidence) ? req.body.confidence : "medium",
        sourceModelId,
        userAdded,
        moderatesEdgeId: validModeratesEdgeId,
      });
      await tx.update(liveModelsTable)
        .set({ version: sql`${liveModelsTable.version} + 1`, updatedAt: new Date() })
        .where(eq(liveModelsTable.id, liveModel.id));
    });
  } catch (err) {
    // Race: another concurrent insert beat us to it. Map the unique-violation to
    // the same 409 we'd have returned in the pre-check.
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: "duplicate edge: this relationship already exists in the live model" });
    }
    throw err;
  }

  const detail = await loadLiveModelDetail(sessionId);
  return res.json(detail);
});

router.delete("/sessions/:id/live-model/edges/:edgeId", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const edgeId = parseInt(req.params.edgeId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(edgeId)) return res.status(400).json({ error: "invalid id" });

  const liveModel = await getOrCreateLiveModel(sessionId);
  const e = await db.select().from(liveModelEdgesTable)
    .where(and(eq(liveModelEdgesTable.id, edgeId), eq(liveModelEdgesTable.liveModelId, liveModel.id))).limit(1);
  if (!e[0]) return res.status(404).json({ error: "edge not found in this session's live model" });

  await db.transaction(async (tx) => {
    await tx.delete(liveModelEdgesTable).where(eq(liveModelEdgesTable.id, edgeId));
    await tx.update(liveModelsTable)
      .set({ version: sql`${liveModelsTable.version} + 1`, updatedAt: new Date() })
      .where(eq(liveModelsTable.id, liveModel.id));
  });

  const detail = await loadLiveModelDetail(sessionId);
  return res.json(detail);
});

router.post("/sessions/:id/live-model/import-from-model", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ error: "invalid session id" });
  const modelId = Number(req.body?.modelId);
  if (!Number.isFinite(modelId)) return res.status(400).json({ error: "modelId required" });
  const replace = Boolean(req.body?.replace);

  const m = await db.select().from(researchModelsTable).where(eq(researchModelsTable.id, modelId)).limit(1);
  if (!m[0]) return res.status(404).json({ error: "model not found" });
  if (m[0].sessionId !== sessionId) return res.status(400).json({ error: "model does not belong to this session" });

  const sourceNodes = (m[0].nodes as Array<{
    variableId: number; variableName?: string; type?: string; paperId?: number;
  }>) ?? [];
  const sourceEdges = (m[0].edges as Array<{
    fromVariableId: number; toVariableId: number; relationship: string;
    fromVariableName?: string; toVariableName?: string;
    evidencePaperId?: number; evidenceCitationText?: string;
    // P0 fix: AI-generated edges with relationship="moderates" carry a
    // moderatedEdge pointer naming the A→B causal path being conditioned.
    // We must preserve this so the canvas can route the moderator's arrow
    // tip to the midpoint of the moderated path (otherwise it renders as
    // "moderator → DV", which is semantically wrong per Hard Rule #12).
    moderatedEdge?: { fromVariableId?: number; toVariableId?: number } | null;
  }>) ?? [];

  // Build a remap from the model's stored variableIds → currently-existing variable IDs in this session.
  // Generated models can carry stale IDs (the variables row was deleted/re-extracted) but the names
  // typically still match a current variable, so we recover by case-insensitive name lookup.
  const sessionVars = await db.select({ id: variablesTable.id, name: variablesTable.name })
    .from(variablesTable).where(eq(variablesTable.sessionId, sessionId));
  const liveIdSet = new Set(sessionVars.map((v) => v.id));
  const nameToId = new Map(sessionVars.map((v) => [v.name.trim().toLowerCase(), v.id] as const));

  const resolve = (id: number, name?: string): number | null => {
    if (Number.isFinite(id) && liveIdSet.has(id)) return id;
    if (name) {
      const found = nameToId.get(name.trim().toLowerCase());
      if (found != null) return found;
    }
    return null;
  };

  let skippedNodes = 0;
  let skippedEdges = 0;

  await db.transaction(async (tx) => {
    await tx.insert(liveModelsTable).values({ sessionId }).onConflictDoNothing({ target: liveModelsTable.sessionId });
    const [liveModel] = await tx.select().from(liveModelsTable).where(eq(liveModelsTable.sessionId, sessionId)).limit(1);

    if (replace) {
      await tx.delete(liveModelEdgesTable).where(eq(liveModelEdgesTable.liveModelId, liveModel.id));
      await tx.delete(liveModelNodesTable).where(eq(liveModelNodesTable.liveModelId, liveModel.id));
    }

    // Insert all nodes (idempotent via unique index)
    for (const n of sourceNodes) {
      const vid = resolve(n.variableId, n.variableName);
      if (vid == null) { skippedNodes++; continue; }
      await tx.insert(liveModelNodesTable).values({
        liveModelId: liveModel.id,
        variableId: vid,
        sourceModelId: modelId,
        userAdded: false,
      }).onConflictDoNothing();
    }

    // Dedup against ALL existing edges in this live model, regardless of source model.
    // Previously this filtered by `sourceModelId`, which meant user-added edges
    // (sourceModelId=null) and edges imported from a different source model would
    // never match — so calling "作为我的研究模型基础" (replace=false) repeatedly, or
    // mixing manual edits with imports, silently created duplicates. The DB-level
    // unique index on (liveModelId, from, to, rel) is the ultimate guard, but we
    // also skip in app code to avoid burning sequence ids and to keep the
    // skippedEdges count meaningful.
    const existingEdges = await tx.select({
      fromVariableId: liveModelEdgesTable.fromVariableId,
      toVariableId: liveModelEdgesTable.toVariableId,
      relationship: liveModelEdgesTable.relationship,
    }).from(liveModelEdgesTable).where(eq(liveModelEdgesTable.liveModelId, liveModel.id));
    const existingKey = new Set(existingEdges.map((e) =>
      `${e.fromVariableId}->${e.toVariableId}:${e.relationship}`));

    // P0 FIX — TWO-PASS edge insert so moderator edges can name the live
    // edge they condition. Pass 1: insert every non-moderator edge so they
    // are guaranteed to exist in the DB when pass 2 looks them up. Pass 2:
    // resolve each moderator edge's `moderatedEdge.{from,to}VariableId`
    // against the post-pass-1 edge set, then insert the moderator with
    // moderatesEdgeId pointing at the matching row id. Without this the
    // canvas renders "moderator → DV" instead of routing the arrow tip to
    // the midpoint of the conditioned A→B path.
    const moderatorEdges: Array<typeof sourceEdges[number] & { _fromId: number; _toId: number }> = [];
    for (const e of sourceEdges) {
      const fromId = resolve(e.fromVariableId, e.fromVariableName);
      const toId = resolve(e.toVariableId, e.toVariableName);
      if (fromId == null || toId == null) { skippedEdges++; continue; }
      if (e.relationship === "moderates") {
        // Defer until pass 2 so the path it points at is already inserted.
        moderatorEdges.push({ ...e, _fromId: fromId, _toId: toId });
        continue;
      }
      const key = `${fromId}->${toId}:${e.relationship}`;
      if (existingKey.has(key)) { skippedEdges++; continue; }
      existingKey.add(key); // guard against duplicates within sourceEdges itself
      await tx.insert(liveModelEdgesTable).values({
        liveModelId: liveModel.id,
        fromVariableId: fromId,
        toVariableId: toId,
        relationship: e.relationship,
        provenancePaperId: e.evidencePaperId ?? null,
        provenanceCitationText: e.evidenceCitationText ?? null,
        sourceModelId: modelId,
        userAdded: false,
        confidence: "medium",
      }).onConflictDoNothing({
        target: [liveModelEdgesTable.liveModelId, liveModelEdgesTable.fromVariableId, liveModelEdgesTable.toVariableId, liveModelEdgesTable.relationship],
      });
    }

    // Pass 2 — moderator edges. Re-query the live edges so we see both the
    // ones we just inserted and any pre-existing ones (when replace=false).
    if (moderatorEdges.length > 0) {
      const allEdges = await tx.select({
        id: liveModelEdgesTable.id,
        fromVariableId: liveModelEdgesTable.fromVariableId,
        toVariableId: liveModelEdgesTable.toVariableId,
        relationship: liveModelEdgesTable.relationship,
      }).from(liveModelEdgesTable).where(eq(liveModelEdgesTable.liveModelId, liveModel.id));
      const idByPath = new Map<string, number>();
      // Deterministic resolution when the same variable pair has multiple
      // non-moderator edges (e.g. both 'positive' and 'mediates'): the AI
      // moderator pointer carries only {from, to} variable ids, never the
      // relationship type, so we cannot disambiguate from the source side.
      // We therefore (a) sort edges by id ascending — pass-1 inserts in
      // source order, so smallest id ≈ first sourceEdges occurrence —
      // and (b) keep only the lowest id per pair. Result is fully
      // reproducible across imports of the same source model.
      const sortedAll = [...allEdges].sort((a, b) => a.id - b.id);
      for (const ee of sortedAll) {
        if (ee.relationship === "moderates") continue; // moderators don't moderate moderators
        const k = `${ee.fromVariableId}->${ee.toVariableId}`;
        if (!idByPath.has(k)) idByPath.set(k, ee.id);
      }
      for (const e of moderatorEdges) {
        const key = `${e._fromId}->${e._toId}:moderates`;
        if (existingKey.has(key)) { skippedEdges++; continue; }
        // Resolve the moderated path via remap (source variableIds → live ids).
        let moderatesEdgeId: number | null = null;
        const me = e.moderatedEdge;
        if (me?.fromVariableId != null && me?.toVariableId != null) {
          const meFrom = resolve(me.fromVariableId);
          const meTo = resolve(me.toVariableId);
          if (meFrom != null && meTo != null) {
            moderatesEdgeId = idByPath.get(`${meFrom}->${meTo}`) ?? null;
          }
        }
        existingKey.add(key);
        await tx.insert(liveModelEdgesTable).values({
          liveModelId: liveModel.id,
          fromVariableId: e._fromId,
          toVariableId: e._toId,
          relationship: "moderates",
          provenancePaperId: e.evidencePaperId ?? null,
          provenanceCitationText: e.evidenceCitationText ?? null,
          sourceModelId: modelId,
          userAdded: false,
          confidence: "medium",
          moderatesEdgeId,
        }).onConflictDoNothing({
          target: [liveModelEdgesTable.liveModelId, liveModelEdgesTable.fromVariableId, liveModelEdgesTable.toVariableId, liveModelEdgesTable.relationship],
        });
      }
    }

    await tx.update(liveModelsTable)
      .set({ version: sql`${liveModelsTable.version} + 1`, updatedAt: new Date() })
      .where(eq(liveModelsTable.id, liveModel.id));
  });

  if (skippedNodes > 0 || skippedEdges > 0) {
    req.log.warn({ modelId, sessionId, skippedNodes, skippedEdges }, "import-from-model skipped some items");
  }

  const detail = await loadLiveModelDetail(sessionId);
  return res.json({ ...detail, skippedNodes, skippedEdges });
});

// ============================================================================
// Smart evidence matching (live model)
// ============================================================================

type LiveAddEvidence = {
  paperId: number;
  paperTitle: string;
  paperAuthors: string[];
  paperYear: number | null;
  citationText: string;
  source: "library" | "web";
  score: number | null;
  addedAt: string;
};

router.post("/sessions/:id/live-model/evidence-search", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ error: "invalid session id" });
  if (!(await ensureSessionExists(sessionId))) return res.status(404).json({ error: "session not found" });
  const detail = await loadLiveModelDetail(sessionId);
  const body = (req.body ?? {}) as {
    scopes?: Array<"library" | "web" | "scholar">;
    granularity?: Array<"overall" | "per-edge">;
    instructions?: string | null;
    focusEdgeKey?: string | null;
    includeImages?: boolean | null;
  };
  const scopes: Array<"library" | "web" | "scholar"> = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : ["library", "web"];
  const granularity: Array<"overall" | "per-edge"> = Array.isArray(body.granularity) && body.granularity.length > 0 ? body.granularity : ["overall", "per-edge"];

  const edges: EdgeInput[] = detail.edges.map((e) => ({
    edgeKey: makeEdgeKey(e.fromVariableId, e.toVariableId, e.relationship),
    fromVariableId: e.fromVariableId,
    toVariableId: e.toVariableId,
    fromVariableName: e.fromVariableName,
    toVariableName: e.toVariableName,
    relationship: e.relationship,
  }));
  const summary = `Live model with ${detail.nodes.length} variables and ${detail.edges.length} relationships.\nVariables: ${detail.nodes.map((n) => `${n.variableName} [${n.variableType}]`).join(", ")}\nRelationships: ${detail.edges.map((e) => `${e.fromVariableName} --${e.relationship}--> ${e.toVariableName}`).join("; ")}`;

  try {
    const result = await findEvidenceForModel({
      sessionId,
      edges,
      modelSummary: summary,
      options: {
        scopes,
        granularity,
        instructions: body.instructions ?? null,
        focusEdgeKey: body.focusEdgeKey ?? null,
        includeImages: body.includeImages ?? null,
      },
    });
    return res.json(result);
  } catch (err) {
    req.log.error({ err }, "live evidence search failed");
    return res.status(503).json({ error: "AI integration unavailable" });
  }
});

router.post("/sessions/:id/live-model/evidence-apply", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ error: "invalid session id" });
  if (!(await ensureSessionExists(sessionId))) return res.status(404).json({ error: "session not found" });
  const body = (req.body ?? {}) as {
    addPapers?: Array<{ externalId: string; title: string; authors?: string[]; year?: number | null; abstract?: string | null; url?: string | null }>;
    edgeAttachments?: Array<{ edgeKey: string; paperId?: number | null; externalId?: string | null; evidenceQuote: string }>;
    reason?: string | null;
  };

  // Snapshot current live model so revert works.
  const before = await loadLiveModelDetail(sessionId);
  await db.insert(modelVersionsTable).values({
    sessionId,
    kind: "live",
    modelId: before.liveModel.id,
    snapshot: before as unknown as Record<string, unknown>,
    reason: (body.reason ?? "evidence_apply").slice(0, 200),
  });

  // Import web papers.
  const externalToPaperId = new Map<string, number>();
  for (const p of body.addPapers ?? []) {
    if (!p?.externalId) continue;
    try {
      const id = await importWebPaper({
        sessionId,
        externalId: p.externalId,
        title: p.title,
        authors: p.authors ?? [],
        year: p.year ?? null,
        abstract: p.abstract ?? null,
        url: p.url ?? null,
      });
      externalToPaperId.set(p.externalId, id);
    } catch (err) {
      req.log.warn({ err, externalId: p.externalId }, "importWebPaper failed");
    }
  }

  // Resolve attachments to actual edge rows.
  const allPaperIds = new Set<number>();
  for (const a of body.edgeAttachments ?? []) {
    if (a.paperId) allPaperIds.add(a.paperId);
    else if (a.externalId && externalToPaperId.has(a.externalId)) allPaperIds.add(externalToPaperId.get(a.externalId)!);
  }
  const paperMeta = new Map<number, { title: string; authors: string[]; year: number | null }>();
  if (allPaperIds.size > 0) {
    const rows = await db.select().from(papersTable).where(eq(papersTable.sessionId, sessionId));
    for (const r of rows) {
      if (allPaperIds.has(r.id)) paperMeta.set(r.id, { title: r.title, authors: (r.authors as string[]) ?? [], year: r.year ?? null });
    }
  }

  const now = new Date().toISOString();
  // Group attachments by edgeKey so we update each edge once.
  const byKey = new Map<string, LiveAddEvidence[]>();
  for (const a of body.edgeAttachments ?? []) {
    if (!a?.evidenceQuote || !a.evidenceQuote.trim()) continue;
    let pid: number | null = a.paperId ?? null;
    if (!pid && a.externalId) pid = externalToPaperId.get(a.externalId) ?? null;
    if (!pid) continue;
    const meta = paperMeta.get(pid);
    if (!meta) continue;
    const list = byKey.get(a.edgeKey) ?? [];
    list.push({
      paperId: pid,
      paperTitle: meta.title,
      paperAuthors: meta.authors,
      paperYear: meta.year,
      citationText: a.evidenceQuote.slice(0, 1000),
      source: a.externalId && externalToPaperId.has(a.externalId) ? "web" : "library",
      score: null,
      addedAt: now,
    });
    byKey.set(a.edgeKey, list);
  }

  for (const e of before.edges) {
    const k = makeEdgeKey(e.fromVariableId, e.toVariableId, e.relationship);
    const additions = byKey.get(k);
    if (!additions || additions.length === 0) continue;
    const existing = (e.additionalEvidence as LiveAddEvidence[]) ?? [];
    const merged = [...existing];
    for (const add of additions) {
      if (merged.some((x) => x.paperId === add.paperId && x.citationText === add.citationText)) continue;
      merged.push(add);
    }
    await db
      .update(liveModelEdgesTable)
      .set({ additionalEvidence: merged as unknown as Record<string, unknown>[] })
      .where(eq(liveModelEdgesTable.id, e.id));
  }

  const after = await loadLiveModelDetail(sessionId);
  return res.json(after);
});

router.get("/sessions/:id/live-model/versions", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ error: "invalid session id" });
  if (!(await ensureSessionExists(sessionId))) return res.status(404).json({ error: "session not found" });
  const rows = await db
    .select()
    .from(modelVersionsTable)
    .where(and(eq(modelVersionsTable.sessionId, sessionId), eq(modelVersionsTable.kind, "live")))
    .orderBy(desc(modelVersionsTable.createdAt))
    .limit(50);
  const out = rows.map((v) => {
    const snap = (v.snapshot ?? {}) as { nodes?: unknown[]; edges?: unknown[] };
    return {
      id: v.id,
      kind: "live" as const,
      modelId: v.modelId,
      reason: v.reason,
      nodeCount: Array.isArray(snap.nodes) ? snap.nodes.length : 0,
      edgeCount: Array.isArray(snap.edges) ? snap.edges.length : 0,
      createdAt: v.createdAt.toISOString(),
    };
  });
  return res.json(out);
});

router.post("/sessions/:id/live-model/revert/:versionId", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const versionId = parseInt(req.params.versionId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(versionId)) return res.status(400).json({ error: "invalid id" });
  if (!(await ensureSessionExists(sessionId))) return res.status(404).json({ error: "session not found" });

  const [version] = await db.select().from(modelVersionsTable).where(eq(modelVersionsTable.id, versionId));
  if (!version || version.sessionId !== sessionId || version.kind !== "live") {
    return res.status(404).json({ error: "Version not found" });
  }

  // Snapshot current state first.
  const current = await loadLiveModelDetail(sessionId);
  await db.insert(modelVersionsTable).values({
    sessionId,
    kind: "live",
    modelId: current.liveModel.id,
    snapshot: current as unknown as Record<string, unknown>,
    reason: `pre_revert_to_v${versionId}`,
  });

  const snap = version.snapshot as {
    nodes?: Array<{ variableId: number; sourceModelId?: number | null; userAdded?: boolean; positionX?: number | null; positionY?: number | null }>;
    edges?: Array<{
      fromVariableId: number;
      toVariableId: number;
      relationship: string;
      provenancePaperId?: number | null;
      provenanceCitationText?: string | null;
      provenanceFigureThumbnailUrl?: string | null;
      provenanceFigureSourceUrl?: string | null;
      provenanceFigureSourceDomain?: string | null;
      confidence?: string;
      sourceModelId?: number | null;
      userAdded?: boolean;
      additionalEvidence?: unknown[];
    }>;
  };

  // Wipe and reinsert.
  await db.delete(liveModelEdgesTable).where(eq(liveModelEdgesTable.liveModelId, current.liveModel.id));
  await db.delete(liveModelNodesTable).where(eq(liveModelNodesTable.liveModelId, current.liveModel.id));

  for (const n of snap.nodes ?? []) {
    try {
      await db.insert(liveModelNodesTable).values({
        liveModelId: current.liveModel.id,
        variableId: n.variableId,
        sourceModelId: n.sourceModelId ?? null,
        userAdded: n.userAdded ?? false,
        positionX: n.positionX ?? null,
        positionY: n.positionY ?? null,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  for (const e of snap.edges ?? []) {
    try {
      await db.insert(liveModelEdgesTable).values({
        liveModelId: current.liveModel.id,
        fromVariableId: e.fromVariableId,
        toVariableId: e.toVariableId,
        relationship: e.relationship,
        provenancePaperId: e.provenancePaperId ?? null,
        provenanceCitationText: e.provenanceCitationText ?? null,
        provenanceFigureThumbnailUrl: e.provenanceFigureThumbnailUrl ?? null,
        provenanceFigureSourceUrl: e.provenanceFigureSourceUrl ?? null,
        provenanceFigureSourceDomain: e.provenanceFigureSourceDomain ?? null,
        confidence: e.confidence ?? "medium",
        sourceModelId: e.sourceModelId ?? null,
        userAdded: e.userAdded ?? false,
        additionalEvidence: (e.additionalEvidence as Record<string, unknown>[]) ?? [],
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  const after = await loadLiveModelDetail(sessionId);
  return res.json(after);
});

export default router;
// Re-export helper for tests / future composition
export { isUniqueViolation };

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
} from "@workspace/db";

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
      hasProvenance,
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

  await db.transaction(async (tx) => {
    await tx.insert(liveModelsTable).values({ sessionId }).onConflictDoNothing({ target: liveModelsTable.sessionId });
    const [liveModel] = await tx.select().from(liveModelsTable).where(eq(liveModelsTable.sessionId, sessionId)).limit(1);

    // Auto-add nodes if not present (UX: user can add an edge without first adding nodes)
    for (const vid of [fromVariableId, toVariableId]) {
      await tx.insert(liveModelNodesTable).values({
        liveModelId: liveModel.id, variableId: vid, userAdded,
      }).onConflictDoNothing();
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
    });
    await tx.update(liveModelsTable)
      .set({ version: sql`${liveModelsTable.version} + 1`, updatedAt: new Date() })
      .where(eq(liveModelsTable.id, liveModel.id));
  });

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
    evidencePaperId?: number; evidenceCitationText?: string;
  }>) ?? [];

  await db.transaction(async (tx) => {
    await tx.insert(liveModelsTable).values({ sessionId }).onConflictDoNothing({ target: liveModelsTable.sessionId });
    const [liveModel] = await tx.select().from(liveModelsTable).where(eq(liveModelsTable.sessionId, sessionId)).limit(1);

    if (replace) {
      await tx.delete(liveModelEdgesTable).where(eq(liveModelEdgesTable.liveModelId, liveModel.id));
      await tx.delete(liveModelNodesTable).where(eq(liveModelNodesTable.liveModelId, liveModel.id));
    }

    // Insert all nodes (idempotent via unique index)
    for (const n of sourceNodes) {
      if (!Number.isFinite(n.variableId)) continue;
      await tx.insert(liveModelNodesTable).values({
        liveModelId: liveModel.id,
        variableId: n.variableId,
        sourceModelId: modelId,
        userAdded: false,
      }).onConflictDoNothing();
    }

    // Skip pure duplicates against existing edges already imported from the same source model.
    const existingEdges = await tx.select({
      fromVariableId: liveModelEdgesTable.fromVariableId,
      toVariableId: liveModelEdgesTable.toVariableId,
      relationship: liveModelEdgesTable.relationship,
      sourceModelId: liveModelEdgesTable.sourceModelId,
    }).from(liveModelEdgesTable).where(eq(liveModelEdgesTable.liveModelId, liveModel.id));
    const existingKey = new Set(existingEdges.map((e) =>
      `${e.fromVariableId}->${e.toVariableId}:${e.relationship}:${e.sourceModelId ?? ""}`));

    for (const e of sourceEdges) {
      if (!Number.isFinite(e.fromVariableId) || !Number.isFinite(e.toVariableId)) continue;
      const key = `${e.fromVariableId}->${e.toVariableId}:${e.relationship}:${modelId}`;
      if (existingKey.has(key)) continue;
      await tx.insert(liveModelEdgesTable).values({
        liveModelId: liveModel.id,
        fromVariableId: e.fromVariableId,
        toVariableId: e.toVariableId,
        relationship: e.relationship,
        provenancePaperId: e.evidencePaperId ?? null,
        provenanceCitationText: e.evidenceCitationText ?? null,
        sourceModelId: modelId,
        userAdded: false,
        confidence: "medium",
      });
    }

    await tx.update(liveModelsTable)
      .set({ version: sql`${liveModelsTable.version} + 1`, updatedAt: new Date() })
      .where(eq(liveModelsTable.id, liveModel.id));
  });

  const detail = await loadLiveModelDetail(sessionId);
  return res.json(detail);
});

export default router;
// Re-export helper for tests / future composition
export { isUniqueViolation };

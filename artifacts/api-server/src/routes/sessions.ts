import { Router, type IRouter } from "express";
import { eq, sql, or, isNull, and } from "drizzle-orm";
import { db, sessionsTable, papersTable, variablesTable, researchModelsTable, constructRelationshipsTable } from "@workspace/db";
import {
  CreateSessionBody,
  GetSessionParams,
  UpdateSessionParams,
  UpdateSessionBody,
  DeleteSessionParams,
  GetSessionSummaryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/authMiddleware";

const router: IRouter = Router();

// Manual / custom variables are backed by a per-session sentinel paper with
// externalId starting with "manual:" (see routes/variables.ts). It must not
// be counted in the public "X 篇论文" counter, so every paper-count query in
// this file filters it out via this SQL fragment.
//
// Tangential papers (Phase 1 scope-check gate, see lib/paper-extraction.ts)
// are also excluded from the public corpus count: they remain visible in the
// papers list but produce no variables / hypotheses, so counting them would
// inflate "X 篇论文" with off-topic papers the AI explicitly rejected.
const NOT_MANUAL_PAPER = sql`${papersTable.externalId} NOT LIKE 'manual:%' AND ${papersTable.tangential} IS NOT TRUE`;

function buildSessionWithCounts(session: typeof sessionsTable.$inferSelect, paperCount: number, variableCount: number, modelCount: number) {
  return {
    ...session,
    paperCount,
    variableCount,
    modelCount,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

// Visibility rule: a logged-in user sees their own sessions plus any
// "legacy" rows whose userId is NULL (unclaimed pre-auth data). Mutation is
// only allowed when the row is owned by the user OR is unclaimed (in which
// case the mutation also stamps it with the user's id).
function visibilityFilter(userId: string) {
  return or(eq(sessionsTable.userId, userId), isNull(sessionsTable.userId));
}

router.get("/sessions", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const sessions = await db.select().from(sessionsTable).where(visibilityFilter(req.user!.id)).orderBy(sessionsTable.createdAt);

  const result = await Promise.all(
    sessions.map(async (session) => {
      const [paperCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(papersTable)
        .where(and(eq(papersTable.sessionId, session.id), NOT_MANUAL_PAPER));
      const [variableCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(variablesTable)
        .where(eq(variablesTable.sessionId, session.id));
      const [modelCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(researchModelsTable)
        .where(eq(researchModelsTable.sessionId, session.id));
      return buildSessionWithCounts(session, paperCount?.count ?? 0, variableCount?.count ?? 0, modelCount?.count ?? 0);
    })
  );

  res.json(result);
});

router.post("/sessions", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const parsed = CreateSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [session] = await db.insert(sessionsTable).values({ ...parsed.data, userId: req.user!.id }).returning();
  res.status(201).json(buildSessionWithCounts(session, 0, 0, 0));
});

router.get("/sessions/:id", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const params = GetSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [session] = await db.select().from(sessionsTable).where(and(eq(sessionsTable.id, params.data.id), visibilityFilter(req.user!.id)));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const [paperCount] = await db.select({ count: sql<number>`count(*)::int` }).from(papersTable).where(and(eq(papersTable.sessionId, session.id), NOT_MANUAL_PAPER));
  const [variableCount] = await db.select({ count: sql<number>`count(*)::int` }).from(variablesTable).where(eq(variablesTable.sessionId, session.id));
  const [modelCount] = await db.select({ count: sql<number>`count(*)::int` }).from(researchModelsTable).where(eq(researchModelsTable.sessionId, session.id));

  res.json(buildSessionWithCounts(session, paperCount?.count ?? 0, variableCount?.count ?? 0, modelCount?.count ?? 0));
});

router.patch("/sessions/:id", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const params = UpdateSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [session] = await db
    .update(sessionsTable)
    .set({ ...parsed.data, userId: req.user!.id })
    .where(and(eq(sessionsTable.id, params.data.id), visibilityFilter(req.user!.id)))
    .returning();

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const [paperCount] = await db.select({ count: sql<number>`count(*)::int` }).from(papersTable).where(and(eq(papersTable.sessionId, session.id), NOT_MANUAL_PAPER));
  const [variableCount] = await db.select({ count: sql<number>`count(*)::int` }).from(variablesTable).where(eq(variablesTable.sessionId, session.id));
  const [modelCount] = await db.select({ count: sql<number>`count(*)::int` }).from(researchModelsTable).where(eq(researchModelsTable.sessionId, session.id));

  res.json(buildSessionWithCounts(session, paperCount?.count ?? 0, variableCount?.count ?? 0, modelCount?.count ?? 0));
});

router.delete("/sessions/:id", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const params = DeleteSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [session] = await db.delete(sessionsTable).where(and(eq(sessionsTable.id, params.data.id), visibilityFilter(req.user!.id))).returning();
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.sendStatus(204);
});

router.get("/sessions/:id/summary", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const params = GetSessionSummaryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const sessionId = params.data.id;

  const [session] = await db.select().from(sessionsTable).where(and(eq(sessionsTable.id, sessionId), visibilityFilter(req.user!.id)));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const [paperCount] = await db.select({ count: sql<number>`count(*)::int` }).from(papersTable).where(and(eq(papersTable.sessionId, sessionId), NOT_MANUAL_PAPER));
  const [variableCount] = await db.select({ count: sql<number>`count(*)::int` }).from(variablesTable).where(eq(variablesTable.sessionId, sessionId));
  const [modelCount] = await db.select({ count: sql<number>`count(*)::int` }).from(researchModelsTable).where(eq(researchModelsTable.sessionId, sessionId));

  const [indepCount] = await db.select({ count: sql<number>`count(*)::int` }).from(variablesTable).where(sql`${variablesTable.sessionId} = ${sessionId} AND ${variablesTable.type} = 'independent'`);
  const [mediatorCount] = await db.select({ count: sql<number>`count(*)::int` }).from(variablesTable).where(sql`${variablesTable.sessionId} = ${sessionId} AND ${variablesTable.type} = 'mediator'`);
  const [moderatorCount] = await db.select({ count: sql<number>`count(*)::int` }).from(variablesTable).where(sql`${variablesTable.sessionId} = ${sessionId} AND ${variablesTable.type} = 'moderator'`);
  const [depCount] = await db.select({ count: sql<number>`count(*)::int` }).from(variablesTable).where(sql`${variablesTable.sessionId} = ${sessionId} AND ${variablesTable.type} = 'dependent'`);

  const selectedModel = await db
    .select()
    .from(researchModelsTable)
    .where(sql`${researchModelsTable.sessionId} = ${sessionId} AND ${researchModelsTable.selected} = 'true'`)
    .limit(1);

  res.json({
    sessionId,
    paperCount: paperCount?.count ?? 0,
    variableCount: variableCount?.count ?? 0,
    modelCount: modelCount?.count ?? 0,
    independentVarCount: indepCount?.count ?? 0,
    mediatorVarCount: mediatorCount?.count ?? 0,
    moderatorVarCount: moderatorCount?.count ?? 0,
    dependentVarCount: depCount?.count ?? 0,
    selectedModelId: selectedModel[0]?.id ?? null,
  });
});

// Phase 2 Innovation Layer — read the session's literature landscape
// snapshot. Pure read; does NOT trigger a rebuild. Auth-gated by the global
// `loadAuthorizedSession` middleware mounted at `/api/sessions/:id`.
router.get("/sessions/:id/landscape", async (_req, res): Promise<void> => {
  // loadAuthorizedSession (mounted globally at /api/sessions/:id) has already
  // validated the id, enforced ownership, and stashed the row + numeric id
  // into res.locals. Reuse both instead of re-parsing/re-fetching so we have
  // a single source of truth for "which session am I serving".
  const session = (res.locals["session"] ?? null) as typeof sessionsTable.$inferSelect | null;
  const sessionId = (res.locals["sessionId"] ?? null) as number | null;
  if (!session || !sessionId) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  const lm = (session.landscapeMeta ?? {}) as {
    landscapeVersion?: number;
    lastRebuildAt?: string;
    landscapeCoverage?: {
      coverageRate?: number;
      totalEligiblePaperCount?: number;
      extractedWithInnovationFieldsCount?: number;
    };
    theoryClusters?: Array<{ id?: string; label?: string; theoryIds?: string[]; paperCount?: number }>;
  };

  // Read the CR table + theoryBackbone evidence in parallel; both are
  // session-scoped indexed scans.
  const [crRows, tbRows] = await Promise.all([
    db.select().from(constructRelationshipsTable).where(eq(constructRelationshipsTable.sessionId, sessionId)),
    db
      .select({ theoryBackbone: papersTable.theoryBackbone })
      .from(papersTable)
      .where(
        and(
          eq(papersTable.sessionId, sessionId),
          sql`${papersTable.externalId} NOT LIKE 'manual:%'`,
          sql`${papersTable.tangential} IS NOT TRUE`,
        ),
      ),
  ]);

  // Slim the CR rows: drop verbose per-paper evidence (supportingPapers,
  // landscapeVersion stamp, timestamps) — the page only renders aggregates.
  const relationships = crRows
    .map((r) => ({
      id: r.id,
      canonicalFrom: r.canonicalFrom,
      canonicalTo: r.canonicalTo,
      contextQualifierFrom: r.contextQualifierFrom,
      contextQualifierTo: r.contextQualifierTo,
      relationshipType: r.relationshipType,
      sign: r.sign,
      signConflict: r.signConflict,
      totalOccurrences: r.totalOccurrences,
      domainsCovered: Array.isArray(r.domainsCovered) ? (r.domainsCovered as string[]) : [],
      earliestYear: r.earliestYear,
      latestYear: r.latestYear,
      noveltyPotentialScore: r.noveltyPotentialScore,
    }))
    // Most-evidenced first; tie-break on canonical names for stable ordering.
    .sort(
      (a, b) =>
        b.totalOccurrences - a.totalOccurrences ||
        a.canonicalFrom.localeCompare(b.canonicalFrom) ||
        a.canonicalTo.localeCompare(b.canonicalTo),
    );

  const evidencedSet = new Set<string>();
  for (const row of tbRows) {
    const tb = row.theoryBackbone as Array<{ name?: unknown }> | null;
    if (Array.isArray(tb)) {
      for (const t of tb) {
        if (t && typeof t.name === "string" && t.name.trim().length > 0) {
          evidencedSet.add(t.name.trim().toLowerCase());
        }
      }
    }
  }
  const evidencedBackbones = Array.from(evidencedSet).sort();

  const theoryClusters = Array.isArray(lm.theoryClusters)
    ? lm.theoryClusters
        .map((c) => ({
          id: typeof c.id === "string" ? c.id : "",
          label: typeof c.label === "string" ? c.label : (typeof c.id === "string" ? c.id : ""),
          theoryIds: Array.isArray(c.theoryIds) ? c.theoryIds.filter((s): s is string => typeof s === "string") : [],
          paperCount: typeof c.paperCount === "number" ? c.paperCount : 0,
        }))
        .filter((c) => c.id.length > 0)
    : [];

  const cov = lm.landscapeCoverage ?? {};
  const coverage = {
    coverageRate: typeof cov.coverageRate === "number" ? cov.coverageRate : 0,
    totalEligiblePaperCount: typeof cov.totalEligiblePaperCount === "number" ? cov.totalEligiblePaperCount : 0,
    extractedWithInnovationFieldsCount:
      typeof cov.extractedWithInnovationFieldsCount === "number" ? cov.extractedWithInnovationFieldsCount : 0,
  };

  res.json({
    landscapeVersion: typeof lm.landscapeVersion === "number" ? lm.landscapeVersion : null,
    lastRebuildAt: typeof lm.lastRebuildAt === "string" ? lm.lastRebuildAt : null,
    coverage,
    relationships,
    theoryClusters,
    evidencedBackbones,
  });
});

export default router;

import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, sessionsTable, papersTable, variablesTable, researchModelsTable } from "@workspace/db";
import {
  CreateSessionBody,
  GetSessionParams,
  UpdateSessionParams,
  UpdateSessionBody,
  DeleteSessionParams,
  GetSessionSummaryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

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

router.get("/sessions", async (req, res): Promise<void> => {
  const sessions = await db.select().from(sessionsTable).orderBy(sessionsTable.createdAt);

  const result = await Promise.all(
    sessions.map(async (session) => {
      const [paperCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(papersTable)
        .where(eq(papersTable.sessionId, session.id));
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
  const parsed = CreateSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [session] = await db.insert(sessionsTable).values(parsed.data).returning();
  res.status(201).json(buildSessionWithCounts(session, 0, 0, 0));
});

router.get("/sessions/:id", async (req, res): Promise<void> => {
  const params = GetSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, params.data.id));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const [paperCount] = await db.select({ count: sql<number>`count(*)::int` }).from(papersTable).where(eq(papersTable.sessionId, session.id));
  const [variableCount] = await db.select({ count: sql<number>`count(*)::int` }).from(variablesTable).where(eq(variablesTable.sessionId, session.id));
  const [modelCount] = await db.select({ count: sql<number>`count(*)::int` }).from(researchModelsTable).where(eq(researchModelsTable.sessionId, session.id));

  res.json(buildSessionWithCounts(session, paperCount?.count ?? 0, variableCount?.count ?? 0, modelCount?.count ?? 0));
});

router.patch("/sessions/:id", async (req, res): Promise<void> => {
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
    .set(parsed.data)
    .where(eq(sessionsTable.id, params.data.id))
    .returning();

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const [paperCount] = await db.select({ count: sql<number>`count(*)::int` }).from(papersTable).where(eq(papersTable.sessionId, session.id));
  const [variableCount] = await db.select({ count: sql<number>`count(*)::int` }).from(variablesTable).where(eq(variablesTable.sessionId, session.id));
  const [modelCount] = await db.select({ count: sql<number>`count(*)::int` }).from(researchModelsTable).where(eq(researchModelsTable.sessionId, session.id));

  res.json(buildSessionWithCounts(session, paperCount?.count ?? 0, variableCount?.count ?? 0, modelCount?.count ?? 0));
});

router.delete("/sessions/:id", async (req, res): Promise<void> => {
  const params = DeleteSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [session] = await db.delete(sessionsTable).where(eq(sessionsTable.id, params.data.id)).returning();
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.sendStatus(204);
});

router.get("/sessions/:id/summary", async (req, res): Promise<void> => {
  const params = GetSessionSummaryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const sessionId = params.data.id;

  const [paperCount] = await db.select({ count: sql<number>`count(*)::int` }).from(papersTable).where(eq(papersTable.sessionId, sessionId));
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

export default router;

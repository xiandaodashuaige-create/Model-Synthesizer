import { Router, type IRouter } from "express";
import { db, aiUsageLogTable, sessionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/authMiddleware";

const router: IRouter = Router();

router.get("/sessions/:id/ai-usage", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const sessionId = Number(req.params["id"]);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }

  // Ownership check: legacy NULL-owner rows are visible to any logged-in user.
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (session.userId && session.userId !== req.user!.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = await db
    .select({
      route: aiUsageLogTable.route,
      calls: sql<number>`count(*)::int`,
      promptTokens: sql<number>`coalesce(sum(${aiUsageLogTable.promptTokens}),0)::int`,
      completionTokens: sql<number>`coalesce(sum(${aiUsageLogTable.completionTokens}),0)::int`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageLogTable.totalTokens}),0)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${aiUsageLogTable.costMicroUsd}),0)::bigint`,
    })
    .from(aiUsageLogTable)
    .where(eq(aiUsageLogTable.sessionId, sessionId))
    .groupBy(aiUsageLogTable.route);

  let totalCalls = 0, totalPromptTokens = 0, totalCompletionTokens = 0, totalTokens = 0, totalCostMicro = 0;
  const byRoute = rows.map((r) => {
    const costMicro = Number(r.costMicroUsd);
    totalCalls += r.calls;
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;
    totalTokens += r.totalTokens;
    totalCostMicro += costMicro;
    return {
      route: r.route,
      calls: r.calls,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      costUsd: costMicro / 1_000_000,
    };
  });

  res.json({
    totalCalls,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    totalCostUsd: totalCostMicro / 1_000_000,
    byRoute,
  });
});

export default router;

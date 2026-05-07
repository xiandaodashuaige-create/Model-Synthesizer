import { Router, type IRouter } from "express";
import { db, aiUsageLogTable, sessionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/authMiddleware";
import { computeCostMicroUsd } from "../lib/ai-usage";

const router: IRouter = Router();

// Flagship model name — the priciest tier we'd otherwise have used. We
// recompute every row's cost as if it had been billed at this model so the UI
// can surface "you saved N credits by routing easy tasks to a cheaper model".
const FLAGSHIP_MODEL = "gpt-5.4";

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

  // Group by (route, model) so we can recompute the "flagship" hypothetical
  // cost per row using the actual prompt/completion split. A pure (route)
  // grouping would lose the model name and force us to assume one model per
  // route, which breaks for routes whose model has changed over the project's
  // lifetime (e.g. literature-review used to be gpt-5.4, now gpt-5-mini —
  // both rows still exist in the audit log).
  const rows = await db
    .select({
      route: aiUsageLogTable.route,
      model: aiUsageLogTable.model,
      calls: sql<number>`count(*)::int`,
      promptTokens: sql<number>`coalesce(sum(${aiUsageLogTable.promptTokens}),0)::int`,
      completionTokens: sql<number>`coalesce(sum(${aiUsageLogTable.completionTokens}),0)::int`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageLogTable.totalTokens}),0)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${aiUsageLogTable.costMicroUsd}),0)::bigint`,
    })
    .from(aiUsageLogTable)
    .where(eq(aiUsageLogTable.sessionId, sessionId))
    .groupBy(aiUsageLogTable.route, aiUsageLogTable.model);

  // Roll (route, model) rows up to per-route aggregates, also computing the
  // hypothetical "billed-at-flagship" micro-USD for each row.
  const byRouteMap = new Map<string, {
    route: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costMicroUsd: number;
    flagshipCostMicroUsd: number;
  }>();
  let totalCalls = 0, totalPromptTokens = 0, totalCompletionTokens = 0, totalTokens = 0;
  let totalCostMicro = 0, totalFlagshipMicro = 0;
  for (const r of rows) {
    const actualMicro = Number(r.costMicroUsd);
    const flagshipMicro = computeCostMicroUsd(r.promptTokens, r.completionTokens, FLAGSHIP_MODEL);
    totalCalls += r.calls;
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;
    totalTokens += r.totalTokens;
    totalCostMicro += actualMicro;
    totalFlagshipMicro += flagshipMicro;
    const acc = byRouteMap.get(r.route) ?? {
      route: r.route,
      calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      costMicroUsd: 0, flagshipCostMicroUsd: 0,
    };
    acc.calls += r.calls;
    acc.promptTokens += r.promptTokens;
    acc.completionTokens += r.completionTokens;
    acc.totalTokens += r.totalTokens;
    acc.costMicroUsd += actualMicro;
    acc.flagshipCostMicroUsd += flagshipMicro;
    byRouteMap.set(r.route, acc);
  }
  const byRoute = Array.from(byRouteMap.values()).map((a) => ({
    route: a.route,
    calls: a.calls,
    promptTokens: a.promptTokens,
    completionTokens: a.completionTokens,
    totalTokens: a.totalTokens,
    costUsd: a.costMicroUsd / 1_000_000,
    flagshipCostUsd: a.flagshipCostMicroUsd / 1_000_000,
    // Clamp at 0 so a route that used a model we don't have priced (and
    // therefore fell back to the flagship rate itself) doesn't show negative
    // savings.
    savedCostUsd: Math.max(0, (a.flagshipCostMicroUsd - a.costMicroUsd) / 1_000_000),
  }));

  res.json({
    totalCalls,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    totalCostUsd: totalCostMicro / 1_000_000,
    flagshipCostUsd: totalFlagshipMicro / 1_000_000,
    savedCostUsd: Math.max(0, (totalFlagshipMicro - totalCostMicro) / 1_000_000),
    byRoute,
  });
});

export default router;

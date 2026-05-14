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
import { openai } from "@workspace/integrations-openai-ai-server";
import { logAiUsageFromOpenAI } from "../lib/ai-usage";

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

  // Include cached gap report in the response if present.
  const gr = (lm as { gapReport?: unknown }).gapReport;
  const gapReport =
    gr &&
    typeof gr === "object" &&
    typeof (gr as Record<string, unknown>).version === "number" &&
    Array.isArray((gr as Record<string, unknown>).gaps)
      ? gr
      : null;

  res.json({
    landscapeVersion: typeof lm.landscapeVersion === "number" ? lm.landscapeVersion : null,
    lastRebuildAt: typeof lm.lastRebuildAt === "string" ? lm.lastRebuildAt : null,
    coverage,
    relationships,
    theoryClusters,
    evidencedBackbones,
    gapReport,
  });
});

// ---------------------------------------------------------------------------
// POST /sessions/:id/landscape/gap-report
// AI-generated gap analysis. Cached in landscapeMeta.gapReport keyed by
// landscapeVersion. Re-running after a landscape rebuild produces a fresh
// report. Auth-gated by loadAuthorizedSession (same as the GET above).
// ---------------------------------------------------------------------------
const VALID_GAP_TYPES = new Set([
  "mechanism", "boundary", "integration", "correction", "construct", "context",
]);

router.post("/sessions/:id/landscape/gap-report", async (req, res): Promise<void> => {
  const session = (res.locals["session"] ?? null) as typeof sessionsTable.$inferSelect | null;
  const sessionId = (res.locals["sessionId"] ?? null) as number | null;
  if (!session || !sessionId) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  const lm = (session.landscapeMeta ?? {}) as {
    landscapeVersion?: number;
    lastRebuildAt?: string;
    theoryClusters?: Array<{ id?: string; label?: string }>;
    gapReport?: {
      version?: number;
      generatedAt?: string;
      gaps?: unknown[];
      topGapTypes?: string[];
      allGapTypes?: string[];
    } | null;
  };
  const landscapeVersion = typeof lm.landscapeVersion === "number" ? lm.landscapeVersion : null;

  // Cache hit: gap report already computed for this landscapeVersion.
  if (
    landscapeVersion !== null &&
    lm.gapReport &&
    typeof lm.gapReport.version === "number" &&
    lm.gapReport.version === landscapeVersion &&
    Array.isArray(lm.gapReport.gaps) &&
    lm.gapReport.gaps.length > 0
  ) {
    res.json(lm.gapReport);
    return;
  }

  if (!landscapeVersion) {
    res.status(400).json({ error: "landscape_not_built", message: "请先完成文献提取以重建文献全景" });
    return;
  }

  // Fetch CR rows + paper context in parallel.
  const [crRows, paperRows] = await Promise.all([
    db
      .select({
        canonicalFrom: constructRelationshipsTable.canonicalFrom,
        contextQualifierFrom: constructRelationshipsTable.contextQualifierFrom,
        canonicalTo: constructRelationshipsTable.canonicalTo,
        contextQualifierTo: constructRelationshipsTable.contextQualifierTo,
        relationshipType: constructRelationshipsTable.relationshipType,
        sign: constructRelationshipsTable.sign,
        totalOccurrences: constructRelationshipsTable.totalOccurrences,
        signConflict: constructRelationshipsTable.signConflict,
      })
      .from(constructRelationshipsTable)
      .where(eq(constructRelationshipsTable.sessionId, sessionId)),
    db
      .select({
        title: papersTable.title,
        statedGaps: papersTable.statedGaps,
        studyContext: papersTable.studyContext,
      })
      .from(papersTable)
      .where(
        and(
          eq(papersTable.sessionId, sessionId),
          sql`${papersTable.externalId} NOT LIKE 'manual:%'`,
          sql`${papersTable.tangential} IS NOT TRUE`,
        ),
      ),
  ]);

  // Build compact CR block (top 25 by occurrences).
  const topCR = [...crRows].sort((a, b) => b.totalOccurrences - a.totalOccurrences).slice(0, 25);
  const crBlock = topCR.length > 0
    ? topCR.map((r) => {
        const from = r.contextQualifierFrom ? `${r.canonicalFrom}(${r.contextQualifierFrom})` : r.canonicalFrom;
        const to = r.contextQualifierTo ? `${r.canonicalTo}(${r.contextQualifierTo})` : r.canonicalTo;
        const conflict = r.signConflict ? " ⚠️符号冲突" : "";
        return `  ${from} --(${r.relationshipType},${r.sign})→ ${to} [n=${r.totalOccurrences}${conflict}]`;
      }).join("\n")
    : "  （暂无构念关系数据）";

  // Build paper context block.
  const contextLines: string[] = [];
  for (const p of paperRows.slice(0, 10)) {
    const ctx = p.studyContext as { objectType?: unknown; geography?: unknown } | null;
    if (ctx && typeof ctx === "object") {
      const parts: string[] = [];
      if (typeof ctx.objectType === "string" && ctx.objectType.trim()) parts.push(`对象:${ctx.objectType.trim()}`);
      if (typeof ctx.geography === "string" && ctx.geography.trim()) parts.push(`地区:${ctx.geography.trim()}`);
      if (parts.length > 0) {
        const title = typeof p.title === "string" ? p.title.slice(0, 35) : "?";
        contextLines.push(`  - ${title}: ${parts.join(", ")}`);
      }
    }
  }
  const contextBlock = contextLines.length > 0 ? contextLines.join("\n") : "  （无 studyContext 数据）";

  // Build stated-gaps block.
  const gapLines: string[] = [];
  for (const p of paperRows.slice(0, 10)) {
    const sg = p.statedGaps as Array<{ text?: unknown; gapType?: unknown }> | null;
    if (Array.isArray(sg)) {
      for (const g of sg.slice(0, 3)) {
        if (g && typeof g.text === "string" && g.text.trim()) {
          const gtype = typeof g.gapType === "string" ? `[${g.gapType}] ` : "";
          gapLines.push(`  - ${gtype}${g.text.slice(0, 80)}`);
        }
      }
    }
  }
  const statedGapsBlock = gapLines.length > 0 ? gapLines.join("\n") : "  （论文未标注研究空白）";

  // Theory clusters.
  const clusters = Array.isArray(lm.theoryClusters) ? lm.theoryClusters : [];
  const clusterBlock = clusters.length > 0
    ? clusters.map((c: { id?: string; label?: string }) => `  - ${c.id ?? ""}: ${c.label ?? ""}`).join("\n")
    : "  （无理论集群数据）";

  const topic = typeof session.topic === "string" ? session.topic : "（未设置主题）";

  const systemPrompt = `你是帮助研究者识别文献空白的学术分析助手。基于文献全景数据，识别最显著的研究空白。严格按 JSON 格式回复，不输出任何其他内容。`;

  const userPrompt = `研究主题：${topic}

## 构念关系（按支撑论文数排序，最多 25 条）
${crBlock}

## 论文研究情境
${contextBlock}

## 论文已陈述的研究空白
${statedGapsBlock}

## 理论集群
${clusterBlock}

任务：识别最多 5 个有数据支撑的研究空白。

空白类型定义：
- mechanism：X→Y 关系有多篇论文支持，但中介路径尚不清楚
- boundary：X→Y 关系缺少特定情境的调节变量
- integration：两个相关理论尚未在同一模型中整合
- correction：论文间对某条关系符号（正/负）存在冲突
- construct：重要构念在此文献库中出现频次极低（有延展空间）
- context：本研究对象/情境与所有论文的 studyContext.objectType 均不同

输出 JSON（中文内容）：
{
  "gaps": [
    {
      "type": "mechanism|boundary|integration|correction|construct|context",
      "summary": "一句话说明此研究空白（≤50字）",
      "evidence": "具体说明哪些关系或论文支持此判断（≤60字）"
    }
  ],
  "topGapTypes": ["最重要的1-3个空白类型（与 gaps 中的 type 对应）"]
}`;

  const aiResp = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    max_tokens: 800,
  });
  logAiUsageFromOpenAI(aiResp, { route: "landscape/gap-report", sessionId, userId: null });

  const rawJson = aiResp.choices[0]?.message?.content ?? "{}";
  let parsed: { gaps?: unknown; topGapTypes?: unknown } = {};
  try {
    parsed = JSON.parse(rawJson) as { gaps?: unknown; topGapTypes?: unknown };
  } catch {
    req.log.warn({ rawJson }, "gap-report: failed to parse AI JSON response");
  }

  const gaps = (Array.isArray(parsed.gaps) ? parsed.gaps : [])
    .filter(
      (g): g is { type: string; summary: string; evidence: string } =>
        g !== null &&
        typeof g === "object" &&
        typeof (g as Record<string, unknown>).type === "string" &&
        VALID_GAP_TYPES.has((g as Record<string, unknown>).type as string) &&
        typeof (g as Record<string, unknown>).summary === "string" &&
        ((g as Record<string, unknown>).summary as string).trim().length > 0 &&
        typeof (g as Record<string, unknown>).evidence === "string",
    )
    .slice(0, 5);

  const allGapTypes = Array.from(new Set(gaps.map((g) => g.type)));
  const topGapTypes = (Array.isArray(parsed.topGapTypes) ? parsed.topGapTypes : [])
    .filter(
      (t): t is string =>
        typeof t === "string" && VALID_GAP_TYPES.has(t) && allGapTypes.includes(t),
    )
    .slice(0, 3);

  const gapReport = {
    version: landscapeVersion,
    generatedAt: new Date().toISOString(),
    gaps,
    topGapTypes,
    allGapTypes,
  };

  // Persist by merging into landscapeMeta (all existing fields preserved).
  await db
    .update(sessionsTable)
    .set({
      landscapeMeta: {
        ...((session.landscapeMeta as object) ?? {}),
        gapReport,
      },
    })
    .where(eq(sessionsTable.id, sessionId));

  res.json(gapReport);
});

export default router;

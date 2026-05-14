// Phase 4 Innovation Layer end-to-end smoke test.
//
// Walks the full Phase 4 chain for a target session:
//   0. GET /sessions/:id/landscape — verify landscapeVersion is present
//   1. Check gapReport: if absent, warn and skip gap/context assertions
//   2. POST /sessions/:id/models/generate (numModels=1) — generates one model
//   3. Reads the freshest ai_usage_log row(s) for models/generate from DB
//   4. Reads the returned model's innovationMeta and verifies all Phase 4 fields
//   5. Context-propagation assertion: gapReport.allGapTypes⊇{context} ∧
//      model has ≥1 context_transferred edge ↔ innovationTypes must include "context"
//      (negative case is also asserted: if neither condition is met, "context"
//       must NOT appear in innovationTypes)
//
// Auth: the script auto-creates a temporary auth_sessions row (Bearer token)
// using the session's own userId. No browser cookie is needed. The row is
// deleted after the run (even on failure via try/finally).
//
// Usage:
//   pnpm --filter @workspace/scripts run selftest:phase-4 <sessionId>
//
//   API_BASE_URL=http://... — default: http://localhost:80
//
// The target session must already have a landscape built (landscapeVersion ≥ 1)
// and, for context-propagation checks, a gap report generated. If either is
// absent the script warns and skips the corresponding assertions.
//
// Exits non-zero on any assertion failure.

import crypto from "crypto";
import { db, aiUsageLogTable, sessionsTable, authSessionsTable } from "@workspace/db";
import { desc, eq, and } from "drizzle-orm";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:80";

const sessionIdRaw = process.argv[2];
if (!sessionIdRaw) {
  console.error("usage: selftest:phase-4 <sessionId>");
  process.exit(2);
}
const sessionId = Number.parseInt(sessionIdRaw, 10);
if (!Number.isFinite(sessionId)) {
  console.error("sessionId must be a valid integer");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
const failures: string[] = [];
function assert(cond: unknown, msg: string): void {
  if (!cond) failures.push(msg);
}
function assertApprox(actual: number, max: number, label: string): void {
  if (actual > max) failures.push(`${label}: ${actual} > limit ${max}`);
}

// ---------------------------------------------------------------------------
// Types mirroring API responses
// ---------------------------------------------------------------------------
interface Coverage {
  coverageRate: number;
  totalEligiblePaperCount: number;
  extractedWithInnovationFieldsCount: number;
}
interface GapEntry {
  type: string;
  summary: string;
}
interface GapReport {
  version: number;
  gaps: GapEntry[];
  allGapTypes: string[];
  topGapTypes?: string[];
}
interface LandscapeResponse {
  landscapeVersion: number | null;
  lastRebuildAt: string | null;
  coverage: Coverage;
  gapReport: GapReport | null;
}

interface EdgeNoveltyTagging {
  tag: string;
  subscore: number;
  reason: string;
  matchedRelationship?: unknown;
}
interface InnovationMeta {
  mode: "enforced" | "analysis_only";
  noveltyScore: number | null;
  innovationTypes: string[];
  contributionScore: number;
  subScores: {
    differentiation: number;
    gapFit: number;
    theoreticalSoundness: number;
    evidenceSupport: number;
  };
  edgeNoveltyTags: EdgeNoveltyTagging[];
  warnings: Array<{ code: string; message: string }>;
  computedAgainst: {
    landscapeVersion: number | null;
    coverageRate: number;
    computedAt: string;
  };
  stale?: boolean;
}
interface GeneratedModel {
  id: number;
  name: string;
  innovationMeta: InnovationMeta | null;
}

// ---------------------------------------------------------------------------
// Auth setup: insert a temporary auth_sessions row, return Bearer sid + cleanup
// ---------------------------------------------------------------------------
async function setupTestAuth(): Promise<{ headers: Record<string, string>; cleanup: () => Promise<void> }> {
  const [sessionRow] = await db
    .select({ userId: sessionsTable.userId })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!sessionRow) {
    throw new Error(`Session ${sessionId} not found in DB.`);
  }
  if (!sessionRow.userId) {
    throw new Error(
      `Session ${sessionId} has no userId (unclaimed pre-auth session). ` +
      `Please open the app, log in, and visit session ${sessionId} to claim it first.`,
    );
  }

  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(authSessionsTable).values({
    sid,
    sess: {
      user: { id: sessionRow.userId },
      access_token: "selftest-phase-4-ephemeral",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    } as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + 3600 * 1000),
  });

  console.log(`  ✔ Temporary auth session created (userId=${sessionRow.userId}, sid=${sid.slice(0, 8)}…)`);

  return {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sid}`,
    },
    cleanup: async () => {
      await db.delete(authSessionsTable).where(eq(authSessionsTable.sid, sid));
      console.log("  ✔ Temporary auth session cleaned up");
    },
  };
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------
async function getLandscape(authHeaders: Record<string, string>): Promise<LandscapeResponse> {
  const r = await fetch(`${baseUrl}/api/sessions/${sessionId}/landscape`, {
    headers: authHeaders,
  });
  if (!r.ok) throw new Error(`GET landscape returned ${r.status}: ${await r.text()}`);
  return (await r.json()) as LandscapeResponse;
}

const MAX_GENERATE_ATTEMPTS = 5;

async function generateOneModel(authHeaders: Record<string, string>, attempt = 1): Promise<GeneratedModel[]> {
  const r = await fetch(`${baseUrl}/api/sessions/${sessionId}/models/generate`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ numModels: 1 }),
  });
  if (r.status === 502 && attempt < MAX_GENERATE_ATTEMPTS) {
    const body = await r.json().catch(() => ({})) as Record<string, unknown>;
    const reason = String((body as {error?: unknown}).error ?? "").slice(0, 120);
    console.log(`  WARN: models/generate attempt ${attempt} rejected (${reason})`);
    console.log(`  → Retrying (attempt ${attempt + 1}/${MAX_GENERATE_ATTEMPTS})…`);
    return generateOneModel(authHeaders, attempt + 1);
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(`POST models/generate returned ${r.status} after ${attempt} attempt(s): ${JSON.stringify(body)}`);
  }
  return (await r.json()) as GeneratedModel[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const tStart = Date.now();
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`selftest-phase-4  session=${sessionId}  ${new Date().toISOString()}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // ── Auth setup ────────────────────────────────────────────────────────────
  console.log("[auth] Setting up temporary auth session…");
  const { headers: authHeaders, cleanup } = await setupTestAuth();

  try {
    await runTests(authHeaders, tStart);
  } finally {
    await cleanup();
  }
}

// A declared variable used in the final summary block.
let thisRunLogs: Array<{ promptTokens: number; completionTokens: number; costMicroUsd: number; model: string; createdAt: Date }> = [];
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
let totalCostMicroUsd = 0;
let modelUsed = "(unknown)";

async function runTests(authHeaders: Record<string, string>, tStart: number): Promise<void> {
  // ── Step 0: Verify landscape is present ───────────────────────────────────
  // The session must already have a landscape built (landscapeVersion ≥ 1).
  // If it doesn't, the test fails with a clear message — the caller should
  // run a manual landscape rebuild before invoking this selftest.
  console.log("\n[0/4] GET landscape…");
  const landscape = await getLandscape(authHeaders);
  const { landscapeVersion, coverage, gapReport: existingGapReport } = landscape;

  console.log(`  landscapeVersion  : ${landscapeVersion ?? "(null)"}`);
  console.log(`  coverageRate      : ${(coverage.coverageRate * 100).toFixed(1)}%`);
  console.log(`  eligiblePapers    : ${coverage.totalEligiblePaperCount}`);
  console.log(`  extractedPapers   : ${coverage.extractedWithInnovationFieldsCount}`);
  console.log(`  gapReport present : ${existingGapReport !== null}`);

  assert(
    landscapeVersion !== null && landscapeVersion > 0,
    "landscapeVersion is null or 0 — session must have a built landscape before running this selftest",
  );
  assert(coverage.totalEligiblePaperCount > 0, "session has no eligible papers");

  // ── Step 1: Check gap report ─────────────────────────────────────────────
  // If no gap report is present (or it is stale), warn and skip the
  // gap-dependent assertions.  We do NOT auto-generate here — gap report
  // generation is a separate product action, not part of this smoke test.
  console.log("\n[1/4] Gap report…");
  let gapReport: GapReport;
  let skipGapChecks = false;
  if (existingGapReport && existingGapReport.version === landscapeVersion) {
    gapReport = existingGapReport;
    console.log(`  ✔ Gap report present (version ${gapReport.version})`);
    console.log(`  allGapTypes : [${gapReport.allGapTypes.join(", ")}]`);
    console.log(`  gaps        : ${gapReport.gaps.length}`);
    for (const g of gapReport.gaps.slice(0, 3)) {
      console.log(`    [${g.type}] ${g.summary.slice(0, 70)}`);
    }
    // When gap report is present, assert non-empty allGapTypes for sessions
    // with sufficient coverage so the gap-type contract is verified.
    if (gapReport.allGapTypes.length === 0 && coverage.coverageRate >= 0.3) {
      assert(false, "gap report allGapTypes is empty despite coverage ≥30%");
    }
    if (gapReport.gaps.length === 0) {
      console.log(`  WARN: gap report has 0 gaps (coverage=${(coverage.coverageRate * 100).toFixed(1)}% — may be too low for gap detection)`);
    }
  } else {
    skipGapChecks = true;
    if (existingGapReport && existingGapReport.version !== landscapeVersion) {
      console.log(`  WARN: gap report version ${existingGapReport.version} ≠ landscapeVersion ${landscapeVersion} — skipping gap/context assertions`);
    } else {
      console.log("  WARN: no gap report found — skipping gap/context assertions");
    }
    gapReport = { version: 0, gaps: [], allGapTypes: [], topGapTypes: [] };
  }

  // Snapshot time so we can isolate the ai_usage_log rows produced by THIS run.
  const tBeforeGenerate = new Date();

  // ── Step 2: Generate one model ─────────────────────────────────────────
  console.log("\n[2/4] POST models/generate (numModels=1)…");
  const models = await generateOneModel(authHeaders);
  const tAfterGenerate = new Date();
  const generationMs = tAfterGenerate.getTime() - tBeforeGenerate.getTime();

  assert(Array.isArray(models) && models.length >= 1, `models/generate returned ${models.length} models (expected ≥1)`);
  if (models.length === 0) {
    console.error("  ✘ No models returned — aborting remaining assertions");
    process.exit(1);
  }

  const model = models[0]!;
  console.log(`  ✔ Got ${models.length} model(s) in ${(generationMs / 1000).toFixed(1)}s`);
  console.log(`  model.id   : ${model.id}`);
  console.log(`  model.name : "${model.name.slice(0, 60)}"`);

  // ── Step 3: Read ai_usage_log for this generation run ─────────────────
  console.log("\n[3/4] Reading ai_usage_log…");
  const usageLogs = await db
    .select()
    .from(aiUsageLogTable)
    .where(
      and(
        eq(aiUsageLogTable.sessionId, sessionId),
        eq(aiUsageLogTable.route, "models/generate"),
      ),
    )
    .orderBy(desc(aiUsageLogTable.createdAt))
    .limit(5);

  // Filter to rows produced in this run (within a 90s window of generation).
  thisRunLogs = usageLogs.filter((r) => {
    const diff = tAfterGenerate.getTime() - r.createdAt.getTime();
    return diff >= -5000 && diff <= 90_000;
  });

  if (thisRunLogs.length > 0) {
    for (const r of thisRunLogs) {
      totalPromptTokens += r.promptTokens;
      totalCompletionTokens += r.completionTokens;
      totalCostMicroUsd += r.costMicroUsd;
      modelUsed = r.model;
    }
    const costUsd = totalCostMicroUsd / 1_000_000;
    const credits = Math.round(costUsd * 100);
    console.log(`  calls logged      : ${thisRunLogs.length}`);
    console.log(`  model used        : ${modelUsed}`);
    console.log(`  promptTokens      : ${totalPromptTokens.toLocaleString()}`);
    console.log(`  completionTokens  : ${totalCompletionTokens.toLocaleString()}`);
    console.log(`  cost              : $${costUsd.toFixed(4)} (${credits} 积分)`);
    // Core #14 assertion: prompt compression target
    assertApprox(totalPromptTokens, 22_000, "promptTokens (target ≤20k, hard limit 22k)");
  } else {
    console.log("  WARN: no matching ai_usage_log rows found for this run window");
    console.log(`    (looked for sessionId=${sessionId} route=models/generate within 90s of generation)`);
  }

  // ── Step 4: innovationMeta assertions ──────────────────────────────────
  console.log("\n── innovationMeta ──────────────────────────────────────────");
  const im = model.innovationMeta;
  assert(im !== null, "innovationMeta is null — Phase 1 scoring should have populated it");

  if (im) {
    console.log(`  mode              : ${im.mode}`);
    console.log(`  noveltyScore      : ${im.noveltyScore ?? "(null)"}`);
    console.log(`  contributionScore : ${im.contributionScore}`);
    console.log(`  innovationTypes   : [${im.innovationTypes.join(", ")}]`);
    console.log(`  coverageRate      : ${(im.computedAgainst.coverageRate * 100).toFixed(1)}%`);
    console.log(`  computedAgainst   : landscapeVersion=${im.computedAgainst.landscapeVersion}`);
    console.log(`  stale             : ${im.stale ?? false}`);
    console.log(`  warnings          : ${im.warnings.length}`);
    for (const w of im.warnings) console.log(`    [${w.code}] ${w.message.slice(0, 80)}`);

    // sub-scores
    const ss = im.subScores;
    console.log(`  subScores         : diff=${ss.differentiation} gapFit=${ss.gapFit} theSound=${ss.theoreticalSoundness} evSup=${ss.evidenceSupport}`);

    // edge novelty tags
    const tagCounts: Record<string, number> = {};
    for (const et of im.edgeNoveltyTags) tagCounts[et.tag] = (tagCounts[et.tag] ?? 0) + 1;
    console.log(`  edgeNoveltyTags   : ${JSON.stringify(tagCounts)}`);

    // Basic structural assertions
    assert(typeof im.mode === "string", "mode field missing");
    assert(Array.isArray(im.innovationTypes), "innovationTypes is not an array");
    assert(typeof im.contributionScore === "number", "contributionScore is not a number");
    assert(Array.isArray(im.edgeNoveltyTags), "edgeNoveltyTags is not an array");
    assert(im.computedAgainst.landscapeVersion !== null, "computedAgainst.landscapeVersion is null");
    assert(
      im.computedAgainst.landscapeVersion === landscapeVersion,
      `model scored against landscapeVersion=${im.computedAgainst.landscapeVersion} but session is at ${landscapeVersion} — stale`,
    );

    // Coverage floor check: if coverage ≥ 70%, mode must be "enforced"
    if (im.computedAgainst.coverageRate >= 0.7) {
      assert(im.mode === "enforced", `coverage=${(im.computedAgainst.coverageRate * 100).toFixed(1)}% ≥70% but mode="${im.mode}" (expected "enforced")`);
    } else {
      assert(im.mode === "analysis_only", `coverage=${(im.computedAgainst.coverageRate * 100).toFixed(1)}% <70% but mode="${im.mode}" (expected "analysis_only")`);
    }

    // ── Phase 4 core: context propagation check ──────────────────────────
    console.log("\n── Phase 4: context propagation check ─────────────────────");
    if (skipGapChecks) {
      console.log("  — gap report absent; skipping context propagation check");
    } else {
      const gapHasContext = gapReport.allGapTypes.includes("context");
      const modelHasContextTransferred = im.edgeNoveltyTags.some((t) => t.tag === "context_transferred");
      const innovationHasContext = im.innovationTypes.includes("context");

      console.log(`  gap allGapTypes has "context" : ${gapHasContext}`);
      console.log(`  model has context_transferred : ${modelHasContextTransferred}`);
      console.log(`  innovationTypes has "context" : ${innovationHasContext}`);

      if (gapHasContext && modelHasContextTransferred) {
        assert(innovationHasContext, "FAIL: gapReport has context gap + model has context_transferred edge, but innovationTypes is missing 'context'");
        console.log("  ✔ Both conditions met → context correctly in innovationTypes");
      } else if (!gapHasContext && !modelHasContextTransferred) {
        assert(!innovationHasContext, "FAIL: neither gapReport context gap nor context_transferred edge, but innovationTypes spuriously includes 'context'");
        console.log("  ✔ Neither condition met → context correctly absent from innovationTypes");
      } else if (gapHasContext && !modelHasContextTransferred) {
        assert(!innovationHasContext, "FAIL: gapReport has context gap but model has no context_transferred edge — innovationTypes must not include 'context'");
        console.log("  ✔ gapReport has context gap but no context_transferred edge → context correctly absent from innovationTypes");
      } else {
        assert(!innovationHasContext, "FAIL: model has context_transferred edge but gapReport lacks context gap — innovationTypes must not include 'context'");
        console.log("  ✔ model has context_transferred edge but gapReport lacks context gap → context correctly absent from innovationTypes");
      }
    }

    // No duplicate innovationTypes
    const unique = new Set(im.innovationTypes);
    assert(unique.size === im.innovationTypes.length, `innovationTypes has duplicates: [${im.innovationTypes.join(", ")}]`);
  }

  // ── Step 6: gapFit wiring (Phase 4 specific) ───────────────────────────
  console.log("\n── Phase 4: gapFit wiring ──────────────────────────────────");
  if (im && gapReport.gaps.length > 0) {
    // gapFit floor is 30 when innovationTypes is empty or no gapReport.
    // If gapReport exists and innovationTypes is non-empty, gapFit should be > 30.
    const gapFit = im.subScores.gapFit;
    if (im.innovationTypes.length > 0) {
      assert(gapFit > 30, `gapFit=${gapFit} should be >30 when gapReport exists and innovationTypes is non-empty`);
      console.log(`  ✔ gapFit=${gapFit} > 30 (wired to gap report)`);
    } else {
      console.log(`  — innovationTypes empty; gapFit=${gapFit} (floor expected)`);
    }
  } else {
    console.log("  — gap report empty or im null; skipping gapFit wiring check");
  }

  // ── Final summary ───────────────────────────────────────────────────────
  const totalMs = Date.now() - tStart;
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("SMOKE TEST REPORT");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`sessionId             : ${sessionId}`);
  console.log(`landscapeVersion      : ${landscapeVersion}`);
  console.log(`coverageRate          : ${(coverage.coverageRate * 100).toFixed(1)}%`);
  console.log(`gapReport.version     : ${gapReport.version}`);
  console.log(`gapReport.gaps        : ${gapReport.gaps.length}`);
  console.log(`gapReport.allGapTypes : [${gapReport.allGapTypes.join(", ")}]`);
  console.log(`generatedModelId      : ${model.id}`);
  if (thisRunLogs.length > 0) {
    console.log(`promptTokens          : ${totalPromptTokens.toLocaleString()}`);
    console.log(`completionTokens      : ${totalCompletionTokens.toLocaleString()}`);
    console.log(`costUsd               : $${(totalCostMicroUsd / 1_000_000).toFixed(4)}`);
    console.log(`credits (积分)         : ${Math.round(totalCostMicroUsd / 10_000)}`);
    console.log(`modelUsed             : ${modelUsed}`);
  }
  if (model.innovationMeta) {
    const im2 = model.innovationMeta;
    console.log(`mode                  : ${im2.mode}`);
    console.log(`noveltyScore          : ${im2.noveltyScore}`);
    console.log(`contributionScore     : ${im2.contributionScore}`);
    console.log(`innovationTypes       : [${im2.innovationTypes.join(", ")}]`);
    const ss2 = im2.subScores;
    console.log(`subScores             : diff=${ss2.differentiation} gapFit=${ss2.gapFit} theSound=${ss2.theoreticalSoundness} evSup=${ss2.evidenceSupport}`);
    console.log(`warnings              : ${im2.warnings.length}`);
    console.log(`stale                 : ${im2.stale ?? false}`);
  }
  console.log(`totalMs               : ${totalMs}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) FAILED:`);
    for (const f of failures) console.error(`  ✘ ${f}`);
    process.exit(1);
  }
  console.log("\nselftest-phase-4: PASS ✔");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

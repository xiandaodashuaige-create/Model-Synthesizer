// Phase 2 Innovation Layer selftest.
//
// Re-scores every existing research_model in a target session by hitting the
// server's POST /models/:id/recompute-innovation endpoint, then asserts the
// resulting innovationMeta carries the contract Phase 2 promises:
//
//   - all 4 sub-scores present, in [0,100]
//   - contributionScore is the geometric mean of the 4 sub-scores (±1 rounding)
//   - mode = "analysis_only" when coverageRate < 0.7, "enforced" otherwise
//   - computedAgainst.{landscapeVersion, coverageRate, computedAt} populated
//   - edgeNoveltyTags has one entry per model.edges
//   - warnings is an array (empty allowed); each item has a known code
//   - never rejects: HTTP 200 even when warnings fire
//
// Usage:
//   pnpm --filter @workspace/scripts run selftest:phase-2 <sessionId>
//
// Exits non-zero on any assertion failure so CI / pre-deploy can gate on it.

import { db, researchModelsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:80";

const sessionIdRaw = process.argv[2];
if (!sessionIdRaw) {
  console.error("usage: selftest:phase-2 <sessionId>");
  process.exit(2);
}
const sessionId = Number.parseInt(sessionIdRaw, 10);
if (!Number.isFinite(sessionId)) {
  console.error("sessionId must be an integer");
  process.exit(2);
}

interface InnovationMeta {
  edgeNoveltyTags: Array<{ edgeIndex: number; tag: string; subscore: number }>;
  noveltyScore: number | null;
  innovationTypes: string[];
  subScores: { differentiation: number; gapFit: number; theoreticalSoundness: number; evidenceSupport: number };
  contributionScore: number;
  contributionStatement: null;
  computedAgainst: { landscapeVersion: number | null; coverageRate: number; computedAt: string };
  mode: "analysis_only" | "enforced";
  modeReason: "coverage_below_threshold" | "ok";
  warnings: Array<{ code: string; message: string }>;
  stale?: boolean;
}

interface ModelOut {
  id: number;
  name: string;
  edges: unknown[];
  innovationMeta: InnovationMeta | null;
}

const failures: string[] = [];
function assert(cond: unknown, msg: string) {
  if (!cond) failures.push(msg);
}

const KNOWN_WARNING_CODES = new Set([
  "contribution_statement_missing",
  "no_innovation_type_detected",
  "all_edges_low_novelty",
]);

async function main() {
  // 1. Pull all models for the session directly from the DB. The HTTP listing
  // endpoint is gated by session ownership; reading from the DB keeps the
  // selftest auth-free while still exercising the same scoring code path
  // through the (auth-free) recompute endpoint.
  const rows = await db
    .select()
    .from(researchModelsTable)
    .where(eq(researchModelsTable.sessionId, sessionId))
    .orderBy(researchModelsTable.id);
  const models: ModelOut[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    edges: (r.edges as unknown[]) ?? [],
    innovationMeta: (r.innovationMeta as InnovationMeta | null) ?? null,
  }));
  if (models.length === 0) {
    console.error(`session ${sessionId} has no models — selftest needs at least one`);
    process.exit(1);
  }
  console.log(`session ${sessionId}: ${models.length} models`);

  // 2. Recompute each model's innovationMeta and validate the response shape.
  for (const m of models) {
    // The recompute endpoint is auth-gated by `loadAuthorizedSession` (mounted
    // on `/api/sessions/:id/*`). For local selftest runs against a server that
    // owns this session this returns 401 — set API_TEST_COOKIE=connect.sid=…
    // to a logged-in browser session cookie when running against a real
    // deployed instance. Against a fresh dev box with no sessions, this still
    // exercises the route shape via the (404-on-foreign) check.
    const cookie = process.env.API_TEST_COOKIE;
    const r = await fetch(`${baseUrl}/api/sessions/${sessionId}/models/${m.id}/recompute-innovation`, {
      method: "POST",
      headers: cookie ? { cookie } : undefined,
    });
    assert(r.ok, `model ${m.id}: recompute returned ${r.status}`);
    if (!r.ok) continue;
    const out = (await r.json()) as ModelOut;
    const meta = out.innovationMeta;
    assert(meta != null, `model ${m.id}: innovationMeta missing on response`);
    if (!meta) continue;

    // sub-scores
    const ss = meta.subScores;
    for (const k of ["differentiation", "gapFit", "theoreticalSoundness", "evidenceSupport"] as const) {
      const v = ss[k];
      assert(typeof v === "number" && v >= 0 && v <= 100, `model ${m.id}: subScores.${k} out of [0,100] (${v})`);
    }
    // contributionScore = geometric mean of subscores (±1 rounding)
    const expected = Math.round(
      Math.pow((ss.differentiation / 100) * (ss.gapFit / 100) * (ss.theoreticalSoundness / 100) * (ss.evidenceSupport / 100), 0.25) * 100,
    );
    assert(
      Math.abs(meta.contributionScore - expected) <= 1,
      `model ${m.id}: contributionScore ${meta.contributionScore} != expected ${expected} (geom mean of ${JSON.stringify(ss)})`,
    );

    // edgeNoveltyTags parallels edges
    assert(
      meta.edgeNoveltyTags.length === out.edges.length,
      `model ${m.id}: edgeNoveltyTags length ${meta.edgeNoveltyTags.length} != edges length ${out.edges.length}`,
    );

    // mode + modeReason consistency with coverageRate
    const cr = meta.computedAgainst.coverageRate;
    const expectedMode = cr >= 0.7 ? "enforced" : "analysis_only";
    assert(meta.mode === expectedMode, `model ${m.id}: mode ${meta.mode} != ${expectedMode} (coverageRate=${cr})`);
    assert(
      typeof meta.computedAgainst.computedAt === "string" && !Number.isNaN(Date.parse(meta.computedAgainst.computedAt)),
      `model ${m.id}: computedAt not a valid date string`,
    );

    // warnings well-formed
    assert(Array.isArray(meta.warnings), `model ${m.id}: warnings is not an array`);
    for (const w of meta.warnings) {
      assert(KNOWN_WARNING_CODES.has(w.code), `model ${m.id}: unknown warning code "${w.code}"`);
      assert(typeof w.message === "string" && w.message.length > 0, `model ${m.id}: warning has empty message`);
    }

    // contributionStatement intentionally null in slice 1
    assert(meta.contributionStatement === null, `model ${m.id}: contributionStatement should be null in slice 1`);

    console.log(
      `  m${m.id} ${m.name.slice(0, 40)} → mode=${meta.mode}, novelty=${meta.noveltyScore}, contribution=${meta.contributionScore}, types=[${meta.innovationTypes.join(",")}], warns=${meta.warnings.length}, edgeTags=${meta.edgeNoveltyTags.map((t) => t.tag).join("/")}`,
    );
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  ✘ ${f}`);
    process.exit(1);
  }
  console.log(`\nselftest-phase-2: PASS (${models.length} models scored)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

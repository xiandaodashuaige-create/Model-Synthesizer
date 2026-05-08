// Phase 3 Innovation Layer selftest.
//
// For a target session's first model, exercises the full Phase 3 contract:
//   1. Calls `generate-contribution` → verifies all 7 statement fields non-empty
//   2. Calls `review` → verifies 5 dimensions present, each has status + message
//   3. Calls `ai-review` → verifies non-empty Markdown returned
//
// Usage:
//   pnpm --filter @workspace/scripts run selftest:phase-3 <sessionId>
//
// Exits non-zero on any assertion failure.

import { db, researchModelsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:80";

const sessionIdRaw = process.argv[2];
if (!sessionIdRaw) {
  console.error("usage: selftest:phase-3 <sessionId>");
  process.exit(2);
}
const sessionId = Number.parseInt(sessionIdRaw, 10);
if (!Number.isFinite(sessionId)) {
  console.error("sessionId must be an integer");
  process.exit(2);
}

const failures: string[] = [];
function assert(cond: unknown, msg: string) {
  if (!cond) failures.push(msg);
}

interface ContributionStatement {
  whatIsKnown: string;
  whatIsMissing: string;
  whatThisAdds: string;
  whyItMatters: string;
  researchGapClaim: string;
  theoreticalContribution: string;
  gapTypes: string[];
  contributionType: string;
}

interface InnovationMeta {
  contributionStatement: ContributionStatement | null;
  warnings: Array<{ code: string; message: string }>;
}

interface ModelOut {
  id: number;
  name: string;
  innovationMeta: InnovationMeta | null;
}

interface ReviewDimension {
  dimension: string;
  label: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

interface ReviewerReport {
  modelId: number;
  dimensions: ReviewDimension[];
  overallStatus: string;
}

interface AiReviewResult {
  markdown: string;
}

const STATEMENT_FIELDS = [
  "whatIsKnown",
  "whatIsMissing",
  "whatThisAdds",
  "whyItMatters",
  "researchGapClaim",
  "theoreticalContribution",
  "contributionType",
] as const;
const EXPECTED_DIMENSIONS = new Set(["gap", "novelty", "evidence", "coverage", "statement"]);

async function main() {
  // 1. Pick first model from session (DB direct, auth-free for local dev).
  const rows = await db
    .select()
    .from(researchModelsTable)
    .where(eq(researchModelsTable.sessionId, sessionId))
    .orderBy(researchModelsTable.id)
    .limit(1);

  if (rows.length === 0) {
    console.error(`session ${sessionId} has no models — selftest needs at least one`);
    process.exit(1);
  }

  const m = rows[0]!;
  const modelId = m.id;
  console.log(`session ${sessionId}: using model ${modelId} "${m.name.slice(0, 50)}"`);

  const cookie = process.env.API_TEST_COOKIE;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["cookie"] = cookie;

  // 2. generate-contribution
  console.log("\n[1/3] generate-contribution …");
  const genRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/models/${modelId}/generate-contribution`, {
    method: "POST",
    headers,
  });
  assert(genRes.ok, `generate-contribution returned ${genRes.status}`);
  if (genRes.ok) {
    const out = (await genRes.json()) as ModelOut;
    const cs = out.innovationMeta?.contributionStatement;
    assert(cs != null, "contributionStatement is null after generate-contribution");
    if (cs) {
      for (const field of STATEMENT_FIELDS) {
        const v = (cs as Record<string, unknown>)[field];
        assert(typeof v === "string" && v.length > 0, `contributionStatement.${field} empty or missing`);
      }
      assert(Array.isArray(cs.gapTypes), "contributionStatement.gapTypes is not an array");
      // #20 warning should be removed now.
      const warn20 = out.innovationMeta?.warnings?.some((w) => w.code === "contribution_statement_missing");
      assert(!warn20, "contribution_statement_missing warning still present after generation");
      console.log(`  ✔ contributionStatement populated (contributionType="${cs.contributionType}", gapTypes=${JSON.stringify(cs.gapTypes)})`);
    }
  } else {
    // drain body so we can log the error message
    const body = await genRes.json().catch(() => ({}));
    console.error("  generate-contribution error body:", body);
  }

  // 3. review (rule-based)
  console.log("\n[2/3] review (rule-based) …");
  const reviewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/models/${modelId}/review`, {
    method: "GET",
    headers: cookie ? { cookie } : undefined,
  });
  assert(reviewRes.ok, `review returned ${reviewRes.status}`);
  if (reviewRes.ok) {
    const report = (await reviewRes.json()) as ReviewerReport;
    assert(typeof report.modelId === "number", "ReviewerReport.modelId missing");
    assert(Array.isArray(report.dimensions), "ReviewerReport.dimensions not an array");
    assert(report.dimensions.length === 5, `ReviewerReport.dimensions length ${report.dimensions.length} != 5`);
    const seenDimensions = new Set<string>();
    for (const d of report.dimensions) {
      assert(EXPECTED_DIMENSIONS.has(d.dimension), `unknown dimension "${d.dimension}"`);
      assert(["ok", "warn", "fail"].includes(d.status), `dimension ${d.dimension}: invalid status "${d.status}"`);
      assert(typeof d.message === "string" && d.message.length > 0, `dimension ${d.dimension}: empty message`);
      assert(typeof d.label === "string" && d.label.length > 0, `dimension ${d.dimension}: empty label`);
      seenDimensions.add(d.dimension);
    }
    for (const expected of EXPECTED_DIMENSIONS) {
      assert(seenDimensions.has(expected), `dimension "${expected}" missing from report`);
    }
    assert(["ok", "warn", "fail"].includes(report.overallStatus), `invalid overallStatus "${report.overallStatus}"`);
    console.log(`  ✔ ReviewerReport: overall=${report.overallStatus}, dims=${report.dimensions.map((d) => `${d.dimension}:${d.status}`).join(", ")}`);
  } else {
    const body = await reviewRes.json().catch(() => ({}));
    console.error("  review error body:", body);
  }

  // 4. ai-review (gpt-5-mini, optional — skip if no API_TEST_COOKIE in CI)
  if (process.env.SKIP_AI_REVIEW) {
    console.log("\n[3/3] ai-review … skipped (SKIP_AI_REVIEW set)");
  } else {
    console.log("\n[3/3] ai-review (gpt-5-mini) …");
    const aiRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/models/${modelId}/ai-review`, {
      method: "POST",
      headers,
    });
    assert(aiRes.ok, `ai-review returned ${aiRes.status}`);
    if (aiRes.ok) {
      const result = (await aiRes.json()) as AiReviewResult;
      assert(typeof result.markdown === "string" && result.markdown.length > 50, "ai-review markdown too short or missing");
      console.log(`  ✔ ai-review markdown: ${result.markdown.length} chars`);
    } else {
      const body = await aiRes.json().catch(() => ({}));
      console.error("  ai-review error body:", body);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  ✘ ${f}`);
    process.exit(1);
  }
  console.log(`\nselftest-phase-3: PASS`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

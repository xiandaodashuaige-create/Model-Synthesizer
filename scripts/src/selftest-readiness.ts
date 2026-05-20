// Regression tests for model-readiness.ts rules R2–R9.
//
// Pure function tests — no DB, no server, no AI calls.
// Run: pnpm --filter @workspace/scripts run selftest:readiness
//
// Exits non-zero on any assertion failure.

import { checkModelGenerationReadiness } from "../../artifacts/api-server/src/lib/model-readiness.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function makeVar(overrides: Partial<{
  id: number; type: string; name: string; paperId: number | null; canonicalConstructId: string | null;
}>) {
  return {
    id: overrides.id ?? 1,
    type: overrides.type ?? "independent",
    name: overrides.name ?? "variable",
    paperId: overrides.paperId ?? 1,
    canonicalConstructId: overrides.canonicalConstructId ?? null,
  };
}

// ---------------------------------------------------------------------------
// R2 — no IVs
// ---------------------------------------------------------------------------
console.log("\nR2 — no IVs");
{
  const r = checkModelGenerationReadiness({
    variables: [makeVar({ type: "dependent", name: "dv", paperId: 1 })],
    focusVariableIds: [],
    crCount: 5,
  });
  assert(r.status === "blocked", "blocked when no IVs");
  assert(r.issues.some((i) => i.type === "no_iv" && i.severity === "blocking"), "has no_iv blocking issue");
}

// ---------------------------------------------------------------------------
// R3 — no DVs
// ---------------------------------------------------------------------------
console.log("\nR3 — no DVs");
{
  const r = checkModelGenerationReadiness({
    variables: [makeVar({ type: "independent", name: "iv", paperId: 1 })],
    focusVariableIds: [],
    crCount: 5,
  });
  assert(r.status === "blocked", "blocked when no DVs");
  assert(r.issues.some((i) => i.type === "no_dv" && i.severity === "blocking"), "has no_dv blocking issue");
}

// ---------------------------------------------------------------------------
// R4 — too many DVs, no focused DV
// ---------------------------------------------------------------------------
console.log("\nR4 — too many DVs without focused target");
{
  const dvs = Array.from({ length: 9 }, (_, i) =>
    makeVar({ id: 100 + i, type: "dependent", name: `dv${i}`, paperId: i + 1, canonicalConstructId: `cid:${i}` }),
  );
  const iv = makeVar({ id: 1, type: "independent", name: "iv", paperId: 1 });
  const r = checkModelGenerationReadiness({
    variables: [iv, ...dvs],
    focusVariableIds: [],
    crCount: 5,
  });
  assert(r.status === "blocked", "blocked when 9 DVs, no focus");
  assert(r.issues.some((i) => i.type === "too_many_dvs"), "has too_many_dvs issue");
  assert(r.candidateDvs.length > 0, "candidateDvs populated");
}

// R4 — NOT triggered when a focused DV is present
console.log("\nR4 — not triggered when focused DV present");
{
  const dvs = Array.from({ length: 9 }, (_, i) =>
    makeVar({ id: 100 + i, type: "dependent", name: `dv${i}`, paperId: i + 1, canonicalConstructId: `cid:dv${i}` }),
  );
  const iv = makeVar({ id: 1, type: "independent", name: "iv", paperId: 1 });
  const r = checkModelGenerationReadiness({
    variables: [iv, ...dvs],
    focusVariableIds: [100],  // focus on first DV
    crCount: 5,
  });
  assert(!r.issues.some((i) => i.type === "too_many_dvs"), "no too_many_dvs when focused DV present");
}

// ---------------------------------------------------------------------------
// R5 — low paper count (warning)
// ---------------------------------------------------------------------------
console.log("\nR5 — low paper count warning");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ type: "independent", paperId: 1, canonicalConstructId: "cid:1" }),
      makeVar({ id: 2, type: "dependent", name: "dv", paperId: 2, canonicalConstructId: "cid:2" }),
    ],
    focusVariableIds: [],
    crCount: 5,
  });
  assert(r.issues.some((i) => i.type === "low_paper_count" && i.severity === "warning"), "low_paper_count warning for 2 papers");
}

// ---------------------------------------------------------------------------
// R6 — all single-paper (blocking, only when paper count < 3)
// ---------------------------------------------------------------------------
console.log("\nR6 — all single-paper variables (paper count < 3)");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ id: 1, type: "independent", name: "iv1", paperId: 1, canonicalConstructId: "cid:A" }),
      makeVar({ id: 2, type: "dependent", name: "dv1", paperId: 2, canonicalConstructId: "cid:B" }),
    ],
    focusVariableIds: [],
    crCount: 5,
  });
  assert(r.issues.some((i) => i.type === "all_single_paper_variables" && i.severity === "blocking"), "all_single_paper_variables fires for 2 unique papers");
}

// R6 — NOT triggered when paper count >= 3 (R9 handles that)
console.log("\nR6 — not triggered when paper count >= 3");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ id: 1, type: "independent", name: "iv1", paperId: 1, canonicalConstructId: "cid:A" }),
      makeVar({ id: 2, type: "dependent", name: "dv1", paperId: 2, canonicalConstructId: "cid:B" }),
      makeVar({ id: 3, type: "independent", name: "iv2", paperId: 3, canonicalConstructId: "cid:C" }),
    ],
    focusVariableIds: [],
    crCount: 5,
  });
  assert(!r.issues.some((i) => i.type === "all_single_paper_variables"), "all_single_paper_variables does NOT fire for 3 papers");
}

// ---------------------------------------------------------------------------
// R9 — no cross-paper overlap (blocking, >= 3 papers, no intent)
// ---------------------------------------------------------------------------
console.log("\nR9 — no cross-paper overlap, no intent → blocking");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ id: 1, type: "independent", name: "iv1", paperId: 1, canonicalConstructId: "cid:A" }),
      makeVar({ id: 2, type: "dependent", name: "dv1", paperId: 2, canonicalConstructId: "cid:B" }),
      makeVar({ id: 3, type: "independent", name: "iv2", paperId: 3, canonicalConstructId: "cid:C" }),
    ],
    focusVariableIds: [],
    crCount: 5,
  });
  assert(r.issues.some((i) => i.type === "no_cross_paper_overlap" && i.severity === "blocking"), "no_cross_paper_overlap fires as blocking without intent");
  assert(r.status === "blocked", "status is blocked");
}

// R9 — warning when user has userPrompt
console.log("\nR9 — no cross-paper overlap + userPrompt → warning");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ id: 1, type: "independent", name: "iv1", paperId: 1, canonicalConstructId: "cid:A" }),
      makeVar({ id: 2, type: "dependent", name: "dv1", paperId: 2, canonicalConstructId: "cid:B" }),
      makeVar({ id: 3, type: "independent", name: "iv2", paperId: 3, canonicalConstructId: "cid:C" }),
    ],
    focusVariableIds: [],
    crCount: 5,
    userPrompt: "研究信任对购买意愿的影响",
  });
  assert(r.issues.some((i) => i.type === "no_cross_paper_overlap" && i.severity === "warning"), "no_cross_paper_overlap fires as warning with userPrompt");
  assert(r.status !== "blocked", "status is not blocked (warning)");
}

// R9 — warning when user has focusVariableIds
console.log("\nR9 — no cross-paper overlap + focusVariableIds → warning");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ id: 1, type: "independent", name: "iv1", paperId: 1, canonicalConstructId: "cid:A" }),
      makeVar({ id: 2, type: "dependent", name: "dv1", paperId: 2, canonicalConstructId: "cid:B" }),
      makeVar({ id: 3, type: "independent", name: "iv2", paperId: 3, canonicalConstructId: "cid:C" }),
    ],
    focusVariableIds: [2],
    crCount: 5,
  });
  assert(r.issues.some((i) => i.type === "no_cross_paper_overlap" && i.severity === "warning"), "no_cross_paper_overlap fires as warning with focusVariableIds");
}

// R9 — NOT triggered when at least 1 shared construct exists
console.log("\nR9 — not triggered when ≥1 shared construct");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ id: 1, type: "independent", name: "trust", paperId: 1, canonicalConstructId: "cid:trust" }),
      makeVar({ id: 2, type: "independent", name: "trust", paperId: 2, canonicalConstructId: "cid:trust" }),  // same construct, paper 2
      makeVar({ id: 3, type: "dependent", name: "purchase", paperId: 3, canonicalConstructId: "cid:purchase" }),
    ],
    focusVariableIds: [],
    crCount: 5,
  });
  assert(!r.issues.some((i) => i.type === "no_cross_paper_overlap"), "no_cross_paper_overlap does NOT fire when construct shared across papers");
}

// ---------------------------------------------------------------------------
// R7 — no construct relationships
// ---------------------------------------------------------------------------
console.log("\nR7 — no construct relationships");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ id: 1, type: "independent", name: "trust", paperId: 1, canonicalConstructId: "cid:trust" }),
      makeVar({ id: 2, type: "independent", name: "trust", paperId: 2, canonicalConstructId: "cid:trust" }),
      makeVar({ id: 3, type: "dependent", name: "purchase", paperId: 3, canonicalConstructId: "cid:purchase" }),
    ],
    focusVariableIds: [],
    crCount: 0,
  });
  assert(r.issues.some((i) => i.type === "no_construct_relationships" && i.severity === "warning"), "no_construct_relationships warning when crCount=0");
}

// ---------------------------------------------------------------------------
// R8 — domain mismatch
// ---------------------------------------------------------------------------
console.log("\nR8 — domain mismatch (bio/engineering)");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ id: 1, type: "independent", name: "protein expression", paperId: 1 }),
      makeVar({ id: 2, type: "independent", name: "enzyme kinetics", paperId: 1 }),
      makeVar({ id: 3, type: "independent", name: "receptor binding", paperId: 2 }),
      makeVar({ id: 4, type: "dependent", name: "gene expression", paperId: 2 }),
    ],
    focusVariableIds: [],
    crCount: 5,
  });
  assert(r.issues.some((i) => i.type === "domain_mismatch_suspected" && i.severity === "warning"), "domain_mismatch_suspected warning for bio/engineering variables");
}

// ---------------------------------------------------------------------------
// Happy path — no issues
// ---------------------------------------------------------------------------
console.log("\nHappy path — clean session with shared construct");
{
  const r = checkModelGenerationReadiness({
    variables: [
      makeVar({ id: 1, type: "independent", name: "trust", paperId: 1, canonicalConstructId: "cid:trust" }),
      makeVar({ id: 2, type: "independent", name: "trust", paperId: 2, canonicalConstructId: "cid:trust" }),
      makeVar({ id: 3, type: "independent", name: "usability", paperId: 3, canonicalConstructId: "cid:usability" }),
      makeVar({ id: 4, type: "dependent", name: "purchase intention", paperId: 1, canonicalConstructId: "cid:pi" }),
      makeVar({ id: 5, type: "dependent", name: "purchase intention", paperId: 2, canonicalConstructId: "cid:pi" }),
    ],
    focusVariableIds: [],
    crCount: 10,
  });
  assert(r.status === "ok" || r.status === "warning", "clean session: status ok or warning (not blocked)");
  assert(!r.issues.some((i) => i.severity === "blocking"), "clean session: no blocking issues");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nSome tests FAILED");
  process.exit(1);
}
console.log("All tests passed ✓");

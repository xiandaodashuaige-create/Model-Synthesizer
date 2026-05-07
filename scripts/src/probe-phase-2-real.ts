// One-off probe: verify Phase 2 innovation scoring on a session that has a
// real (non-empty) landscape, instead of session 11 which has 0 CR rows.
//
// What it does:
//   1. Inserts a SYNTHETIC research_model into the target session whose edges
//      are mixed on purpose:
//        - 3 edges that exactly match high-occurrence CR rows
//          (expected: NOT "novel" — should be `underexplored` / `established`)
//        - 2 brand-new edges (expected: "novel")
//        - 1 mediator triple inserted on a known direct edge
//          (expected: `mechanism_inserted` if the direct edge is saturated)
//        - 1 moderator targeting a known direct edge
//          (expected: `boundary_extended` candidate)
//   2. Calls computeInnovationMeta (with a shared snapshot, same path the
//      generation route uses) and prints the resulting tag distribution.
//   3. Deletes the synthetic model so the session UI is unaffected.
//
// We import innovation-scoring directly via a relative path. Scripts normally
// shouldn't reach into artifacts/*, but this is a one-shot dev probe — not
// production — and avoids needing an authed cookie or a temporary public
// route. tsx resolves the .ts source at runtime.
//
// Usage:
//   pnpm --filter @workspace/scripts run probe:phase-2-real <sessionId>

import { db, researchModelsTable, constructRelationshipsTable, sessionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { computeInnovationMeta, loadLandscapeSnapshot } from "../../artifacts/api-server/src/lib/innovation-scoring.js";

const sessionId = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isFinite(sessionId)) {
  console.error("usage: probe:phase-2-real <sessionId>");
  process.exit(2);
}

async function main() {
  // 1. Sanity: confirm the session has a real landscape.
  const [sess] = await db
    .select({ landscapeMeta: sessionsTable.landscapeMeta, topic: sessionsTable.topic })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));
  if (!sess) {
    console.error(`session ${sessionId} not found`);
    process.exit(1);
  }
  const lm = sess.landscapeMeta as {
    landscapeVersion?: number;
    landscapeCoverage?: { coverageRate?: number; totalEligiblePaperCount?: number; extractedWithInnovationFieldsCount?: number };
  } | null;
  console.log(`session ${sessionId}: lv=${lm?.landscapeVersion}, coverage=${JSON.stringify(lm?.landscapeCoverage)}`);

  // 2. Pick the top 3 high-occurrence direct CR edges and 1 saturated edge if any.
  const topCrs = await db
    .select()
    .from(constructRelationshipsTable)
    .where(eq(constructRelationshipsTable.sessionId, sessionId))
    .orderBy(desc(constructRelationshipsTable.totalOccurrences))
    .limit(20);
  const directs = topCrs.filter((r) => r.relationshipType === "direct");
  if (directs.length < 3) {
    console.error("not enough direct CR rows to build a representative seed");
    process.exit(1);
  }
  const e1 = directs[0]!;
  const e2 = directs[1]!;
  const e3 = directs[2]!;
  const saturated = directs.find((r) => r.totalOccurrences >= 7);

  // 3. Build the synthetic seed.
  const nodes: Array<{ variableName: string; type: string }> = [];
  const seen = new Set<string>();
  const addNode = (name: string, type: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    nodes.push({ variableName: name, type });
  };

  // Three known-edges → underexplored / established
  addNode(e1.canonicalFrom, "independent");
  addNode(e1.canonicalTo, "dependent");
  addNode(e2.canonicalFrom, "independent");
  addNode(e2.canonicalTo, "dependent");
  addNode(e3.canonicalFrom, "independent");
  addNode(e3.canonicalTo, "dependent");
  // Two novel nodes
  addNode("ai broadcast intensity", "independent");
  addNode("social overload", "moderator");
  // Mediator and moderator targets
  if (saturated) {
    addNode(saturated.canonicalFrom, "independent");
    addNode("perceived engagement", "mediator");
    addNode(saturated.canonicalTo, "dependent");
  }

  const edges: Array<{
    fromVariableName: string;
    toVariableName: string;
    relationship: string;
    moderatedEdge?: { from: string; to: string };
  }> = [
    { fromVariableName: e1.canonicalFrom, toVariableName: e1.canonicalTo, relationship: e1.sign === "negative" ? "negative" : "positive" },
    { fromVariableName: e2.canonicalFrom, toVariableName: e2.canonicalTo, relationship: e2.sign === "negative" ? "negative" : "positive" },
    { fromVariableName: e3.canonicalFrom, toVariableName: e3.canonicalTo, relationship: e3.sign === "negative" ? "negative" : "positive" },
    // Novel direct edges
    { fromVariableName: "ai broadcast intensity", toVariableName: e1.canonicalTo, relationship: "positive" },
    { fromVariableName: "ai broadcast intensity", toVariableName: e3.canonicalTo, relationship: "positive" },
    // Moderator targeting an existing direct edge → boundary_extended candidate
    {
      fromVariableName: "social overload",
      toVariableName: e1.canonicalTo,
      relationship: "moderates",
      moderatedEdge: { from: e1.canonicalFrom, to: e1.canonicalTo },
    },
  ];
  if (saturated) {
    edges.push(
      { fromVariableName: saturated.canonicalFrom, toVariableName: "perceived engagement", relationship: "mediates" },
      { fromVariableName: "perceived engagement", toVariableName: saturated.canonicalTo, relationship: "mediates" },
      { fromVariableName: saturated.canonicalFrom, toVariableName: saturated.canonicalTo, relationship: saturated.sign === "negative" ? "negative" : "positive" },
    );
  }

  console.log(`\nseed: ${nodes.length} nodes, ${edges.length} edges`);
  for (const e of edges) {
    console.log(`  ${e.fromVariableName}  --[${e.relationship}]-->  ${e.toVariableName}${e.moderatedEdge ? ` (moderates ${e.moderatedEdge.from}→${e.moderatedEdge.to})` : ""}`);
  }

  // 4. Insert + score + cleanup. Always cleanup, even on error.
  const [inserted] = await db
    .insert(researchModelsTable)
    .values({
      sessionId,
      name: "[probe-phase-2-real] synthetic seed",
      description: "transient probe model — safe to delete",
      rationale: "[BACKBONE: probe] synthetic edges to verify Phase 2 scoring against real CR landscape",
      nodes,
      edges,
    })
    .returning();
  if (!inserted) {
    console.error("insert failed");
    process.exit(1);
  }

  let snapshot;
  let meta;
  const t0 = Date.now();
  try {
    snapshot = await loadLandscapeSnapshot(sessionId);
    const tSnap = Date.now() - t0;
    meta = await computeInnovationMeta({ sessionId, model: inserted, snapshot });
    const tCompute = Date.now() - t0 - tSnap;
    console.log(`\ntiming: snapshot=${tSnap}ms, compute=${tCompute}ms`);
    console.log(`snapshot: ${snapshot.crByKey.size} CR keys, ${snapshot.evidencedBackbones.size} backbones, ${snapshot.sessionTopicContexts.size} contexts`);
  } finally {
    await db.delete(researchModelsTable).where(eq(researchModelsTable.id, inserted.id));
    console.log(`(synthetic model id=${inserted.id} deleted)`);
  }
  if (!meta) return;

  // 5. Report.
  console.log("\n=== innovationMeta ===");
  console.log(`mode:            ${meta.mode} (${meta.modeReason})`);
  console.log(`coverageRate:    ${meta.computedAgainst.coverageRate}`);
  console.log(`landscapeVersion:${meta.computedAgainst.landscapeVersion}`);
  console.log(`noveltyScore:    ${meta.noveltyScore}`);
  console.log(`contributionScore: ${meta.contributionScore}`);
  console.log(`subScores:       ${JSON.stringify(meta.subScores)}`);
  console.log(`innovationTypes: [${meta.innovationTypes.join(", ")}]`);
  console.log(`warnings:        ${meta.warnings.length === 0 ? "(none)" : meta.warnings.map((w) => `${w.code}: ${w.message}`).join(" | ")}`);
  console.log(`\nedge tags (${meta.edgeNoveltyTags.length} of ${edges.length}):`);
  const tagCounts: Record<string, number> = {};
  for (const t of meta.edgeNoveltyTags) {
    tagCounts[t.tag] = (tagCounts[t.tag] ?? 0) + 1;
    const e = edges[t.edgeIndex]!;
    console.log(`  [${t.tag}] (${t.subscore})  ${e.fromVariableName} -[${e.relationship}]-> ${e.toVariableName}`);
  }
  console.log(`\ntag distribution: ${JSON.stringify(tagCounts)}`);

  // 6. Verdict.
  const issues: string[] = [];
  if (meta.edgeNoveltyTags.length !== edges.length) issues.push(`edge tag count mismatch: ${meta.edgeNoveltyTags.length} vs ${edges.length}`);
  const allNovel = meta.edgeNoveltyTags.every((t) => t.tag === "novel");
  if (allNovel) issues.push("ALL edges tagged 'novel' — CR snapshot lookup may be broken (canonicalize mismatch?)");
  if (meta.computedAgainst.landscapeVersion !== lm?.landscapeVersion) {
    issues.push(`landscapeVersion mismatch: meta=${meta.computedAgainst.landscapeVersion} session=${lm?.landscapeVersion}`);
  }
  const expectedMode = (meta.computedAgainst.coverageRate >= 0.7) ? "enforced" : "analysis_only";
  if (meta.mode !== expectedMode) issues.push(`mode ${meta.mode} != expected ${expectedMode}`);

  if (issues.length === 0) {
    console.log("\nprobe: PASS — Phase 2 scoring sees the real landscape correctly.");
  } else {
    console.error("\nprobe: ISSUES");
    for (const i of issues) console.error(`  ✘ ${i}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

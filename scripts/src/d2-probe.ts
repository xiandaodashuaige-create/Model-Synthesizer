/**
 * D2 probe: re-extract a single paper end-to-end with the Phase-1 prompt and
 * dump the new structured fields (theoryBackbone, statedGaps, studyContext)
 * plus the inserted variables/hypotheses for human verification.
 *
 * Usage: pnpm --filter @workspace/scripts run d2-probe -- <paperId>
 */
import { eq, and } from "drizzle-orm";
import { db, papersTable, variablesTable, paperHypothesesTable } from "@workspace/db";
import {
  extractAndStorePaperVariables,
  ExtractionError,
} from "../../artifacts/api-server/src/lib/paper-extraction.js";

const log = {
  warn: (obj: unknown, msg?: string) => console.warn("[warn]", msg ?? "", JSON.stringify(obj)),
  error: (obj: unknown, msg?: string) => console.error("[error]", msg ?? "", JSON.stringify(obj)),
};

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const paperIdArg = args[0];
  if (!paperIdArg) {
    console.error("Usage: d2-probe <paperId>");
    process.exit(1);
  }
  const paperId = Number(paperIdArg);

  const [paper] = await db.select().from(papersTable).where(eq(papersTable.id, paperId));
  if (!paper) {
    console.error(`Paper ${paperId} not found`);
    process.exit(1);
  }

  console.log("=".repeat(80));
  console.log(`D2 probe: re-extract paper ${paper.id} (${paper.externalId ?? "no external id"})`);
  console.log(`  title: ${paper.title}`);
  console.log(`  session: ${paper.sessionId} | year: ${paper.year ?? "?"} | fullText: ${paper.fullText?.length ?? 0} chars`);
  console.log("=".repeat(80));

  // BEFORE snapshot
  const beforeVars = await db
    .select()
    .from(variablesTable)
    .where(and(eq(variablesTable.paperId, paper.id), eq(variablesTable.sessionId, paper.sessionId)));
  const beforeHyps = await db
    .select()
    .from(paperHypothesesTable)
    .where(and(eq(paperHypothesesTable.paperId, paper.id), eq(paperHypothesesTable.sessionId, paper.sessionId)));
  console.log(`\nBEFORE: ${beforeVars.length} variables, ${beforeHyps.length} hypotheses`);
  console.log(`BEFORE theoryBackbone: ${JSON.stringify(paper.theoryBackbone ?? [])}`);
  console.log(`BEFORE statedGaps:     ${JSON.stringify(paper.statedGaps ?? [])}`);
  console.log(`BEFORE studyContext:   ${JSON.stringify(paper.studyContext ?? null)}`);

  console.log("\nCalling AI… (this can take 20-40s)\n");
  const t0 = Date.now();
  let result;
  try {
    result = await extractAndStorePaperVariables(paper, log);
  } catch (err) {
    if (err instanceof ExtractionError) {
      console.error(`\nExtractionError [${err.code}]: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const ms = Date.now() - t0;
  console.log(`\nDone in ${ms} ms (parseRecovered=${result.parseRecovered}).\n`);

  // AFTER snapshot
  const [after] = await db.select().from(papersTable).where(eq(papersTable.id, paper.id));

  console.log("─── theoryBackbone (NEW) ─────────────────────────────────────");
  for (const t of after?.theoryBackbone ?? []) console.log(`  • [${t.role}] ${t.name}${t.citationText ? `\n      "${t.citationText}"` : ""}`);
  if ((after?.theoryBackbone ?? []).length === 0) console.log("  (none)");

  console.log("\n─── statedGaps (NEW) ────────────────────────────────────────");
  for (const g of after?.statedGaps ?? []) console.log(`  • [${g.type}] "${g.statement}"${g.pageOrSection ? `  @ ${g.pageOrSection}` : ""}`);
  if ((after?.statedGaps ?? []).length === 0) console.log("  (none)");

  console.log("\n─── studyContext (NEW) ──────────────────────────────────────");
  console.log(`  ${JSON.stringify(after?.studyContext ?? null, null, 2)}`);

  console.log("\n─── variables (re-extracted) ────────────────────────────────");
  for (const v of result.insertedVariables) {
    console.log(`  [${v.type}/${v.constructLayer ?? "—"}] ${v.name}  ⇒  canonical='${v.canonicalConstructId}'`);
  }
  console.log(`  (${result.insertedVariables.length} variables, ${result.hypothesesInsertedCount} hypotheses)`);

  console.log("\n─── hypotheses sample (first 8) ────────────────────────────");
  const hyps = await db
    .select()
    .from(paperHypothesesTable)
    .where(and(eq(paperHypothesesTable.paperId, paper.id), eq(paperHypothesesTable.sessionId, paper.sessionId)))
    .limit(8);
  for (const h of hyps) {
    const via = h.viaVariable ? ` (via ${h.viaVariable})` : "";
    console.log(`  ${h.hypothesisId}  ${h.fromVariable}  --[${h.relationship}]-->  ${h.toVariable}${via}`);
  }

  console.log("\nD2 probe complete. Landscape rebuild was scheduled (debounced ~1.5s).");
  await new Promise((r) => setTimeout(r, 2500));
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});

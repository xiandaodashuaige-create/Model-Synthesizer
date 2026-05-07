/**
 * Pilot re-extraction: run the Phase-1 extraction prompt on a stratified
 * sample of papers, then aggregate quality metrics so we can decide whether
 * to do a full-session re-extract.
 *
 * The script is intentionally sequential (concurrency=1) so that:
 *   - the OpenAI rate limiter never bites,
 *   - the landscape rebuild debouncer coalesces nicely at the end,
 *   - per-paper logs interleave cleanly in stdout for human reading.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run pilot-reextract <id1> <id2> ...
 */
import { sql, eq, and } from "drizzle-orm";
import {
  db,
  papersTable,
  variablesTable,
  paperHypothesesTable,
  sessionsTable,
  constructRelationshipsTable,
} from "@workspace/db";
import {
  extractAndStorePaperVariables,
  ExtractionError,
} from "../../artifacts/api-server/src/lib/paper-extraction.js";
import { rebuildLandscape } from "../../artifacts/api-server/src/lib/literature-landscape.js";

const log = {
  warn: (obj: unknown, msg?: string) => console.warn("[warn]", msg ?? "", JSON.stringify(obj)),
  error: (obj: unknown, msg?: string) => console.error("[error]", msg ?? "", JSON.stringify(obj)),
};

// Node 24 terminates the process by default on unhandled rejections. The OpenAI
// SDK has been observed to leak a rejection from a retry that arrives after the
// main awaited promise resolves/rejects, which would silently kill the pilot
// mid-batch. Surface it instead.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.stack ?? err);
});

interface PaperReport {
  paperId: number;
  externalId: string | null;
  title: string;
  fullTextLen: number;
  abstractLen: number;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  ms?: number;
  parseRecovered?: boolean;
  variablesCount?: number;
  hypothesesCount?: number;
  theoryBackboneCount?: number;
  statedGapsCount?: number;
  gapTypeBreakdown?: Record<string, number>;
  studyContext?: Record<string, string | null> | null;
  studyContextFullness?: number; // 0..1, fraction of non-null fields
  umbrellaPresent?: boolean;
  // Hallucination heuristics — count of items we couldn't ground in the source
  suspectGapCount?: number;
  suspectTheoryCitationCount?: number;
  suspectTheoryNameCount?: number;
  // Moderation/mediation metadata preservation:
  moderationHypothesesCount?: number;
  mediationHypothesesCount?: number;
  hypothesesWithViaCount?: number;
}

function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function substringCovered(needleRaw: string, haystackNorm: string, sliceLen = 60): boolean {
  const needle = normalizeForSearch(needleRaw).slice(0, sliceLen);
  if (needle.length < 12) return true; // too short to judge
  return haystackNorm.includes(needle);
}

function nameTokensCovered(name: string, haystackNorm: string): boolean {
  const tokens = normalizeForSearch(name).split(" ").filter((t) => t.length >= 4);
  if (tokens.length === 0) return true;
  // require ≥80% of meaningful tokens to appear, allowing minor casing/spacing
  const hits = tokens.filter((t) => haystackNorm.includes(t)).length;
  return hits / tokens.length >= 0.8;
}

async function snapshotLandscape(sessionId: number) {
  const rebuilt = await rebuildLandscape(sessionId);
  const [{ count }] = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from construct_relationships where session_id = ${sessionId}
  `).then((r) => r.rows);
  const [{ signCount }] = await db.execute<{ signCount: number }>(sql`
    select count(*)::int as "signCount" from construct_relationships
    where session_id = ${sessionId} and sign_conflict = true
  `).then((r) => r.rows);
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  const meta = (session?.landscapeMeta ?? {}) as { theoryClusters?: unknown[]; landscapeVersion?: number; paperCount?: number; hypothesisCount?: number };
  return {
    rows: count,
    signConflicts: signCount,
    clusters: Array.isArray(meta.theoryClusters) ? meta.theoryClusters.length : 0,
    landscapeVersion: meta.landscapeVersion ?? null,
    paperCount: meta.paperCount ?? null,
    hypothesisCount: meta.hypothesisCount ?? null,
    rebuiltVersion: rebuilt.version,
  };
}

async function runOnePaper(paperId: number): Promise<PaperReport> {
  const [paper] = await db.select().from(papersTable).where(eq(papersTable.id, paperId));
  if (!paper) {
    return { paperId, externalId: null, title: "(not found)", fullTextLen: 0, abstractLen: 0, ok: false, errorCode: "not_found", errorMessage: "paper not found" };
  }

  const fullTextLen = paper.fullText?.length ?? 0;
  const abstractLen = paper.abstract?.length ?? 0;
  const r: PaperReport = {
    paperId,
    externalId: paper.externalId ?? null,
    title: paper.title,
    fullTextLen,
    abstractLen,
    ok: false,
  };

  console.log(`\n--- paper ${paperId}  ft=${fullTextLen}  ab=${abstractLen}  | ${paper.title.slice(0, 80)} ---`);
  const t0 = Date.now();
  try {
    // Hard wall-clock guard: the in-SDK AbortSignal.timeout(90s) has been
    // observed to be swallowed by retries. Race the call against a 120s
    // outer timer so a stuck OpenAI request never wedges the whole pilot.
    const HARD_TIMEOUT_MS = 120_000;
    const result = await Promise.race([
      extractAndStorePaperVariables(paper, log),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new ExtractionError("timeout", `outer ${HARD_TIMEOUT_MS}ms wall-clock`, 504)),
          HARD_TIMEOUT_MS,
        ),
      ),
    ]);
    r.ms = Date.now() - t0;
    r.ok = true;
    r.parseRecovered = result.parseRecovered;
    r.variablesCount = result.insertedVariables.length;
    r.hypothesesCount = result.hypothesesInsertedCount;
    r.theoryBackboneCount = result.theoryBackbone.length;
    r.statedGapsCount = result.statedGaps.length;
    r.gapTypeBreakdown = {};
    for (const g of result.statedGaps) r.gapTypeBreakdown[g.type] = (r.gapTypeBreakdown[g.type] ?? 0) + 1;
    r.studyContext = result.studyContext;
    if (result.studyContext) {
      const fields = ["objectType", "sampleType", "geography", "platform", "modality", "language"] as const;
      const filled = fields.filter((f) => result.studyContext![f] != null && String(result.studyContext![f]).trim().length > 0).length;
      r.studyContextFullness = filled / fields.length;
    } else {
      r.studyContextFullness = 0;
    }

    // Umbrella detection: any inserted variable whose name is short (1-3 words)
    // and tagged stimulus + independent — that's the convention from the prompt.
    r.umbrellaPresent = result.insertedVariables.some((v) => {
      const wc = v.name.trim().split(/\s+/).length;
      return wc >= 1 && wc <= 3 && v.type === "independent" && v.constructLayer === "stimulus";
    });

    // Hallucination heuristics — only meaningful when we have real source text.
    const sourceText = (paper.fullText && paper.fullText.length > 500)
      ? paper.fullText
      : (paper.abstract ?? "");
    if (sourceText.length > 200) {
      const haystack = normalizeForSearch(sourceText);
      r.suspectGapCount = result.statedGaps.filter((g) => !substringCovered(g.statement, haystack, 50)).length;
      r.suspectTheoryCitationCount = result.theoryBackbone.filter((t) => t.citationText && !substringCovered(t.citationText, haystack, 50)).length;
      r.suspectTheoryNameCount = result.theoryBackbone.filter((t) => !nameTokensCovered(t.name, haystack)).length;
    } else {
      r.suspectGapCount = 0;
      r.suspectTheoryCitationCount = 0;
      r.suspectTheoryNameCount = 0;
    }

    // Moderation/mediation preservation — read back from DB to be definitive.
    const hyps = await db.select().from(paperHypothesesTable)
      .where(and(eq(paperHypothesesTable.paperId, paper.id), eq(paperHypothesesTable.sessionId, paper.sessionId)));
    r.moderationHypothesesCount = hyps.filter((h) => h.relationship === "moderates").length;
    r.mediationHypothesesCount = hyps.filter((h) => h.relationship === "mediates").length;
    r.hypothesesWithViaCount = hyps.filter((h) => h.viaVariable && h.viaVariable.trim().length > 0).length;

    console.log(
      `  OK  ${r.ms}ms  vars=${r.variablesCount}  hyps=${r.hypothesesCount}  theory=${r.theoryBackboneCount}  gaps=${r.statedGapsCount} (${Object.entries(r.gapTypeBreakdown).map(([k,v])=>`${k}:${v}`).join(",")})  ctx=${(r.studyContextFullness! * 100).toFixed(0)}%  suspect: gap=${r.suspectGapCount} thCite=${r.suspectTheoryCitationCount} thName=${r.suspectTheoryNameCount}  umbrella=${r.umbrellaPresent}  parseRecovered=${r.parseRecovered}`,
    );
  } catch (err) {
    r.ms = Date.now() - t0;
    if (err instanceof ExtractionError) {
      r.errorCode = err.code;
      r.errorMessage = err.message;
      console.log(`  ERR [${err.code}] ${err.message}`);
    } else {
      const e = err as { message?: string };
      r.errorCode = "unknown";
      r.errorMessage = e?.message ?? String(err);
      console.log(`  ERR [unknown] ${r.errorMessage}`);
    }
  }
  return r;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const ids = args.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) {
    console.error("Usage: pilot-reextract <paperId1> <paperId2> ...");
    process.exit(1);
  }

  // All pilot papers must belong to the same session — pull session id from the first.
  const [first] = await db.select().from(papersTable).where(eq(papersTable.id, ids[0]));
  if (!first) {
    console.error(`Paper ${ids[0]} not found`);
    process.exit(1);
  }
  const sessionId = first.sessionId;
  console.log(`\nPilot re-extract on session ${sessionId} | ${ids.length} papers: [${ids.join(", ")}]`);

  console.log("\n=== BEFORE landscape snapshot ===");
  const before = await snapshotLandscape(sessionId);
  console.log(`  rows=${before.rows}  signConflicts=${before.signConflicts}  theoryClusters=${before.clusters}  version=${before.landscapeVersion}  papers(meta)=${before.paperCount}  hyps(meta)=${before.hypothesisCount}`);

  const reports: PaperReport[] = [];
  for (const id of ids) {
    reports.push(await runOnePaper(id));
  }

  // Allow scheduleLandscapeRebuild's debouncer to fire, then run an explicit rebuild for definitiveness.
  console.log("\n=== Forcing final landscape rebuild ===");
  await new Promise((r) => setTimeout(r, 2200));
  const after = await snapshotLandscape(sessionId);
  console.log(`  rows=${after.rows}  signConflicts=${after.signConflicts}  theoryClusters=${after.clusters}  version=${after.landscapeVersion}  papers(meta)=${after.paperCount}  hyps(meta)=${after.hypothesisCount}`);

  // Aggregate report
  const ok = reports.filter((r) => r.ok);
  const fail = reports.filter((r) => !r.ok);
  const avg = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  const gapTypeTotal: Record<string, number> = {};
  for (const r of ok) for (const [k, v] of Object.entries(r.gapTypeBreakdown ?? {})) gapTypeTotal[k] = (gapTypeTotal[k] ?? 0) + v;

  console.log("\n" + "=".repeat(80));
  console.log(" PILOT REPORT");
  console.log("=".repeat(80));
  console.log(`  papers attempted:        ${reports.length}`);
  console.log(`  papers succeeded:        ${ok.length}`);
  console.log(`  papers failed:           ${fail.length}    ${fail.map((f) => `[${f.paperId}:${f.errorCode}]`).join(" ")}`);
  console.log(`  parseRecovered:          ${ok.filter((r) => r.parseRecovered).length} / ${ok.length}`);
  console.log(`  avg latency (ms):        ${Math.round(avg(ok.map((r) => r.ms!)))}`);
  console.log(`  avg variables:           ${avg(ok.map((r) => r.variablesCount!)).toFixed(2)}`);
  console.log(`  avg hypotheses:          ${avg(ok.map((r) => r.hypothesesCount!)).toFixed(2)}`);
  console.log(`  avg theoryBackbone:      ${avg(ok.map((r) => r.theoryBackboneCount!)).toFixed(2)}`);
  console.log(`  avg statedGaps:          ${avg(ok.map((r) => r.statedGapsCount!)).toFixed(2)}`);
  console.log(`  gap type totals:         ${JSON.stringify(gapTypeTotal)}`);
  console.log(`  studyContext fullness:   ${(avg(ok.map((r) => r.studyContextFullness!)) * 100).toFixed(0)}%   (null contexts: ${ok.filter((r) => !r.studyContext).length})`);
  console.log(`  umbrella present:        ${ok.filter((r) => r.umbrellaPresent).length} / ${ok.length}`);
  console.log("");
  console.log(" Hallucination heuristics (lower is better — counts of items we could NOT find in source text)");
  console.log(`  suspect gap statements:  ${ok.reduce((s, r) => s + (r.suspectGapCount ?? 0), 0)}    (per-paper: ${ok.map((r) => r.suspectGapCount).join(",")})`);
  console.log(`  suspect theory citations: ${ok.reduce((s, r) => s + (r.suspectTheoryCitationCount ?? 0), 0)}    (per-paper: ${ok.map((r) => r.suspectTheoryCitationCount).join(",")})`);
  console.log(`  suspect theory names:    ${ok.reduce((s, r) => s + (r.suspectTheoryNameCount ?? 0), 0)}    (per-paper: ${ok.map((r) => r.suspectTheoryNameCount).join(",")})`);
  console.log("");
  console.log(" Moderation / mediation preservation");
  console.log(`  total moderation hyps:   ${ok.reduce((s, r) => s + (r.moderationHypothesesCount ?? 0), 0)}`);
  console.log(`  total mediation hyps:    ${ok.reduce((s, r) => s + (r.mediationHypothesesCount ?? 0), 0)}`);
  console.log(`  hyps with viaVariable:   ${ok.reduce((s, r) => s + (r.hypothesesWithViaCount ?? 0), 0)}`);
  console.log("");
  console.log(" Landscape delta");
  console.log(`  rows:               ${before.rows} -> ${after.rows}   (Δ ${after.rows - before.rows})`);
  console.log(`  signConflicts:      ${before.signConflicts} -> ${after.signConflicts}   (Δ ${after.signConflicts - before.signConflicts})`);
  console.log(`  theoryClusters:     ${before.clusters} -> ${after.clusters}   (Δ ${after.clusters - before.clusters})`);
  console.log(`  landscapeVersion:   ${before.landscapeVersion} -> ${after.landscapeVersion}`);

  console.log("\n" + "=".repeat(80));
  console.log(" Per-paper summary table");
  console.log("=".repeat(80));
  console.log("  id   ms     vars hyps theo gap  ctx%   umb  sGap sCit sNam err");
  for (const r of reports) {
    const row = [
      String(r.paperId).padStart(3),
      String(r.ms ?? "—").padStart(5),
      String(r.variablesCount ?? "—").padStart(4),
      String(r.hypothesesCount ?? "—").padStart(4),
      String(r.theoryBackboneCount ?? "—").padStart(4),
      String(r.statedGapsCount ?? "—").padStart(4),
      ((r.studyContextFullness ?? 0) * 100).toFixed(0).padStart(5),
      (r.umbrellaPresent ? "Y" : "n").padStart(3),
      String(r.suspectGapCount ?? "—").padStart(4),
      String(r.suspectTheoryCitationCount ?? "—").padStart(4),
      String(r.suspectTheoryNameCount ?? "—").padStart(4),
      r.errorCode ?? "",
    ];
    console.log("  " + row.join(" "));
  }
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});

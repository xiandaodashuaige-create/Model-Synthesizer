// Per-session literature landscape aggregator.
//
// Walks every paperHypothesesTable row for a session, canonicalizes the
// endpoints via @workspace/canonicalize, and writes one
// constructRelationshipsTable row per (from-key, to-key, relationshipType)
// triple. Replaces existing rows in a single transaction so the table is
// always consistent with the underlying hypotheses.
//
// Also recomputes session-level landscapeMeta (theory clusters + light
// summary; the AI gap report is generated separately by the gap-report
// route, cache-busted by the bumped landscapeVersion).
//
// O(N) in number of hypotheses. Triggered debounced from variables.ts after
// each per-paper extraction completes (see scheduleLandscapeRebuild).

import { eq } from "drizzle-orm";
import {
  db,
  papersTable,
  paperHypothesesTable,
  sessionsTable,
  constructRelationshipsTable,
  type Paper,
  type PaperHypothesis,
  type InsertConstructRelationship,
} from "@workspace/db";
import { canonicalize, type CanonicalName } from "@workspace/canonicalize";
import { logger } from "./logger.js";

// Map a hypothesis.relationship literal to (relationshipType, sign).
function mapRelationship(rel: string): { relationshipType: string; sign: "positive" | "negative" | "none" } {
  switch (rel) {
    case "positive": return { relationshipType: "direct", sign: "positive" };
    case "negative": return { relationshipType: "direct", sign: "negative" };
    case "moderates": return { relationshipType: "moderation", sign: "none" };
    case "mediates": return { relationshipType: "mediation", sign: "none" };
    default: return { relationshipType: "direct", sign: "positive" };
  }
}

// Bracketed novelty potential per docs/innovation-taxonomy.md.
// Lower occurrence count → more novel territory.
function noveltyPotential(occurrences: number): number {
  if (occurrences <= 0) return 100;
  if (occurrences === 1) return 75;
  if (occurrences <= 3) return 50;
  if (occurrences <= 6) return 25;
  return 10;
}

// Aggregation cell key — same composite Postgres uses for the unique index.
function cellKey(
  from: CanonicalName,
  to: CanonicalName,
  relationshipType: string,
): string {
  return [from.canonicalName, from.contextQualifier ?? "", to.canonicalName, to.contextQualifier ?? "", relationshipType].join("\u0001");
}

type PerPaperEvidence = {
  paperId: number;
  externalId: string;
  year: number | null;
  sign: "positive" | "negative" | "none";
  statement: string;
  hypothesisId: string;
  pageOrSection: string | null;
  studyContextSnapshot: unknown;
  // Phase 2 boundary/extension detection needs the full structural context of
  // moderator/mediator hypotheses — Phase 2 boundary check is "W moderates a
  // SPECIFIC (X,Y) edge for the first time", which can't be answered without
  // the via/from/to triple. Carried verbatim from the hypothesis row.
  viaVariable: string | null;
  // Original raw endpoint names from the hypothesis (pre-canonicalization),
  // useful for the UI ("3 papers studied 'trust' specifically as 'trust in
  // chatbot' on this edge") and for Phase 2 to detect the moderated (X,Y).
  originalFrom: string;
  originalTo: string;
};

type Cell = {
  canonicalFrom: string;
  canonicalTo: string;
  contextQualifierFrom: string | null;
  contextQualifierTo: string | null;
  relationshipType: string;
  // Per-paper sign aggregation — keyed by paperId so the same paper asserting
  // the same edge in 3 hypotheses is counted ONCE for novelty/saturation
  // brackets. Within a paper we still carry every distinct sign; if a single
  // paper itself reports both positive and negative effects the cell is
  // marked signConflict=true (rare but possible in moderated-effect papers).
  perPaperSigns: Map<number, Set<"positive" | "negative" | "none">>;
  supportingPapers: PerPaperEvidence[];
  domains: Set<string>;
  years: number[];
  paperIds: Set<number>;
};

// Pure function form, testable without a DB. Public so the self-test script
// can call it on fixture data.
export function aggregateLandscape(
  hypotheses: PaperHypothesis[],
  papersById: Map<number, Paper>,
): InsertConstructRelationship[] {
  const cells = new Map<string, Cell>();

  for (const h of hypotheses) {
    const paper = papersById.get(h.paperId);
    if (!paper) continue;
    const from = canonicalize(h.fromVariable);
    const to = canonicalize(h.toVariable);
    if (!from.canonicalName || !to.canonicalName) continue;
    const { relationshipType, sign } = mapRelationship(h.relationship);
    const key = cellKey(from, to, relationshipType);

    let cell = cells.get(key);
    if (!cell) {
      cell = {
        canonicalFrom: from.canonicalName,
        canonicalTo: to.canonicalName,
        contextQualifierFrom: from.contextQualifier,
        contextQualifierTo: to.contextQualifier,
        relationshipType,
        perPaperSigns: new Map<number, Set<"positive" | "negative" | "none">>(),
        supportingPapers: [],
        domains: new Set<string>(),
        years: [],
        paperIds: new Set<number>(),
      };
      cells.set(key, cell);
    }

    let signsForThisPaper = cell.perPaperSigns.get(paper.id);
    if (!signsForThisPaper) {
      signsForThisPaper = new Set();
      cell.perPaperSigns.set(paper.id, signsForThisPaper);
    }
    signsForThisPaper.add(sign);

    cell.supportingPapers.push({
      paperId: paper.id,
      externalId: paper.externalId,
      year: paper.year,
      sign,
      statement: h.statement,
      hypothesisId: h.hypothesisId,
      pageOrSection: h.pageOrSection,
      studyContextSnapshot: paper.studyContext ?? null,
      viaVariable: h.viaVariable,
      originalFrom: h.fromVariable,
      originalTo: h.toVariable,
    });
    // Year + domain are PAPER-level — only fold them in the FIRST time a
    // paperId shows up on this cell, so a paper with 3 hypotheses on the
    // same cell doesn't triple its year span weighting (year span is a
    // min/max so it's idempotent, but the same logic protects future
    // weighted aggregates).
    if (!cell.paperIds.has(paper.id)) {
      cell.paperIds.add(paper.id);
      if (paper.year != null) cell.years.push(paper.year);
      const ctx = paper.studyContext as { objectType?: unknown } | null;
      if (ctx && typeof ctx === "object" && typeof ctx.objectType === "string" && ctx.objectType.trim()) {
        cell.domains.add(ctx.objectType.trim().toLowerCase());
      }
    }
  }

  // Reduce each cell into the InsertConstructRelationship shape.
  const rows: InsertConstructRelationship[] = [];
  for (const cell of cells.values()) {
    // Sign aggregation: ignore "none" (moderation/mediation) entries; the
    // relationshipType already encodes those. For "direct" cells, sign is
    // either consensus or "mixed" with signConflict=true.
    //
    // We tally per DISTINCT paper, not per hypothesis, so a paper that
    // states the same direct effect three times (formal hypothesis +
    // discussion summary + abstract recap) doesn't outvote a paper that
    // states it once.
    let aggSign: string;
    let signConflict = false;
    if (cell.relationshipType !== "direct") {
      aggSign = "none";
    } else {
      let positives = 0;
      let negatives = 0;
      for (const signs of cell.perPaperSigns.values()) {
        const hasPos = signs.has("positive");
        const hasNeg = signs.has("negative");
        if (hasPos) positives++;
        if (hasNeg) negatives++;
      }
      if (positives > 0 && negatives > 0) {
        aggSign = "mixed";
        signConflict = true;
      } else if (positives > 0) {
        aggSign = "positive";
      } else if (negatives > 0) {
        aggSign = "negative";
      } else {
        aggSign = "none";
      }
    }

    // Novelty/saturation brackets are defined in terms of "how many distinct
    // papers studied this edge", NOT "how many hypothesis rows mention it".
    // Counting hypothesis rows would let one chatty paper push an edge from
    // novelty=75 (1 paper) to novelty=50 (2-3 papers) and corrupt every
    // downstream Phase 2 tag.
    const totalOccurrences = cell.paperIds.size;
    rows.push({
      // sessionId filled in by caller (rebuildLandscape) — we leave it as 0
      // here; the pure aggregator doesn't know the session.
      sessionId: 0,
      canonicalFrom: cell.canonicalFrom,
      canonicalTo: cell.canonicalTo,
      contextQualifierFrom: cell.contextQualifierFrom,
      contextQualifierTo: cell.contextQualifierTo,
      relationshipType: cell.relationshipType,
      sign: aggSign,
      signConflict,
      totalOccurrences,
      supportingPapers: cell.supportingPapers,
      earliestYear: cell.years.length ? Math.min(...cell.years) : null,
      latestYear: cell.years.length ? Math.max(...cell.years) : null,
      domainsCovered: Array.from(cell.domains).sort(),
      noveltyPotentialScore: noveltyPotential(totalOccurrences),
      landscapeVersion: 1, // bumped to actual session version by caller
    });
  }
  return rows;
}

type TheoryRef = { name?: unknown; role?: unknown };

// Compute landscapeMeta.theoryClusters from per-paper theoryBackbone arrays.
// Pure function — exported so the self-test can exercise it.
export function aggregateTheoryClusters(papers: Paper[]): Array<{
  id: string;
  label: string;
  theoryIds: string[];
  paperCount: number;
}> {
  // Group by lower-cased theory name; for each group the LABEL becomes the
  // most-common original casing. paperCount counts distinct papers (not
  // distinct mentions — a paper that lists the same theory twice still counts
  // once).
  const groups = new Map<string, { label: string; rawNames: Set<string>; paperIds: Set<number> }>();
  for (const paper of papers) {
    const refs = paper.theoryBackbone as TheoryRef[] | null;
    if (!Array.isArray(refs)) continue;
    const seenForPaper = new Set<string>();
    for (const ref of refs) {
      if (!ref || typeof ref !== "object") continue;
      const rawName = typeof ref.name === "string" ? ref.name.trim() : "";
      if (!rawName) continue;
      const key = rawName.toLowerCase();
      if (seenForPaper.has(key)) continue;
      seenForPaper.add(key);
      let g = groups.get(key);
      if (!g) {
        g = { label: rawName, rawNames: new Set(), paperIds: new Set() };
        groups.set(key, g);
      }
      g.rawNames.add(rawName);
      g.paperIds.add(paper.id);
    }
  }
  const out = Array.from(groups.entries()).map(([id, g]) => ({
    id,
    label: g.label,
    theoryIds: Array.from(g.rawNames).sort(),
    paperCount: g.paperIds.size,
  }));
  // Largest cluster first; tie-broken alphabetically for stable output.
  out.sort((a, b) => (b.paperCount - a.paperCount) || a.id.localeCompare(b.id));
  return out;
}

// Full rebuild: deletes existing constructRelationshipsTable rows for the
// session, inserts the freshly-aggregated rows, and updates landscapeMeta.
// Bumps landscapeVersion monotonically (read previous from landscapeMeta).
export async function rebuildLandscape(sessionId: number): Promise<{
  rowsWritten: number;
  version: number;
}> {
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) throw new Error(`rebuildLandscape: session ${sessionId} not found`);

  const papers = await db.select().from(papersTable).where(eq(papersTable.sessionId, sessionId));
  // Filter out the per-session sentinel paper used by manual variables — it
  // never carries hypotheses and would only pollute domain counts.
  // Drop both the manual-variable sentinel AND any paper flagged tangential
  // by the Phase 1 scope-check gate. Tangential papers carry no variables /
  // hypotheses by construction (lib/paper-extraction.ts), so this is a
  // belt-and-suspenders filter that also excludes them from theory-cluster
  // and paperCount aggregates in landscapeMeta.
  const realPapers = papers.filter((p) => !p.externalId.startsWith("manual:") && p.tangential !== true);
  const papersById = new Map(realPapers.map((p) => [p.id, p]));

  const hypotheses = await db.select().from(paperHypothesesTable).where(eq(paperHypothesesTable.sessionId, sessionId));
  // Drop hypotheses tied to the sentinel paper for the same reason.
  const realHypotheses = hypotheses.filter((h) => papersById.has(h.paperId));

  const aggregatedRows = aggregateLandscape(realHypotheses, papersById);

  const prevMeta = (session.landscapeMeta ?? {}) as { landscapeVersion?: number };
  const nextVersion = (typeof prevMeta.landscapeVersion === "number" ? prevMeta.landscapeVersion : 0) + 1;

  // Stamp sessionId + new version into every row before insert.
  const stampedRows = aggregatedRows.map((r) => ({ ...r, sessionId, landscapeVersion: nextVersion }));
  const theoryClusters = aggregateTheoryClusters(realPapers);

  await db.transaction(async (tx) => {
    await tx.delete(constructRelationshipsTable).where(eq(constructRelationshipsTable.sessionId, sessionId));
    if (stampedRows.length > 0) {
      // Chunk to keep parameter count under Postgres' 65535 limit. Each row
      // has ~14 columns, so 1000 rows = 14000 params — well below.
      const CHUNK = 1000;
      for (let i = 0; i < stampedRows.length; i += CHUNK) {
        await tx.insert(constructRelationshipsTable).values(stampedRows.slice(i, i + CHUNK));
      }
    }
    await tx.update(sessionsTable).set({
      landscapeMeta: {
        landscapeVersion: nextVersion,
        lastRebuildAt: new Date().toISOString(),
        theoryClusters,
        // gapReport is generated lazily by /landscape/gap-report; we clear
        // any stale prior report so the route knows to recompute. The route
        // also keys its cache on landscapeVersion so this is belt-and-suspenders.
        gapReport: null,
        paperCount: realPapers.length,
        hypothesisCount: realHypotheses.length,
        relationshipCount: stampedRows.length,
      },
    }).where(eq(sessionsTable.id, sessionId));
  });

  return { rowsWritten: stampedRows.length, version: nextVersion };
}

// TECH DEBT (acknowledged Phase 1 review): cross-instance concurrency. Today
// rebuildLandscape's "DELETE then INSERT" pair is safe because Replit autoscale
// runs a single instance per artifact and the in-process debouncer below
// guarantees at-most-one rebuild per sessionId at any moment. If we ever scale
// to multiple instances, two concurrent rebuilds for the same session can
// race: one instance deletes, the other inserts on top, and the first's
// insert leaves a half-overlapping landscape. When that day comes, wrap the
// transaction in `pg_advisory_xact_lock(sessionId)` so each rebuild serializes
// at the database level. Not blocking Phase 1.

// In-memory debounce: at most one rebuild per session in-flight at a time.
// If a rebuild is requested while one is running, we mark the session as
// "rebuild-again-after-this-finishes" and re-trigger when the in-flight one
// completes. Bounded coalescing — never more than 2 rebuilds queued for a
// single session regardless of how many extractions complete in parallel.
const inFlight = new Map<number, Promise<unknown>>();
const reRunRequested = new Set<number>();

export function scheduleLandscapeRebuild(sessionId: number): void {
  if (inFlight.has(sessionId)) {
    reRunRequested.add(sessionId);
    return;
  }
  const run = (async () => {
    try {
      const result = await rebuildLandscape(sessionId);
      logger.info({ sessionId, ...result }, "rebuildLandscape completed");
    } catch (err) {
      logger.error({ err, sessionId }, "rebuildLandscape failed");
    } finally {
      inFlight.delete(sessionId);
      if (reRunRequested.has(sessionId)) {
        reRunRequested.delete(sessionId);
        // Defer the re-run so the in-flight Promise fully resolves first.
        setImmediate(() => scheduleLandscapeRebuild(sessionId));
      }
    }
  })();
  inFlight.set(sessionId, run);
}

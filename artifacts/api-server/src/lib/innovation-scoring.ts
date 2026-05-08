// Phase 2 Innovation Layer — analysis-only scoring.
//
// Reads the per-session landscape (`constructRelationshipsTable` +
// `sessions.landscapeMeta`) and emits an `InnovationMeta` blob describing the
// novelty + contribution of a single research model. NEVER rejects models:
// failures of Hard Rules #20-22 are surfaced as `warnings` and `mode` is
// always `analysis_only` until landscape coverage reaches the floor (see
// `COVERAGE_FLOOR`). Phase 2 explicitly forbids hard-rejection until the
// data backing the scores is broad enough to trust.
//
// Source-of-truth: docs/innovation-taxonomy.md.

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  type ConstructRelationship,
  constructRelationshipsTable,
  papersTable,
  type ResearchModel,
  sessionsTable,
} from "@workspace/db";
import { canonicalize } from "@workspace/canonicalize";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EdgeNoveltyTag =
  | "saturated"
  | "established"
  | "underexplored"
  | "context_transferred"
  | "novel"
  | "mechanism_inserted"
  | "boundary_extended"
  | "contradicting";

// Subscores per docs/innovation-taxonomy.md. `contradicting` is two-tier — we
// expose `contradicting_resolved` internally so the per-edge subscore is
// correct; downstream UI collapses both back to the `contradicting` label.
export const EDGE_TAG_SUBSCORE: Record<EdgeNoveltyTag | "contradicting_resolved", number> = {
  saturated: 10,
  established: 25,
  underexplored: 55,
  context_transferred: 70,
  novel: 75,
  mechanism_inserted: 80,
  boundary_extended: 80,
  contradicting: 80,
  contradicting_resolved: 95,
};

// Snapshot of the CR row that the edge matched against. Null when the edge
// has no row in `constructRelationshipsTable` for any rel-type. Carried on
// every tagging so the UI can explain "why is this edge `novel` / why didn't
// it become `boundary_extended`" without round-tripping to the DB.
export interface EdgeMatchedRelationship {
  canonicalFrom: string;
  canonicalTo: string;
  relationshipType: string; // "direct" | "mediation" | "moderation"
  totalOccurrences: number;
  signConflict: boolean;
  domainsCovered: string[];
}

export interface EdgeNoveltyTagging {
  // Stable per-edge identifier (idx into model.edges).
  edgeIndex: number;
  fromVariableName: string;
  toVariableName: string;
  relationship: string; // raw model edge relationship
  tag: EdgeNoveltyTag;
  // The actual subscore used in noveltyScore (handles `contradicting_resolved`).
  subscore: number;
  // For UI tooltip — which CR row matched, if any.
  matchedTotalOccurrences: number | null;
  // Full lookup snapshot for the explainability panel. Null when no CR row
  // matched the edge for any rel-type at this canonical (from, to) pair.
  matchedRelationship: EdgeMatchedRelationship | null;
  // Human-readable zh-CN explanation of why this tag was chosen. Stable
  // enough that the UI can display it directly without templating.
  reason: string;
}

export interface InnovationSubScores {
  differentiation: number; // mean of edge subscores
  gapFit: number; // 30 floor (no claim made)
  theoreticalSoundness: number; // 30 floor
  evidenceSupport: number; // 20 floor
}

export type InnovationMode = "analysis_only" | "enforced";
export type InnovationWarningCode =
  | "contribution_statement_missing" // Hard Rule #20
  | "no_innovation_type_detected" // Hard Rule #21
  | "all_edges_low_novelty"; // Hard Rule #22 (warn-only in analysis_only mode)

export interface InnovationWarning {
  code: InnovationWarningCode;
  message: string;
}

// Phase 3: AI-emitted 7-field structured self-explanation.
// Persisted in `researchModelsTable.innovationMeta.contributionStatement`.
export interface ContributionStatement {
  whatIsKnown: string;
  whatIsMissing: string;
  whatThisAdds: string;
  whyItMatters: string;
  researchGapClaim: string;
  theoreticalContribution: string;
  gapTypes: string[];
  contributionType: string;
}

export interface InnovationMeta {
  // Per-edge novelty tagging (parallel to model.edges by index).
  edgeNoveltyTags: EdgeNoveltyTagging[];
  // Aggregate novelty (mean of edge subscores). 0..100. Null when model has
  // no edges (defensive — should not happen for an accepted model).
  noveltyScore: number | null;
  // Auto-detected innovation types (5 of 6; `context` only via Phase 3 AI).
  innovationTypes: string[];
  // 4 sub-scores feeding the geometric-mean headline.
  subScores: InnovationSubScores;
  // The headline number, geometric mean of subscores.
  contributionScore: number;
  // Phase 3 AI-emitted 7-field statement. Null until generate-contribution is called.
  contributionStatement: ContributionStatement | null;
  // Provenance: which landscape this score was computed against, when, and
  // whether the system is currently allowed to reject on it.
  computedAgainst: {
    landscapeVersion: number | null;
    coverageRate: number; // 0..1, 3 decimals
    computedAt: string; // ISO timestamp
  };
  mode: InnovationMode;
  // Reason `mode = analysis_only`, when applicable. Kept enum-y so the UI can
  // localize the banner without parsing free text.
  modeReason: "coverage_below_threshold" | "ok";
  warnings: InnovationWarning[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// `mode` flips to `enforced` only when the landscape covers at least this
// fraction of eligible papers with innovation fields populated. Below the
// floor, scoring is descriptive only.
export const COVERAGE_FLOOR = 0.7;

// CR `relationshipType` values. Keep aligned with literature-landscape.ts.
const REL_DIRECT = "direct";
const REL_MEDIATION = "mediation";
const REL_MODERATION = "moderation";

// Map model edge `relationship` → CR `relationshipType`.
function edgeRelToCrType(rel: string): string {
  const r = (rel ?? "").trim().toLowerCase();
  if (r === "moderates" || r === "moderation") return REL_MODERATION;
  if (r === "mediates" || r === "mediation") return REL_MEDIATION;
  return REL_DIRECT; // positive | negative | (anything else) treated as direct
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

// Build a Map keyed by `${canonicalKey(from)}|${canonicalKey(to)}|${relType}`
// for O(1) edge lookups against the construct relationships table.
function crKey(canonicalFrom: string, qualifierFrom: string | null, canonicalTo: string, qualifierTo: string | null, relType: string): string {
  const f = qualifierFrom ? `${canonicalFrom}|${qualifierFrom}` : canonicalFrom;
  const t = qualifierTo ? `${canonicalTo}|${qualifierTo}` : canonicalTo;
  return `${f}>>${t}::${relType}`;
}

function crKeyFromName(rawFrom: string, rawTo: string, relType: string): string {
  const f = canonicalize(rawFrom);
  const t = canonicalize(rawTo);
  return crKey(f.canonicalName, f.contextQualifier, t.canonicalName, t.contextQualifier, relType);
}

// `model.edges` is jsonb; we only depend on the fields named here.
interface ModelEdgeShape {
  fromVariableName: string;
  toVariableName: string;
  relationship: string;
  // Set on moderator edges (model-side): the (X,Y) pair this moderator
  // conditions. Optional — older rows may omit it.
  moderatedEdge?: { from?: unknown; to?: unknown } | null;
}

interface ModelNodeShape {
  variableName: string;
  type?: string; // "independent" | "mediator" | "moderator" | "dependent"
}

// ---------------------------------------------------------------------------
// Edge tag detection
// ---------------------------------------------------------------------------

// totalOccurrences → base bracket tag (saturated / established / underexplored).
function bracketByOccurrences(n: number): EdgeNoveltyTag {
  if (n >= 7) return "saturated";
  if (n >= 3) return "established";
  return "underexplored"; // 1..2
}

// Per-edge tag with single-pick precedence. Returns the chosen tag plus the
// matched CR row's totalOccurrences (null when the edge isn't in the table)
// plus a zh-CN `reason` string for the explainability panel.
interface TagDecision {
  tag: EdgeNoveltyTag;
  matchedTotalOccurrences: number | null;
  resolvedConflict: boolean;
  reason: string;
  matchedRelationship: EdgeMatchedRelationship | null;
}

function snapshotCr(cr: ConstructRelationship | null): EdgeMatchedRelationship | null {
  if (!cr) return null;
  const dom = Array.isArray(cr.domainsCovered) ? (cr.domainsCovered as unknown[]) : [];
  return {
    canonicalFrom: cr.canonicalFrom,
    canonicalTo: cr.canonicalTo,
    relationshipType: cr.relationshipType,
    totalOccurrences: cr.totalOccurrences,
    signConflict: cr.signConflict,
    domainsCovered: dom.filter((d): d is string => typeof d === "string"),
  };
}

function tagOneEdge(
  edge: ModelEdgeShape,
  modelEdges: ModelEdgeShape[],
  modelNodes: ModelNodeShape[],
  crByKey: Map<string, ConstructRelationship>,
  sessionTopicContexts: Set<string>,
): TagDecision {
  const crType = edgeRelToCrType(edge.relationship);
  const lookupKey = crKeyFromName(edge.fromVariableName, edge.toVariableName, crType);
  const directKey = crKeyFromName(edge.fromVariableName, edge.toVariableName, REL_DIRECT);
  const cr = crByKey.get(lookupKey) ?? null;
  const crDirect = crByKey.get(directKey) ?? null;
  const matchedTotalOccurrences = cr?.totalOccurrences ?? null;

  // 1. `contradicting` — sign conflict on the direct (X→Y) row. Resolved when
  //    the model also contains a moderator targeting (X,Y) OR a mediator on
  //    the X→...→Y path. Only applies to direct/positive/negative edges
  //    (moderator/mediator edges are themselves the resolution).
  if (crType === REL_DIRECT && crDirect?.signConflict === true) {
    const fromCanon = canonicalize(edge.fromVariableName).canonicalName;
    const toCanon = canonicalize(edge.toVariableName).canonicalName;
    const hasResolver = modelEdges.some((e) => {
      if (e === edge) return false;
      const eRel = (e.relationship ?? "").toLowerCase();
      // moderator with explicit moderatedEdge naming this (from,to)
      if (eRel === "moderates" && e.moderatedEdge && typeof e.moderatedEdge === "object") {
        const mFrom = typeof e.moderatedEdge.from === "string" ? canonicalize(e.moderatedEdge.from).canonicalName : "";
        const mTo = typeof e.moderatedEdge.to === "string" ? canonicalize(e.moderatedEdge.to).canonicalName : "";
        if (mFrom === fromCanon && mTo === toCanon) return true;
      }
      // mediator path: any pair of edges (X→M) + (M→Y)
      if (eRel === "mediates" || eRel === "positive" || eRel === "negative") {
        const eFrom = canonicalize(e.fromVariableName).canonicalName;
        const eTo = canonicalize(e.toVariableName).canonicalName;
        if (eFrom === fromCanon) {
          // Look for a complementary edge eTo → toCanon
          const second = modelEdges.some((e2) => {
            if (e2 === edge || e2 === e) return false;
            const e2From = canonicalize(e2.fromVariableName).canonicalName;
            const e2To = canonicalize(e2.toVariableName).canonicalName;
            return e2From === eTo && e2To === toCanon;
          });
          if (second) return true;
        }
      }
      return false;
    });
    return {
      tag: "contradicting",
      matchedTotalOccurrences,
      resolvedConflict: hasResolver,
      matchedRelationship: snapshotCr(crDirect),
      reason: hasResolver
        ? `直接路径在文献中存在符号冲突；模型通过中介或调节变量给出了解决方案。`
        : `直接路径在文献中存在符号冲突，模型尚未提供调节或中介解释。`,
    };
  }

  // 2. `mechanism_inserted` — direct edge X→Y where X→Y is saturated and
  //    the surrounding model contains a mediator M making the X→M→Y triple
  //    NOT in the direct CR table. We approximate "the edge sits on" by
  //    checking the model for any M with both (X→M) and (M→Y) edges.
  if (crType === REL_DIRECT && crDirect && crDirect.totalOccurrences >= 7) {
    const fromCanon = canonicalize(edge.fromVariableName).canonicalName;
    const toCanon = canonicalize(edge.toVariableName).canonicalName;
    for (const e1 of modelEdges) {
      if (e1 === edge) continue;
      if (canonicalize(e1.fromVariableName).canonicalName !== fromCanon) continue;
      const mid = canonicalize(e1.toVariableName).canonicalName;
      if (mid === toCanon) continue;
      const e2 = modelEdges.find((e) => {
        if (e === edge || e === e1) return false;
        return (
          canonicalize(e.fromVariableName).canonicalName === mid &&
          canonicalize(e.toVariableName).canonicalName === toCanon
        );
      });
      if (e2) {
        // (X, M, Y) triple novelty: not in direct CR for X→M or M→Y if at
        // least one is missing/underexplored.
        const xmKey = crKeyFromName(e1.fromVariableName, e1.toVariableName, REL_DIRECT);
        const myKey = crKeyFromName(e2.fromVariableName, e2.toVariableName, REL_DIRECT);
        const xmCr = crByKey.get(xmKey);
        const myCr = crByKey.get(myKey);
        const xmOcc = xmCr?.totalOccurrences ?? 0;
        const myOcc = myCr?.totalOccurrences ?? 0;
        if (xmOcc <= 1 || myOcc <= 1) {
          return {
            tag: "mechanism_inserted",
            matchedTotalOccurrences,
            resolvedConflict: false,
            matchedRelationship: snapshotCr(crDirect),
            reason: `主路径已饱和（${crDirect.totalOccurrences} 篇），模型在中间插入新中介构建了未被验证的三段式机制。`,
          };
        }
      }
    }
  }

  // 3. `boundary_extended` — moderator W on (X,Y) where X→Y is established
  //    and W has never moderated this specific (X,Y) in any source paper.
  //    Slice 1 approximation: we check that the moderator row for W with a
  //    matching (X,Y) note in supportingPapers does not exist. Per-paper
  //    moderator-target structure isn't currently denormalized into CR, so
  //    we use a conservative proxy: the moderation CR row for W either does
  //    not exist OR exists with no supportingPapers metadata referencing
  //    (X,Y). Phase 2.x will add the per-paper moderator graph.
  if (crType === REL_MODERATION) {
    const target = edge.moderatedEdge && typeof edge.moderatedEdge === "object" ? edge.moderatedEdge : null;
    const mFrom = target && typeof target.from === "string" ? canonicalize(target.from).canonicalName : null;
    const mTo = target && typeof target.to === "string" ? canonicalize(target.to).canonicalName : null;
    if (mFrom && mTo) {
      const xyKey = crKey(mFrom, null, mTo, null, REL_DIRECT);
      const xy = crByKey.get(xyKey);
      const xyOcc = xy?.totalOccurrences ?? 0;
      const xyEstablished = xyOcc >= 3;
      if (xyEstablished) {
        // Conservative proxy: as long as no CR moderation row records this W
        // as moderating (X,Y) (we can't fully verify yet — the supportingPapers
        // shape doesn't carry moderatedEdge yet), tag as boundary_extended.
        return {
          tag: "boundary_extended",
          matchedTotalOccurrences,
          resolvedConflict: false,
          matchedRelationship: snapshotCr(xy ?? null),
          reason: `被调节的主路径在 ${xyOcc} 篇文献中已建立，本调节变量在该 (X,Y) 对上尚未被检验，构成边界条件扩展。`,
        };
      }
      // Document why boundary_extended was NOT chosen — the moderated edge is
      // too thin in the literature pool. The UI uses this to explain to the
      // user that their pool may simply be too small.
      return {
        tag: "novel",
        matchedTotalOccurrences: null,
        resolvedConflict: false,
        matchedRelationship: snapshotCr(xy ?? null),
        reason: xy
          ? `被调节的主路径仅在 ${xyOcc} 篇文献中出现，未达到 3 篇 established 阈值，暂按 novel 处理；扩充文献后可能升级为边界扩展。`
          : `被调节的主路径在当前文献池中找不到对应记录，暂按 novel 处理。`,
      };
    }
  }

  // 4. `context_transferred` — edge IS in CR table but its `domainsCovered`
  //    set does not include the session topic context. We emit this when the
  //    direct CR row has a non-empty `domainsCovered` AND none of those
  //    domains overlap with `sessionTopicContexts` (when known).
  if (cr && Array.isArray(cr.domainsCovered) && cr.domainsCovered.length > 0 && sessionTopicContexts.size > 0) {
    const domains = cr.domainsCovered as unknown[];
    const overlap = domains.some((d) => typeof d === "string" && sessionTopicContexts.has(d.toLowerCase()));
    if (!overlap) {
      return {
        tag: "context_transferred",
        matchedTotalOccurrences,
        resolvedConflict: false,
        matchedRelationship: snapshotCr(cr),
        reason: `该关系已在其他研究情境（${(domains as string[]).filter((d) => typeof d === "string").join("、")}）中得到验证，但尚未在本会话主题情境下检验。`,
      };
    }
  }

  // 5. `novel` — edge not in CR table at all (for any rel type at this pair).
  if (!cr) {
    return {
      tag: "novel",
      matchedTotalOccurrences: null,
      resolvedConflict: false,
      matchedRelationship: null,
      reason: `当前文献池中未找到该关系（${edge.fromVariableName} → ${edge.toVariableName}）的任何记录。`,
    };
  }

  // 6/7/8. Bracket by occurrences.
  const bracketTag = bracketByOccurrences(cr.totalOccurrences);
  const bracketReason =
    bracketTag === "saturated"
      ? `该关系在 ${cr.totalOccurrences} 篇文献中已被反复验证，属于成熟关系。`
      : bracketTag === "established"
        ? `该关系在 ${cr.totalOccurrences} 篇文献中已建立，属于已确认关系。`
        : `该关系在 ${cr.totalOccurrences} 篇文献中出现，仍属探索阶段。`;
  return {
    tag: bracketTag,
    matchedTotalOccurrences,
    resolvedConflict: false,
    matchedRelationship: snapshotCr(cr),
    reason: bracketReason,
  };
}

// ---------------------------------------------------------------------------
// Innovation type detection (5 of 6 auto)
// ---------------------------------------------------------------------------

function detectInnovationTypes(
  modelEdges: ModelEdgeShape[],
  modelNodes: ModelNodeShape[],
  edgeTags: EdgeNoveltyTagging[],
  crByKey: Map<string, ConstructRelationship>,
  // Per-canonical-name occurrence count across the session's CR rows.
  occByName: Map<string, number>,
  theoryClusters: Map<string, string>,
  modelBackbone: string | null,
  modelSecondaryBackbone: string | null,
): string[] {
  const types = new Set<string>();

  // 1. mechanism — at least one edge tagged mechanism_inserted.
  if (edgeTags.some((t) => t.tag === "mechanism_inserted")) types.add("mechanism");

  // 2. boundary — at least one edge tagged boundary_extended.
  if (edgeTags.some((t) => t.tag === "boundary_extended")) types.add("boundary");

  // 3. integration — both backbone and secondaryBackbone set, mapping to
  //    different theory clusters.
  if (modelBackbone && modelSecondaryBackbone) {
    const c1 = theoryClusters.get(modelBackbone.toLowerCase()) ?? null;
    const c2 = theoryClusters.get(modelSecondaryBackbone.toLowerCase()) ?? null;
    if (c1 && c2 && c1 !== c2) types.add("integration");
  }

  // 4. correction — Tier A only: contradicting_resolved present.
  if (edgeTags.some((t) => t.tag === "contradicting" && t.subscore === EDGE_TAG_SUBSCORE.contradicting_resolved)) {
    types.add("correction");
  }

  // 5. construct — low-freq node connected to a high-freq core node OR a DV.
  const nodeOcc = (name: string): number => occByName.get(canonicalize(name).canonicalName) ?? 0;
  const dvNames = new Set(
    modelNodes
      .filter((n) => (n.type ?? "").toLowerCase() === "dependent")
      .map((n) => canonicalize(n.variableName).canonicalName),
  );
  for (const node of modelNodes) {
    const canon = canonicalize(node.variableName).canonicalName;
    if (nodeOcc(node.variableName) > 1) continue; // not low-freq
    // Find incident edges in the model for this node.
    const incident = modelEdges.filter(
      (e) =>
        canonicalize(e.fromVariableName).canonicalName === canon ||
        canonicalize(e.toVariableName).canonicalName === canon,
    );
    if (incident.length === 0) continue;
    const connectsToCore = incident.some((e) => {
      const otherRaw =
        canonicalize(e.fromVariableName).canonicalName === canon ? e.toVariableName : e.fromVariableName;
      const otherCanon = canonicalize(otherRaw).canonicalName;
      return nodeOcc(otherRaw) >= 4 || dvNames.has(otherCanon);
    });
    if (connectsToCore) {
      types.add("construct");
      break;
    }
  }

  // 6. context — AI-judged (Phase 3); slice 1 leaves it for the AI to add.

  return Array.from(types);
}

// ---------------------------------------------------------------------------
// Sub-scores + contributionScore
// ---------------------------------------------------------------------------

function computeSubScores(args: {
  edgeTags: EdgeNoveltyTagging[];
  modelBackbone: string | null;
  evidencedBackbones: Set<string>;
  // Slice 1: gapFit defaults to floor (no claim wired yet).
}): InnovationSubScores {
  const subscores = args.edgeTags.map((t) => t.subscore);
  const differentiation = subscores.length > 0
    ? Math.round(subscores.reduce((s, v) => s + v, 0) / subscores.length)
    : 30;

  const gapFit = 30; // floor — no `model.gapTypes ∩ topGapTypes` claim wired in slice 1

  // theoreticalSoundness: 100 if backbone is in evidencedBackbones, floor 30 otherwise.
  const bbNorm = (args.modelBackbone ?? "").toLowerCase().trim();
  const theoreticalSoundness = bbNorm && args.evidencedBackbones.has(bbNorm) ? 100 : 30;

  // evidenceSupport: slice 1 uses floor 20 — AI direct/analog/theory tagging
  // is a Phase 2.x follow-up. Phase 1 does not split evidenceCitationText
  // into the three tiers. Floor (not 0) so truly-novel edges are not
  // unfairly punished while the tagger is being built.
  const evidenceSupport = 20;

  return { differentiation, gapFit, theoreticalSoundness, evidenceSupport };
}

function computeContributionScore(s: InnovationSubScores): number {
  const product = (s.differentiation / 100) * (s.gapFit / 100) * (s.theoreticalSoundness / 100) * (s.evidenceSupport / 100);
  if (product <= 0) return 0;
  return Math.round(Math.pow(product, 0.25) * 100);
}

// ---------------------------------------------------------------------------
// Backbone parsing from rationale prefix
// ---------------------------------------------------------------------------

// The generation route stamps `[BACKBONE: SOR]` into the rationale prefix.
// We parse it back out for innovationType.integration + theoreticalSoundness.
function parseBackbones(rationale: string): { backbone: string | null; secondaryBackbone: string | null } {
  const m = rationale.match(/\[BACKBONE:\s*([^\]]*)\]/i);
  if (!m) return { backbone: null, secondaryBackbone: null };
  const raw = (m[1] ?? "").trim();
  if (!raw || raw.toLowerCase() === "none") return { backbone: null, secondaryBackbone: null };
  // Accept "SOR" or "SOR+TAM" / "SOR,TAM"
  const parts = raw.split(/[+,;/]/).map((p) => p.trim()).filter(Boolean);
  return {
    backbone: parts[0] ?? null,
    secondaryBackbone: parts[1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Snapshot of every per-session input the scorer needs. Built once per
 * generation request so a fanout of N models doesn't make N×4 identical reads
 * (`landscapeMeta` + `constructRelationships` + 2 paper scans), which used to
 * eat into the 60s autoscale deadline. The HTTP recompute route still calls
 * `loadLandscapeSnapshot()` lazily for the single-model case.
 */
export interface LandscapeSnapshot {
  landscapeVersion: number | null;
  coverageRate: number;
  crByKey: Map<string, ConstructRelationship>;
  occByName: Map<string, number>;
  theoryClusters: Map<string, string>;
  sessionTopicContexts: Set<string>;
  evidencedBackbones: Set<string>;
}

export async function loadLandscapeSnapshot(sessionId: number): Promise<LandscapeSnapshot> {
  // Run the four independent reads in parallel — sequencing them serially is
  // wasted RTT on the hot model-generation path.
  const [[session], crRows, ctxRows, tbRows] = await Promise.all([
    db
      .select({ landscapeMeta: sessionsTable.landscapeMeta, topic: sessionsTable.topic })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId)),
    db.select().from(constructRelationshipsTable).where(eq(constructRelationshipsTable.sessionId, sessionId)),
    db
      .select({ studyContext: papersTable.studyContext })
      .from(papersTable)
      .where(
        and(
          eq(papersTable.sessionId, sessionId),
          sql`${papersTable.externalId} NOT LIKE 'manual:%'`,
          sql`${papersTable.tangential} IS NOT TRUE`,
        ),
      ),
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

  const lm = (session?.landscapeMeta ?? {}) as {
    landscapeVersion?: number;
    landscapeCoverage?: { coverageRate?: number };
    theoryClusters?: Array<{ id?: string; clusterId?: string; label?: string }>;
  };

  const crByKey = new Map<string, ConstructRelationship>();
  const occByName = new Map<string, number>();
  for (const r of crRows) {
    const key = crKey(r.canonicalFrom, r.contextQualifierFrom, r.canonicalTo, r.contextQualifierTo, r.relationshipType);
    crByKey.set(key, r);
    occByName.set(r.canonicalFrom, (occByName.get(r.canonicalFrom) ?? 0) + 1);
    occByName.set(r.canonicalTo, (occByName.get(r.canonicalTo) ?? 0) + 1);
  }

  const theoryClusters = new Map<string, string>();
  if (Array.isArray(lm.theoryClusters)) {
    for (const c of lm.theoryClusters) {
      const id = (c.id ?? c.clusterId ?? "").toString().toLowerCase().trim();
      const label = (c.label ?? id).toString();
      if (id) theoryClusters.set(id, label);
    }
  }

  const sessionTopicContexts = new Set<string>();
  for (const row of ctxRows) {
    const sx = row.studyContext as { objectType?: unknown } | null;
    if (sx && typeof sx === "object" && typeof sx.objectType === "string" && sx.objectType.trim().length > 0) {
      sessionTopicContexts.add(sx.objectType.trim().toLowerCase());
    }
  }

  const evidencedBackbones = new Set<string>();
  for (const row of tbRows) {
    const tb = row.theoryBackbone as Array<{ name?: unknown }> | null;
    if (Array.isArray(tb)) {
      for (const t of tb) {
        if (t && typeof t.name === "string" && t.name.trim().length > 0) {
          evidencedBackbones.add(t.name.trim().toLowerCase());
        }
      }
    }
  }

  return {
    landscapeVersion: typeof lm.landscapeVersion === "number" ? lm.landscapeVersion : null,
    coverageRate: typeof lm.landscapeCoverage?.coverageRate === "number" ? lm.landscapeCoverage.coverageRate : 0,
    crByKey,
    occByName,
    theoryClusters,
    sessionTopicContexts,
    evidencedBackbones,
  };
}

export interface ComputeInnovationMetaArgs {
  sessionId: number;
  model: Pick<ResearchModel, "id" | "sessionId" | "rationale" | "nodes" | "edges">;
  log?: Pick<Logger, "warn" | "info">;
  /**
   * Optional pre-loaded snapshot. When omitted the scorer loads it itself
   * (used by the single-model recompute endpoint). Pass it explicitly from
   * the model-generation fanout to avoid N redundant reads.
   */
  snapshot?: LandscapeSnapshot;
}

export async function computeInnovationMeta({
  sessionId,
  model,
  log,
  snapshot,
}: ComputeInnovationMetaArgs): Promise<InnovationMeta> {
  const computedAt = new Date().toISOString();
  const snap = snapshot ?? (await loadLandscapeSnapshot(sessionId));
  const { landscapeVersion, coverageRate, crByKey, occByName, theoryClusters, sessionTopicContexts, evidencedBackbones } = snap;
  const mode: InnovationMode = coverageRate >= COVERAGE_FLOOR ? "enforced" : "analysis_only";
  const modeReason: InnovationMeta["modeReason"] = mode === "enforced" ? "ok" : "coverage_below_threshold";

  // 6. Tag every edge.
  const edgesRaw = (model.edges as ModelEdgeShape[]) ?? [];
  const nodesRaw = (model.nodes as ModelNodeShape[]) ?? [];
  const edgeNoveltyTags: EdgeNoveltyTagging[] = edgesRaw.map((edge, idx) => {
    const decision = tagOneEdge(edge, edgesRaw, nodesRaw, crByKey, sessionTopicContexts);
    const subscore = decision.tag === "contradicting" && decision.resolvedConflict
      ? EDGE_TAG_SUBSCORE.contradicting_resolved
      : EDGE_TAG_SUBSCORE[decision.tag];
    return {
      edgeIndex: idx,
      fromVariableName: edge.fromVariableName,
      toVariableName: edge.toVariableName,
      relationship: edge.relationship,
      tag: decision.tag,
      subscore,
      matchedTotalOccurrences: decision.matchedTotalOccurrences,
      matchedRelationship: decision.matchedRelationship,
      reason: decision.reason,
    };
  });

  // 7. Innovation types.
  const { backbone, secondaryBackbone } = parseBackbones(model.rationale ?? "");
  const innovationTypes = detectInnovationTypes(
    edgesRaw,
    nodesRaw,
    edgeNoveltyTags,
    crByKey,
    occByName,
    theoryClusters,
    backbone,
    secondaryBackbone,
  );

  // 8. Sub-scores + headline contribution score.
  const subScores = computeSubScores({
    edgeTags: edgeNoveltyTags,
    modelBackbone: backbone,
    evidencedBackbones,
  });
  const noveltyScore = edgeNoveltyTags.length > 0 ? subScores.differentiation : null;
  const contributionScore = computeContributionScore(subScores);

  // 9. Hard-rule warnings (Phase 2: WARN ONLY when analysis_only — never reject).
  const warnings: InnovationWarning[] = [];
  // #20 contributionStatement: always missing in slice 1 (AI doesn't emit it yet).
  warnings.push({
    code: "contribution_statement_missing",
    message: "尚未生成 7 字段贡献声明（Phase 2.x 后续切片接入 AI）。",
  });
  // #21 no auto-detected innovation type.
  if (innovationTypes.length === 0) {
    warnings.push({
      code: "no_innovation_type_detected",
      message: "尚未检测到任一种自动可识别的创新类型（机制 / 边界 / 整合 / 矛盾解决 / 构念延展）。",
    });
  }
  // #22 all-low-novelty (warn only — full reject gated on enforced + score<30).
  const allLow = edgeNoveltyTags.length > 0 && edgeNoveltyTags.every((t) => t.tag === "saturated" || t.tag === "established");
  if (allLow) {
    warnings.push({
      code: "all_edges_low_novelty",
      message: "全部边均为成熟或已建立关系，模型创新空间偏低。",
    });
  }

  if (log) {
    log.info(
      {
        modelId: model.id,
        sessionId,
        landscapeVersion,
        coverageRate,
        mode,
        noveltyScore,
        contributionScore,
        innovationTypes,
        warningCount: warnings.length,
      },
      "innovation-scoring computed",
    );
  }

  return {
    edgeNoveltyTags,
    noveltyScore,
    innovationTypes,
    subScores,
    contributionScore,
    contributionStatement: null,
    computedAgainst: { landscapeVersion, coverageRate, computedAt },
    mode,
    modeReason,
    warnings,
  };
}

// True iff the persisted `innovationMeta` is stale relative to the current
// landscape version. Used by the GET routes to attach a `stale: true` flag.
export function isInnovationMetaStale(
  meta: InnovationMeta | null,
  currentLandscapeVersion: number | null,
): boolean {
  if (!meta) return false;
  if (currentLandscapeVersion == null) return false;
  if (meta.computedAgainst.landscapeVersion == null) return true;
  return meta.computedAgainst.landscapeVersion < currentLandscapeVersion;
}

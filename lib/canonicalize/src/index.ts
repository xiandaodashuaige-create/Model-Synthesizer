// Three-layer canonical-name resolver shared by client + server.
//
// SOURCE OF TRUTH for `docs/innovation-taxonomy.md` "Three-layer canonicalize spec".
// MUST be the only place that defines normalization rules — duplicating the
// logic in artifacts/* is a hard regression (the variable cluster dedup bug
// from 2025 was caused exactly by client/server normalizers drifting).
//
// Layer 1 (rawName)        : the user-visible original string.
// Layer 2 (canonicalName)  : 6-step normalized form, see normalizeName().
// Layer 3 (contextQualifier
//          + constructFamily): split off a "X in/of/for ... Y" qualifier so
//                              "trust in AI streamer" and "trust in platform"
//                              aggregate as DIFFERENT rows but can be rolled
//                              up by family ("trust") when needed.
//
// The aggregation key for the literature landscape table is
//   `canonicalName + contextQualifier`
// — see aggregationKey() below.

export type CanonicalName = {
  rawName: string;
  canonicalName: string;
  contextQualifier: string | null;
  constructFamily: string;
};

// Layer 2: 6-step normalization (LEGACY behavior preserved verbatim).
//
//   1. NFKC normalize (collapse fullwidth/halfwidth, decomposed CJK, etc).
//   2. Lowercase.
//   3. Rewrite hyphens / em-dashes / en-dashes / underscores / slashes to a
//      single space (punctuation noise across paper wording conventions).
//   4. Strip leading "perceived" / "the" / "a" / "an" — measurement-frame
//      prefixes that don't change construct identity.
//   5. Drop residual punctuation (anything that isn't a letter / digit /
//      whitespace from any script).
//   6. Collapse whitespace runs to a single space and trim.
//
// Returns the legacy-equivalent string. This MUST stay identical to the
// pre-Phase-1 implementation in both client (focus-selection.ts) and server
// (routes/variables.ts) so existing canonicalConstructId values + v2
// localStorage focus-pick keys are unchanged.
export function normalizeName(name: string): string {
  if (!name) return "";
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015\-_/]+/g, " ")
    .replace(/^(perceived|the|a|an)\s+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Prepositions that flag a "core construct + context qualifier" split.
// Order doesn't matter for the alternation; we anchor on the first match.
// NOTE: Chinese constructs typically don't use these prepositions — for
// "AI 主播感知拟人化" no split is attempted, the full normalized string
// becomes the canonicalName. That is intentional: Chinese construct names
// rarely split on a single particle reliably.
const QUALIFIER_PREPS = [
  "in",
  "of",
  "for",
  "towards",
  "toward",
  "with",
  "about",
  "on",
  "from",
  "by",
] as const;

const QUALIFIER_RE = new RegExp(
  `^(?<core>[\\p{L}\\p{N}]+(?:\\s[\\p{L}\\p{N}]+)*?)\\s(?:${QUALIFIER_PREPS.join("|")})\\s(?<qual>[\\p{L}\\p{N}]+(?:\\s[\\p{L}\\p{N}]+)*)$`,
  "u",
);

// Stop-list for cores that look like prepositions or articles after splitting.
// Guards against degenerate matches where the regex picks up a tail word that
// happens to BE a preposition (e.g. "trust by association" → core="trust by", qual="association"
// — we don't want to bind "trust by" as a construct family).
const CORE_BLOCKLIST = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "for",
  "with",
  "on",
  "by",
  "to",
  "from",
]);

// Layer 3 helper: detect the qualifier split. Returns the unchanged input as
// `core` with `qualifier=null` when no clean split is found.
function detectQualifier(normalized: string): { core: string; qualifier: string | null } {
  if (!normalized) return { core: normalized, qualifier: null };
  const m = QUALIFIER_RE.exec(normalized);
  if (!m || !m.groups) return { core: normalized, qualifier: null };
  const core = m.groups.core.trim();
  const qualifier = m.groups.qual.trim();
  if (!core || !qualifier) return { core: normalized, qualifier: null };
  // Reject splits where the core's last token is itself a function word —
  // typically means we mis-split a construct name like "social presence by
  // proxy" into ("social presence by", "proxy"). The lastTokenBlock check
  // catches the simpler form ("trust by", "association").
  const lastTokenInCore = core.split(/\s+/).pop() ?? "";
  if (CORE_BLOCKLIST.has(lastTokenInCore)) return { core: normalized, qualifier: null };
  return { core, qualifier };
}

// 3-layer canonicalize: returns the structured object used by the literature
// landscape pipeline (Phase 1+) for aggregation across papers.
export function canonicalize(rawName: string): CanonicalName {
  const trimmed = (rawName ?? "").toString();
  const normalized = normalizeName(trimmed);
  const { core, qualifier } = detectQualifier(normalized);
  return {
    rawName: trimmed,
    canonicalName: core,
    contextQualifier: qualifier,
    // constructFamily is reserved for future synonym-mapping (e.g. "trust" and
    // "credibility" rolling up into the same family). For now it equals the
    // canonicalName; the storage shape allows us to differentiate later
    // without another schema migration.
    constructFamily: core,
  };
}

// Aggregation key for `constructRelationshipsTable.canonicalFrom / canonicalTo`.
// Stable composite of `canonicalName + contextQualifier`. Equivalent to the
// legacy normalizeName() output for unqualified names; differs for qualified
// names by re-joining via "|" instead of " in/of/...".
export function aggregationKey(c: CanonicalName): string {
  return c.contextQualifier ? `${c.canonicalName}|${c.contextQualifier}` : c.canonicalName;
}

// Convenience: aggregation key directly from a raw string.
export function aggregationKeyOf(rawName: string): string {
  return aggregationKey(canonicalize(rawName));
}

// Legacy cluster-key shape for focus-pick localStorage. MUST equal
// `${type}|normalizeName(name)` exactly so v2 keys keep working without a
// v3 migration on Phase 1 release.
export function clusterKey(type: string, name: string): string {
  return `${type}|${normalizeName(name)}`;
}

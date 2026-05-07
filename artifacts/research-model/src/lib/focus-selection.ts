// localStorage-backed selection of "focus" variable clusters that the user
// hand-picks on the /variables page. The model-generation prompt already
// supports a `focusVariableIds` parameter — this helper provides the missing
// UI persistence layer so the user's picks on /variables can be carried to
// /models without piping state through wouter navigation.
//
// We persist cluster KEYS (`type|normalizedName`) instead of variable IDs so
// the selection survives a full re-extraction (which mints new variable rows
// with new primary keys). At read-time we expand the keys back into the
// current variable IDs by matching against the live variables list.

// v2 bumped from v1 when normalizeName() was tightened (hyphen / dash /
// underscore / slash → space; "perceived/the/a/an" prefix strip; punctuation
// drop). Old v1 keys are migrated on read by re-running the name part through
// the new normalizer, then the migrated set is rewritten under v2 so the
// migration is one-shot per session.
const KEY_V2 = (sessionId: number) => `focusVarSelection:v2:${sessionId}`;
const KEY_V1 = (sessionId: number) => `focusVarSelection:v1:${sessionId}`;

export type VarLite = { id: number; type: string; name: string };

// Single source of truth for construct-name normalization across the client.
// MUST stay in lock-step with the server-side canonicalize() in
// artifacts/api-server/src/routes/variables.ts — any divergence means a name
// produces different cluster keys client-side vs different canonicalConstructIds
// server-side, and downstream focus-pick / role-binding matching breaks.
//
// Rules (same on both sides):
//   1. NFKC normalize (collapse fullwidth/halfwidth, decomposed CJK, etc).
//   2. Lowercase.
//   3. Rewrite hyphens / em-dashes / en-dashes / underscores / slashes to a
//      single space — these are punctuation noise across different papers'
//      wording conventions (e.g. "AI-chatbot service quality" vs "AI chatbot
//      service quality" used to mint two pinnable cards; the user's reported
//      "重复举例变量" bug).
//   4. Strip leading "perceived" / "the" / "a" / "an" — measurement-frame
//      prefixes that don't change construct identity ("perceived value" and
//      "value" are the same construct).
//   5. Drop residual punctuation (anything that isn't a letter / digit /
//      whitespace from any script).
//   6. Collapse whitespace runs to a single space and trim.
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015\-_/]+/g, " ")
    .replace(/^(perceived|the|a|an)\s+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function clusterKey(type: string, name: string): string {
  return `${type}|${normalizeName(name)}`;
}

// Re-normalize the name half of a stored cluster key. Used on v1 → v2
// migration so users don't lose pre-existing focus picks when the
// normalization rules tighten.
function migrateStoredKey(stored: string): string | null {
  const idx = stored.indexOf("|");
  if (idx <= 0) return null;
  const type = stored.slice(0, idx);
  const oldName = stored.slice(idx + 1);
  const renorm = normalizeName(oldName);
  if (!type || !renorm) return null;
  return `${type}|${renorm}`;
}

export function loadFocusedClusterKeys(sessionId: number): string[] {
  if (!sessionId) return [];
  try {
    const v2 = localStorage.getItem(KEY_V2(sessionId));
    if (v2) {
      const arr = JSON.parse(v2);
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    }
    // v1 fallback + one-shot migration.
    const v1 = localStorage.getItem(KEY_V1(sessionId));
    if (!v1) return [];
    const arr = JSON.parse(v1);
    if (!Array.isArray(arr)) return [];
    const migrated: string[] = [];
    const seen = new Set<string>();
    for (const k of arr) {
      if (typeof k !== "string") continue;
      const rewritten = migrateStoredKey(k);
      if (!rewritten || seen.has(rewritten)) continue;
      seen.add(rewritten);
      migrated.push(rewritten);
    }
    saveFocusedClusterKeys(sessionId, migrated);
    try { localStorage.removeItem(KEY_V1(sessionId)); } catch { /* best effort */ }
    return migrated;
  } catch {
    return [];
  }
}

export function saveFocusedClusterKeys(sessionId: number, keys: string[]): void {
  if (!sessionId) return;
  try {
    if (keys.length === 0) localStorage.removeItem(KEY_V2(sessionId));
    else localStorage.setItem(KEY_V2(sessionId), JSON.stringify(keys));
  } catch {
    // localStorage disabled / quota exhausted — selection is best-effort UX,
    // not an integrity requirement, so we swallow the error silently.
  }
}

export function expandToVariableIds(
  keys: string[],
  variables: ReadonlyArray<VarLite>,
): number[] {
  if (!keys.length || !variables.length) return [];
  const set = new Set(keys);
  const ids: number[] = [];
  for (const v of variables) {
    if (set.has(clusterKey(v.type, v.name))) ids.push(v.id);
  }
  return ids;
}

export type FocusCounts = {
  independent: number;
  mediator: number;
  moderator: number;
  dependent: number;
  total: number;
};

export function countByType(
  keys: string[],
  variables: ReadonlyArray<VarLite>,
): FocusCounts {
  const set = new Set(keys);
  const seen = new Set<string>();
  const c: FocusCounts = { independent: 0, mediator: 0, moderator: 0, dependent: 0, total: 0 };
  for (const v of variables) {
    const k = clusterKey(v.type, v.name);
    if (!set.has(k) || seen.has(k)) continue;
    seen.add(k);
    if (v.type === "independent" || v.type === "mediator" || v.type === "moderator" || v.type === "dependent") {
      c[v.type]++;
    }
    c.total++;
  }
  return c;
}

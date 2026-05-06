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

const KEY = (sessionId: number) => `focusVarSelection:v1:${sessionId}`;

export type VarLite = { id: number; type: string; name: string };

export function clusterKey(type: string, name: string): string {
  return `${type}|${name.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

export function loadFocusedClusterKeys(sessionId: number): string[] {
  if (!sessionId) return [];
  try {
    const raw = localStorage.getItem(KEY(sessionId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveFocusedClusterKeys(sessionId: number, keys: string[]): void {
  if (!sessionId) return;
  try {
    if (keys.length === 0) localStorage.removeItem(KEY(sessionId));
    else localStorage.setItem(KEY(sessionId), JSON.stringify(keys));
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

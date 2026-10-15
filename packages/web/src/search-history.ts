/** Per-project search history in localStorage (last 10, dedupe on push) —
 *  same semantics as the old desktop settings-table implementation, but shared
 *  by desktop and the future web build. Keyed by project id (its path), which
 *  is what the renderer always had in hand. */

const LIMIT = 10;
const keyOf = (projectId: string) => `journal:search_history:${projectId}`;

export function getSearchHistory(projectId: string): string[] {
  const raw = localStorage.getItem(keyOf(projectId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Move query to the front of the project's history (dedupe), cap at 10 entries,
 *  persist; returns the new list. A blank query is a no-op. */
export function pushSearchHistory(projectId: string, query: string): string[] {
  const q = query.trim();
  if (!q) return getSearchHistory(projectId);
  const next = [q, ...getSearchHistory(projectId).filter((x) => x !== q)].slice(0, LIMIT);
  localStorage.setItem(keyOf(projectId), JSON.stringify(next));
  return next;
}

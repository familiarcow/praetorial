// DR2 game selection: a game the builder offers (NBA via ESPN) that starts >= 1 h after open.
export const MIN_LEAD_SECS = 3600;
/** ESPN event date strings look like 2026-11-11T00:30Z. */
export function eventStartOk(startIso: string, nowMs: number): boolean {
  const t = Date.parse(startIso.length === 17 ? `${startIso.slice(0, 16)}:00Z` : startIso);
  return Number.isFinite(t) && t - nowMs >= MIN_LEAD_SECS * 1000;
}

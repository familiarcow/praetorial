// IDX2: the bets this browser session just opened, so Explore can show the maker's own new bet at once (an optimistic row built from
// the Open result's get_bet) until the indexer lists it. sessionStorage, per maker, short TTL; a blocked or corrupt storage just
// means no optimistic row (never an error).
import type { Bet } from "./escrowAdapter";

export interface JustOpened { id: number; bet: Bet; maker: string; atMs: number }
export interface StoreLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const KEY = "praetorial:just-opened";
/** Long enough to cover any indexer delay (it sweeps every minute); short enough that a stale optimistic row cannot linger. */
export const JUST_OPENED_TTL_MS = 10 * 60_000;
const MAX = 10;

export function memoryStore(): StoreLike {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
}
/** The session store in a browser; null elsewhere (or when storage is off). */
export function sessionStore(): StoreLike | null {
  try { return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null; } catch { return null; }
}

function read(s: StoreLike | null): JustOpened[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((e) => e && Number.isSafeInteger(e.id) && typeof e.maker === "string" && typeof e.atMs === "number" && e.bet && typeof e.bet === "object") : [];
  } catch { return []; }
}
function write(s: StoreLike | null, list: JustOpened[]): void {
  try { s?.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* storage off or full */ }
}

export function rememberOpened(s: StoreLike | null, e: JustOpened): void {
  write(s, [e, ...read(s).filter((x) => x.id !== e.id)]);
}
export function forgetOpened(s: StoreLike | null, id: number): void {
  write(s, read(s).filter((x) => x.id !== id));
}
/** The maker's own entries younger than the TTL, newest first. */
export function justOpened(s: StoreLike | null, me: string | null, nowMs: number): JustOpened[] {
  if (!me) return [];
  return read(s).filter((e) => e.maker === me && nowMs - e.atMs <= JUST_OPENED_TTL_MS && nowMs - e.atMs >= -60_000).sort((a, b) => b.atMs - a.atMs);
}

// IDX2: after a successful Open or Take, nudge the indexer (POST <indexer>/refresh {"bet_id": N}) so Explore shows the change in
// seconds instead of after its next minute sweep, then tell the screens to re-read (BETS_CHANGED). The indexer reads the bet from the
// chain itself; we send ONLY the id. Fire-and-forget: nothing here can block, delay or fail the user's flow -- every error is
// swallowed and the board still catches up on the indexer's own sweep within a minute or two.
import { INDEXER_URL } from "./config";
import { requireService } from "./network";
import { rememberOpened, sessionStore, type StoreLike } from "./justOpened";
import type { Bet } from "./escrowAdapter";

/** window event (CustomEvent<{ betId }>) fired once a nudge has settled, whatever its answer. Explore / the bet page re-read on it. */
export const BETS_CHANGED = "praetorial:bets-changed";
/** A 404 right after the tx means the indexer's RPC has not seen the new bet yet: one retry after this wait. */
export const NUDGE_RETRY_MS = 1200;
const TIMEOUT_MS = 8000;

export interface NudgeDeps {
  fetch?: typeof fetch;
  /** The indexer base URL (or a function that resolves it, and may throw when the indexer is not configured). */
  base?: string | (() => string);
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

async function once(f: typeof fetch, url: string, betId: number, timeoutMs: number): Promise<number> {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  let guardTimer: ReturnType<typeof setTimeout> | undefined; // a fetch that ignores the abort still ends here (cleared = never settles, never unhandled)
  const guard = new Promise<never>((_, rej) => { guardTimer = setTimeout(() => rej(new Error("timeout")), timeoutMs + 50); });
  try {
    const res = await Promise.race([
      f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bet_id: betId }), ...(ctl ? { signal: ctl.signal } : {}), keepalive: true }),
      guard,
    ]);
    return res.status;
  } finally { clearTimeout(timer); clearTimeout(guardTimer); }
}

/** Never rejects. "ok" = the indexer re-read the bet; "failed" = anything else (the board catches up on its own sweep). */
export async function nudgeIndexer(betId: number, deps: NudgeDeps = {}): Promise<"ok" | "failed"> {
  try {
    if (!Number.isSafeInteger(betId) || betId < 1) return "failed";
    const base = typeof deps.base === "function" ? deps.base() : deps.base ?? requireService("indexer", INDEXER_URL);
    const f = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const url = `${base.replace(/\/+$/, "")}/refresh`;
    const t = deps.timeoutMs ?? TIMEOUT_MS;
    let status = await once(f, url, betId, t);
    if (status === 404) { await sleep(NUDGE_RETRY_MS); status = await once(f, url, betId, t); }
    return status >= 200 && status < 300 ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

const emitWindow = (betId: number) => { if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(BETS_CHANGED, { detail: { betId } })); };

/** Fire-and-forget: nudge, then emit BETS_CHANGED. Returns immediately (void) and never throws or rejects. */
export function afterBetChange(betId: number, deps: NudgeDeps & { emit?: (betId: number) => void } = {}): void {
  void nudgeIndexer(betId, deps).then(() => { try { (deps.emit ?? emitWindow)(betId); } catch { /* a listener's problem is not the flow's */ } }, () => {});
}

/** After a successful Open: remember the bet for Explore's optimistic row (maker = the chain bet's own maker), emit, nudge. Never throws. */
export function afterOpened(shared: { betId: number; bet: Bet }, deps: NudgeDeps & { emit?: (betId: number) => void; store?: StoreLike | null; nowMs?: number } = {}): void {
  try { rememberOpened(deps.store !== undefined ? deps.store : sessionStore(), { id: shared.betId, bet: shared.bet, maker: shared.bet.envelope.maker, atMs: deps.nowMs ?? Date.now() }); } catch { /* storage */ }
  // at once (Explore, already mounted under the create modal, shows the optimistic row), and again when the nudge settles (indexed row)
  try { (deps.emit ?? emitWindow)(shared.betId); } catch { /* a listener's problem is not the flow's */ }
  afterBetChange(shared.betId, deps);
}

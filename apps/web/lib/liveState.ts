// FE16b (S18): tiny shared store for what the app currently knows about its reads: did the last contract view fail,
// are we waiting out a 429, is this page out of date. rpc.ts / relayerClient.ts write it; the shell and screens read it.
// REVIEW1 (#8, SM1 AUTH-1): a failed read is no longer sticky. Each failing read is re-run in the background with backoff
// (and at once when any other read succeeds, i.e. the connection is back) until it answers, so one blip on a one-shot read
// (the chain id at boot, a tx lookup) cannot leave the app "stale" with Create/Open disabled until a reload.
import { useSyncExternalStore } from "react";

export interface Live { viewFailed: boolean; busySeconds: number; outOfDate: boolean }
let state: Live = { viewFailed: false, busySeconds: 0, outOfDate: false };
interface Failing { retry?: () => Promise<void>; attempt: number; timer: ReturnType<typeof setTimeout> | null; running: boolean }
const failing = new Map<string, Failing>();
const subs = new Set<() => void>();
let backoff = { baseMs: 2_000, maxMs: 30_000 };
function set(p: Partial<Live>) {
  const next = { ...state, ...p };
  if (next.viewFailed === state.viewFailed && next.busySeconds === state.busySeconds && next.outOfDate === state.outOfDate) return;
  state = next;
  subs.forEach((f) => f());
}

function schedule(key: string, f: Failing, delayMs: number) {
  if (f.timer) clearTimeout(f.timer);
  if (!f.retry) { f.timer = null; return; }
  f.timer = setTimeout(() => void runRetry(key), delayMs);
  (f.timer as any)?.unref?.(); // node (unit tests): a pending recovery never keeps the process alive
}

async function runRetry(key: string) {
  const f = failing.get(key);
  if (!f || !f.retry || f.running) return;
  if (f.timer) { clearTimeout(f.timer); f.timer = null; }
  f.running = true;
  try { await f.retry(); } catch { /* still failing: rpc re-registered it */ }
  finally { f.running = false; }
  const still = failing.get(key);
  if (still) schedule(key, still, Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(still.attempt, 10)));
}

export const liveState = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  // Per-read bookkeeping: a failed get_bet is only cleared by a good get_bet, not by an unrelated is_paused poll succeeding.
  // An unrelated success does mean the connection is back, so every failing read is re-run right away.
  viewOk: (key = "") => {
    const f = failing.get(key);
    if (f?.timer) clearTimeout(f.timer);
    failing.delete(key);
    set({ viewFailed: failing.size > 0 });
    for (const [k, other] of failing) if (!other.running && other.retry) void runRetry(k);
  },
  /** `retry` re-runs the same read; without one the entry only clears when the same read later succeeds. */
  viewFailed: (key = "", retry?: () => Promise<void>) => {
    const prev = failing.get(key);
    const f: Failing = prev ?? { attempt: 0, timer: null, running: false };
    f.attempt = prev ? prev.attempt + 1 : 0;
    if (retry) f.retry = retry;
    failing.set(key, f);
    set({ viewFailed: true });
    if (!f.running) schedule(key, f, Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(f.attempt, 10)));
  },
  /** SM2 "retry" fix: re-run every failing read now (instead of waiting for its backoff). */
  retryAll: () => { for (const [k, f] of failing) if (!f.running && f.retry) void runRetry(k); },
  busy: (s: number) => set({ busySeconds: s }),
  outOfDate: (v: boolean) => set({ outOfDate: v }),
  /** Test seam: shorter backoff. */
  setBackoff: (b: { baseMs: number; maxMs: number }) => { backoff = b; },
  /** Test seam: forget every failing read. */
  reset: () => { for (const f of failing.values()) if (f.timer) clearTimeout(f.timer); failing.clear(); set({ viewFailed: false, busySeconds: 0, outOfDate: false }); },
};
export function useLiveState(): Live { return useSyncExternalStore(liveState.subscribe, liveState.get, liveState.get); }

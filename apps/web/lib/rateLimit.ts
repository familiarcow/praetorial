// FE16b (S18): RPC / relayer 429 handling. Wait out the server's Retry-After with a visible countdown, then try again by itself.
import { parseRetryAfter } from "./globalStates";

export interface Limited { status: number; retryAfter: string | null }
export interface RetryDeps { sleep?: (ms: number) => Promise<void>; onWait?: (secondsLeft: number) => void; max?: number }

/** Run `fn` again after every 429 (up to `max` retries; default 4), reporting the seconds left. onWait(0) = no longer waiting. */
export async function retryOn429<T extends Limited>(fn: () => Promise<T>, deps: RetryDeps = {}): Promise<T> {
  const max = deps.max ?? 4;
  let res = await fn();
  for (let i = 0; res.status === 429 && i < max; i++) {
    const secs = parseRetryAfter(res.retryAfter);
    if (deps.sleep) {
      // injected sleep (tests): one wait for the whole Retry-After
      deps.onWait?.(secs);
      await deps.sleep(secs * 1000);
    } else {
      for (let left = secs; left > 0; left--) { deps.onWait?.(left); await new Promise<void>((r) => setTimeout(r, 1000)); }
    }
    res = await fn();
  }
  deps.onWait?.(0);
  return res;
}

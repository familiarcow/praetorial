// REVIEW1 (#10, SM1 CRT-4/CRT-11/LIFE-13): the contract judges time by block_timestamp, so the app must not judge it by the
// device clock. The chain clock learns "chain time at this moment" from the latest final block header, then moves forward with
// the browser's monotonic clock (performance.now()), which a wrong or changed system clock does not affect.
// nowMs() is null until a block has been read; callers decide what to do without chain time (never silently the device clock
// for anything that decides whether money can move).

export interface ChainClockDeps {
  /** Final block timestamp in ms, or null when the RPC gave no timestamp. Throws on a network failure. */
  readBlockMs: () => Promise<number | null>;
  /** Monotonic ms (performance.now()). */
  perfNow: () => number;
}

export interface ChainClock {
  /** Chain time now in ms, or null if it was never read. */
  nowMs(): number | null;
  /** Read the latest block and re-learn chain time. true = known after this call. */
  sync(): Promise<boolean>;
  /** sync() only when chain time is unknown or older than maxAgeMs (default 5 min). */
  ensure(maxAgeMs?: number): Promise<number | null>;
  /** true when the last block read failed on the network (as opposed to answering without a timestamp). */
  lastReadFailed(): boolean;
}

/** Wall vs monotonic disagreement (ms) that means the monotonic clock was paused (sleep) and chain time must be re-read. */
export const SLEEP_DRIFT_MS = 5_000;

export function createChainClock(deps: ChainClockDeps): ChainClock {
  let base: { chainMs: number; perf: number; wall: number } | null = null;
  let inflight: Promise<boolean> | null = null;
  let failed = false;
  // OFIX1: the device clock is only a TRIGGER to re-read, never a time source. When the wall clock moved a different amount than the
  // monotonic clock since the last read, the monotonic clock missed time (macOS pauses performance.now() while the machine sleeps).
  const wallNow = () => Date.now();
  const wallAt = (perf: number) => wallNow() - (deps.perfNow() - perf);
  const drifted = () => !!base && Math.abs((wallNow() - base.wall) - (deps.perfNow() - base.perf)) > SLEEP_DRIFT_MS;
  // TFIX2: whole milliseconds. performance.now() has a fraction (Chromium: microseconds); callers turn this into ns with BigInt(ms), and
  // BigInt(1794612571102.6) throws a RangeError -- on the bet page that blanked the app mid-take (mainnet bet #1, 2026-11-13).
  const nowMs = () => (base ? Math.floor(base.chainMs + (deps.perfNow() - base.perf)) : null);
  const sync = () => {
    if (inflight) return inflight;
    inflight = (async () => {
      const t0 = deps.perfNow();
      try {
        const chainMs = await deps.readBlockMs();
        failed = false;
        if (chainMs === null || !Number.isFinite(chainMs)) return base !== null;
        // The final header was produced before the request was sent: pin it to the send time, so chain time is never over-estimated
        // (it runs a few seconds behind; APPROVAL_SAFETY_MS in lib/openApproval covers that).
        base = { chainMs, perf: t0, wall: wallAt(t0) };
        return true;
      } catch {
        failed = true;
        return base !== null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
  return {
    nowMs,
    sync,
    lastReadFailed: () => failed,
    async ensure(maxAgeMs = 5 * 60_000) {
      if (!base || deps.perfNow() - base.perf > maxAgeMs || drifted()) await sync();
      return nowMs();
    },
  };
}

const perfNow = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

/** The app's chain clock (final block header via lib/rpc). */
export const chainClock: ChainClock = createChainClock({
  readBlockMs: async () => (await import("./rpc")).viewFinalBlockTimeMs(),
  perfNow,
});

export const monotonicNow = perfNow;

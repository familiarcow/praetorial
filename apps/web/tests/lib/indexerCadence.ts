// FUND1b: how long a live test may wait for the indexer to show a bet that is already confirmed on chain.
// Documented cadence: keeper cron every minute -> POST /tick; each tick sweeps INDEXER_BATCH_BETS (12) bets per contract from a cursor.
export const INDEXER_TICK_MS = 60_000;
export const INDEXER_BATCH_BETS = 12;
const SLACK_TICKS = 2; // one for cron jitter / the 20 s single-flight lock, one for a tick that lands just after the write
/** Worst case: the cursor has just passed the bet, so reaching it takes ceil(id/batch) ticks, plus slack. */
export function indexWaitMs(betId: number): number {
  const sweep = Math.max(1, Math.ceil(Math.max(betId, 1) / INDEXER_BATCH_BETS));
  return (sweep + SLACK_TICKS) * INDEXER_TICK_MS;
}

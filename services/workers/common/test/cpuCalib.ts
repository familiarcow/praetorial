// CF1e3: local in-process CPU -> deployed-equivalent CPU calibration. The in-process harness (no workerd, no D1/network hop,
// warm JIT) under-reads Cloudflare's billed CPU. Calibration = deployed wrangler-tail reading / local reading of the SAME code at the
// pre-CF1e3 commit f3f7cc5 (frozen constants, measured once; never re-fit to absorb a regression):
//   indexer POST /tick: deployed 11 ms (x2, CF1e2)  / local min-of-5 p99 1.589 ms (1500 ticks, 20 bets + <=8 confirms) = x6.92
//   keeper tick:        deployed 10 ms (cold, CF1e) / local action_cpu_p99 1.953 ms                                  = x5.12
// Acceptance target: deployed-equivalent p99 <= 7 ms (30% headroom under the 10 ms free limit). Thresholds are never raised.
export const DEPLOYED_TARGET_MS = 7;
export const INDEXER_TICK_FACTOR = 11 / 1.589;
export const KEEPER_TICK_FACTOR = 10 / 1.953;
export const deployedEquivMs = (localMs: number, factor: number): number => localMs * factor;

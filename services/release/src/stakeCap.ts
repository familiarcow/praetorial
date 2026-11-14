// CAP3 (D-CAP3, familiarcow 2026-11-08): no stake cap at launch. Each asset's max_per_side is the LARGEST value that keeps every
// u128 computation in the escrow overflow-safe, with documented headroom. One pure derivation, shared by the generator,
// validateArgs, the web asset table (apps/web/lib/assets.ts) and the contract test fixtures (six_asset_v1_limits).
//
// Derivation. Let S be one side's stake (any asset; a cross-asset bet has an independent asset, and so an independent S, per side).
// Every contract expression that scales with S (contracts/escrow/src/lib.rs), all checked u128 (overflow-checks = true):
//   side_fee           stake * fee_bps (<= 200 by MAX_FEE_BPS; modelled up to the 10,000 envelope ceiling)       <= 10_000 S
//   fee + tip          <= 2 * side_fee                                                                           <= 2 S
//   deposit            stake + storage_charge (charge is independent of S, tiny)                                 ~  S
//   pot                stake_maker + stake_taker; pot_for_challenger = 2 * own stake (cross-asset)               <= 2 S
//   odds check         lo * MAX_SAME_ASSET_ODDS(10)                                                              <= 10 S
//   bond floor         pot * 1_000 / 10_000   <- intermediate pot * 1_000 is the BINDING one                      = 2_000 S
//   bond required      max(min_bond, floor) * 2^(round-1) + run_price (rounds pinned at 2)                       <= 0.4 S
//   objection          pot * 50 / 10_000, up to 15 deposit lines (3 filers x 5)                                  <= 100 S intermediate
//   payout group sums  stakes + storage + all bonds + all objections (I-2: out == in)                            <  4 S
// PEAK_STAKE_MULTIPLIER = 2_000 is the binding intermediate; fee*10_000 is next (10_000 S, only if fee_bps were 100%).
// SAFETY_FACTOR = 4096 (2^12): S <= u128::MAX / 4096 ~ 8.3e34. That leaves >= 2x on the binding term even if the factor were
// the only budget, and the largest POWER OF TEN under it, 10^34, leaves ~17x (binding term 2e37 vs u128::MAX 3.4e38) and
// ~3.4x on a 10,000 bps fee. A power of ten is readable in every asset's decimals (USDC 1e28 whole units, wNEAR 1e10, ...).
// The guardian can still lower it later with propose_params (24h delay, D-PARAMS1).

export const U128_MAX = (1n << 128n) - 1n;
export const STAKE_SAFETY_FACTOR = 4096n;
export const PEAK_STAKE_MULTIPLIER = 2000n;
export const MAX_FEE_BPS_MODEL = 200n; // contract MAX_FEE_BPS

/** Largest power of ten <= u128::MAX / STAKE_SAFETY_FACTOR (= 10^34), in raw units, identical for every asset. */
export function launchMaxPerSide(): bigint {
  const budget = U128_MAX / STAKE_SAFETY_FACTOR;
  let p = 1n;
  while (p * 10n <= budget) p *= 10n;
  return p;
}

export interface IntermediateParams {
  stakeMaker: bigint; stakeTaker: bigint; feeBps: bigint; maxRounds: bigint;
  storageRate: bigint; maxBytes: bigint; minFee: bigint; minBond: bigint; minObjection: bigint; runPrice: bigint;
}
export interface Intermediate { name: string; value: bigint }

const BPS = 10_000n;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Every value the escrow computes from a bet's stakes, as unbounded BigInt (so overflow is visible as value > U128_MAX).
 * Mirrors side_fee, storage_for, pot / pot_for_challenger, handle_bond, handle_objection, finalize / concede / void /
 * emergency_refund payout sums. Same-asset: pot = S + T; cross-asset: pot = 2 * own stake (both are covered).
 */
export function contractIntermediates(p: IntermediateParams): Intermediate[] {
  const out: Intermediate[] = [];
  const add = (name: string, value: bigint) => out.push({ name, value });
  const { stakeMaker: S, stakeTaker: T } = p;
  for (const [side, st] of [["maker", S], ["taker", T]] as const) {
    add(`${side} stake*fee_bps`, st * p.feeBps);
    const fee = min(st, max(st * p.feeBps / BPS, p.minFee));
    add(`${side} fee + tip`, fee + fee);
    add(`${side} bytes*rate + 2047`, p.maxBytes * p.storageRate + 2047n);
  }
  const storage = max(1n, (p.maxBytes * p.storageRate + 2047n) / 2048n);
  add("maker deposit (stake + storage)", S + storage);
  add("taker deposit (stake + storage)", T + storage);
  add("odds lo*10", min(S, T) * 10n);
  const pots = [S + T, S * 2n, T * 2n]; // same-asset pot; cross-asset pot_for_challenger maker / taker
  let bonds = 0n;
  let objections = 0n;
  for (const pot of pots) {
    add("pot*1000 (bond floor intermediate)", pot * 1000n);
    add("pot*50 (objection intermediate)", pot * 50n);
    const floor = max(p.minBond, pot * 1000n / BPS);
    let roundsSum = 0n;
    for (let r = 1n; r <= p.maxRounds; r++) {
      const challengeMin = floor * 2n ** (r - 1n);
      const required = challengeMin + p.runPrice;
      add(`bond round ${r}`, required);
      roundsSum += required;
    }
    add("sum of bonds over all rounds", roundsSum);
    const objection = max(p.minObjection, pot * 50n / BPS);
    add("objection required", objection);
    const objSum = objection * 15n; // 3 filers x 5 exhibits/rebuttals
    add("sum of objection deposits (15 lines)", objSum);
    if (roundsSum > bonds) bonds = roundsSum;
    if (objSum > objections) objections = objSum;
  }
  // worst per-(receiver,token) group sum is bounded by everything deposited into one asset for one bet (I-2)
  add("total deposited into one asset for one bet", S + T + storage * 2n + bonds + objections);
  add("both stakes summed", S + T);
  return out;
}

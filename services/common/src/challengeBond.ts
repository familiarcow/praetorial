// D-AUDIT8 (familiarcow, 2026-11-03, OQ-T10 ruling): the amount a `Bond`
// transfer must carry to open the NEXT challenge round, mirroring
// contracts/escrow/src/lib.rs's `required_challenge_bond` view /
// `handle_bond` check exactly (challenge-bond minimum -- max(min_bond,
// 10% of pot_for_challenger) -- PLUS the round's own `run_price`, so the
// round's compute is always paid from the challenger's own bond, never
// the other party's share).
//
// D-DISPUTE1 (queue item 6, dispute design doc v1 §3.2):
// the threshold is 10% of pot (was 5%), and the WHOLE
// max(min_bond, 10% pot) term DOUBLES per challenge round --
// round 1 = x1, round 2 = x2 (2^(round-1)) -- while `run_price` is
// NEVER doubled: each round pays exactly its own (undoubled) compute
// cost. `round` is therefore now a required input, 1-indexed (the
// round about to be opened, i.e. the contract's
// `bet.bonds.len() + 1`).
//
// D-ECON5: `run_price` moved off `Envelope` onto each whitelisted
// asset's own `AssetLimit` -- it is no longer a field of the envelope
// itself, so it is taken here as its own parameter instead of
// `Pick<Envelope, ...>`.
//
// D-BOND1 (cross-asset-4): a challenge bond is posted in the
// CHALLENGER's own stake asset, and sized off a "pot" that is only the
// real shared pot (stake_maker + stake_taker) for a same-asset bet --
// a cross-asset bet instead uses 2x the challenger's own stake
// (`Envelope::pot_for_challenger` on the Rust side), since there is no
// single pot denominated in one asset to take a % of. `isMaker` and
// `sameAsset` are therefore required inputs now, not derivable from
// `envelope` alone without the asset fields.
//
// Any keeper/UI amount quote for a challenge MUST go through this
// helper (or the contract's own `required_challenge_bond` view) --
// never re-derive the pre-D-AUDIT8 flat max($5, 5%) formula, the
// pre-D-BOND1 single-pot formula, or the pre-D-DISPUTE1 undoubled 10%
// formula, all of which `handle_bond` now rejects.
import type { Envelope } from "./types.js";

const BPS_DENOM = 10_000n;

export function requiredChallengeBond(
  envelope: Pick<Envelope, "stake_maker" | "stake_taker">,
  isMaker: boolean,
  sameAsset: boolean,
  challengerMinBond: string | number | bigint,
  challengerRunPrice: string | number | bigint,
  round: number | bigint,
): bigint {
  const stakeMaker = BigInt(envelope.stake_maker);
  const stakeTaker = BigInt(envelope.stake_taker);
  const potForChallenger = sameAsset
    ? stakeMaker + stakeTaker
    : 2n * (isMaker ? stakeMaker : stakeTaker);
  const tenPercentPot = (potForChallenger * 1_000n) / BPS_DENOM;
  const minBond = BigInt(challengerMinBond);
  const challengeFloor = tenPercentPot > minBond ? tenPercentPot : minBond;
  const roundExponent = BigInt(round) - 1n;
  const challengeMin = challengeFloor * (2n ** roundExponent);
  return challengeMin + BigInt(challengerRunPrice);
}

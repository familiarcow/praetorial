// RELAYDEP1 / D-RELAYDEP1: a NEP-366 delegate's inner-action deposit is charged to the RELAYER (the outer signer).
// So the relayer refuses every delegate whose inner action carries a deposit, except the bounded intended sponsorships:
// (SEC1/MON-1: no longer storage_deposit, which the user now signs and pays) the 1-yocto security deposit on
// ft_transfer_call / ft_withdraw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowedCall, PolicyViolation, LAUNCH_TOKEN_CONTRACTS, MAX_STORAGE_DEPOSIT_YOCTO, type RelayerPolicyConfig } from "../src/policy.js";

const ESCROW = "escrow3.praetorial-dev-1101.testnet";
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const WNEAR = "wrap.testnet";
const USER = "alice.testnet";
const cfg: RelayerPolicyConfig = {
  escrowContract: ESCROW, intentsContract: INTENTS, usdcTokenId: "usdc.testnet", maxTransferAmount: 1_000_000_000n,
  fundTokenContracts: [...LAUNCH_TOKEN_CONTRACTS], wnearContract: WNEAR,
};
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const call = (r: string, m: string, a: unknown, dep: bigint) => () => assertAllowedCall(cfg, r, m, enc(a), dep, USER);

test("D-RELAYDEP1: near_deposit with any deposit is refused (the relayer would pay the user's NEAR)", () => {
  for (const dep of [1n, 5n * 10n ** 22n, 10n ** 24n, 6n * 10n ** 24n]) assert.throws(call(WNEAR, "near_deposit", {}, dep), PolicyViolation, String(dep));
  assert.throws(call(WNEAR, "near_deposit", {}, 0n), PolicyViolation);
});

test("D-RELAYDEP1: request_resolution with a deposit is refused (bond is user-signed)", () => {
  for (const dep of [1n, 10n ** 22n, 10n ** 24n]) assert.throws(call(ESCROW, "request_resolution", { bet_id: 1 }, dep), PolicyViolation, String(dep));
});

test("SEC1/MON-1 (supersedes the D-RELAYDEP1 storage sponsorship): storage_deposit is never relayed, whatever the deposit", () => {
  const args = { account_id: USER, registration_only: true };
  for (const dep of [0n, 1n, 1_250_000_000_000_000_000_000n, MAX_STORAGE_DEPOSIT_YOCTO, MAX_STORAGE_DEPOSIT_YOCTO + 1n]) {
    assert.throws(call("usdc.testnet", "storage_deposit", args, dep), /storage_deposit is never relayed/);
  }
});

test("D-RELAYDEP1: the 1-yocto ft_transfer_call and ft_withdraw security deposits are still relayed", () => {
  assert.doesNotThrow(call("usdc.testnet", "ft_transfer_call", { receiver_id: INTENTS, amount: "5", msg: JSON.stringify({ receiver_id: USER }) }, 1n));
  assert.throws(call("usdc.testnet", "ft_transfer_call", { receiver_id: INTENTS, amount: "5", msg: JSON.stringify({ receiver_id: USER }) }, 2n), PolicyViolation);
});

test("D-RELAYDEP1: no deposit-bearing call to any other allowed method gets through", () => {
  assert.throws(call(INTENTS, "transfer_with_msg", { receiver_id: ESCROW, token_id: "nep141:usdc.testnet", amount: "5", msg: "{}" }, 1n), PolicyViolation);
  assert.throws(call(ESCROW, "cancel", { bet_id: 1 }, 1n), PolicyViolation);
});

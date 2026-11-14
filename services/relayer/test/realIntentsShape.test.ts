// INTENTS1: the relayer's intents allowlist must sponsor the calls REAL intents.near has (fixtures/intents_near/
// real_abi.json): stakes (open/take/bond) travel as NEP-245 `mt_transfer_call` with exactly 1 yocto. Before INTENTS1 the
// only stake path was mock-intents' `transfer_with_msg` at 0 deposit: MethodNotFound on intents.near, so every mainnet
// open/take/bond would have failed (and burnt sponsored gas).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertAllowedCall, PolicyViolation, INTENTS_METHODS, type RelayerPolicyConfig } from "../src/policy.js";

const REAL = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/intents_near/real_abi.json"), "utf8"));
const USER = "alice.near";
const mainnet: RelayerPolicyConfig = {
  escrowContract: "bets.praetorial.near",
  intentsContract: "intents.near",
  usdcTokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  stakeAssetIds: ["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "nep141:wrap.near"],
  fundTokenContracts: ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "wrap.near"],
  wnearContract: "wrap.near",
};
const testnet: RelayerPolicyConfig = {
  escrowContract: "praetorial-frz3-2611100414.praetorial-dev-1101.testnet",
  intentsContract: "intents-mock.praetorial-dev-1101.testnet",
  usdcTokenId: "nep141:usdc.testnet",
  stakeAssetIds: ["nep141:usdc.testnet", "nep141:wrap.testnet"],
  fundTokenContracts: ["usdc.testnet", "wrap.testnet"],
  wnearContract: "wrap.testnet",
};
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const call = (c: RelayerPolicyConfig, over: Record<string, unknown> = {}) =>
  enc({ receiver_id: c.escrowContract, token_id: c.stakeAssetIds![1], amount: "3000000000000000000000000", msg: JSON.stringify({ kind: "Take", bet_id: 1 }), ...over });
const ok = (c: RelayerPolicyConfig, m: string, a: Uint8Array, dep: bigint) => assertAllowedCall(c, c.intentsContract, m, a, dep, USER);
const bad = (c: RelayerPolicyConfig, m: string, a: Uint8Array, dep: bigint, re?: RegExp) =>
  assert.throws(() => assertAllowedCall(c, c.intentsContract, m, a, dep, USER), (e: unknown) => e instanceof PolicyViolation && (!re || re.test((e as Error).message)));

test("every intents method the relayer sponsors on mainnet exists on real intents.near", () => {
  for (const m of INTENTS_METHODS) {
    if (m in REAL.absent_methods) continue; // testnet-only legacy, refused on mainnet (next test)
    assert.ok(REAL.methods[m], `${m} is not a real intents.near method`);
  }
  assert.ok(INTENTS_METHODS.has("mt_transfer_call"));
});

test("mainnet: mt_transfer_call stake (open/take/bond) with exactly 1 yocto is allowed, for each stake asset", () => {
  for (const token_id of mainnet.stakeAssetIds!) ok(mainnet, "mt_transfer_call", call(mainnet, { token_id }), 1n);
  ok(mainnet, "mt_transfer_call", call(mainnet, { approval: null, memo: null }), 1n);
  ok(mainnet, "mt_transfer_call", call(mainnet, { memo: "praetorial" }), 1n);
});

test("testnet (mock-intents mirrors intents.near): mt_transfer_call allowed too", () => {
  ok(testnet, "mt_transfer_call", call(testnet), 1n);
});

test("mt_transfer_call: deposit must be exactly 1 yocto (intents.near assert_one_yocto)", () => {
  bad(mainnet, "mt_transfer_call", call(mainnet), 0n, /1 yocto/);
  bad(mainnet, "mt_transfer_call", call(mainnet), 2n, /1 yocto/);
});

test("mt_transfer_call: receiver must be the escrow, asset a stake asset, amount a positive decimal string, msg a string, no approval, no extra field", () => {
  bad(mainnet, "mt_transfer_call", call(mainnet, { receiver_id: "attacker.near" }), 1n, /escrow/);
  bad(mainnet, "mt_transfer_call", call(mainnet, { token_id: "nep141:evil.near" }), 1n);
  bad(mainnet, "mt_transfer_call", call(mainnet, { token_id: "wrap.near" }), 1n, /prefixed/);
  bad(mainnet, "mt_transfer_call", call(mainnet, { amount: "0" }), 1n);
  bad(mainnet, "mt_transfer_call", call(mainnet, { amount: 5 }), 1n);
  bad(mainnet, "mt_transfer_call", call(mainnet, { msg: undefined }), 1n);
  bad(mainnet, "mt_transfer_call", call(mainnet, { approval: ["bob.near", 1] }), 1n, /approval/);
  bad(mainnet, "mt_transfer_call", call(mainnet, { token_ids: ["nep141:wrap.near"] }), 1n, /unexpected field/);
  bad(mainnet, "mt_transfer_call", call(mainnet, { memo: 7 }), 1n);
});

test("mainnet: mock-only transfer_with_msg is refused (MethodNotFound on intents.near -> sponsored gas burnt for nothing)", () => {
  bad(mainnet, "transfer_with_msg", call(mainnet), 0n, /not.*intents\.near|mock/);
});

test("ft_withdraw: real args (bare token AccountId) with 1 yocto; a nep141:-prefixed token is refused (fails AccountId deserialization)", () => {
  ok(mainnet, "ft_withdraw", enc({ token: "wrap.near", receiver_id: USER, amount: "1000" }), 1n);
  bad(mainnet, "ft_withdraw", enc({ token: "nep141:wrap.near", receiver_id: USER, amount: "1000" }), 1n);
});

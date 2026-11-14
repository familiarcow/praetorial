// LIVE1 defect 1: the relayer refused every stake that was not the single configured USDC token
// (`transfer_with_msg token_id "nep141:wrap.testnet" is not the configured USDC token`) and capped every stake
// amount at 1e12 base units, which is 0.000001 NEAR for a 24-decimal asset. Product rule (D-CAP3): every asset the
// escrow enables may be staked, with no relayer stake cap (the contract's asset_limits are the only limit). Receiver
// (escrow), msg and shape checks stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowedCall, PolicyViolation, normalizeAssetId, stakeAssetSet, type RelayerPolicyConfig } from "../src/policy.js";

const ESCROW = "praetorial-frz2-2611091914.praetorial-dev-1101.testnet";
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const USER = "alice.testnet";
const cfg: RelayerPolicyConfig = {
  escrowContract: ESCROW,
  intentsContract: INTENTS,
  usdcTokenId: "nep141:usdc.testnet",
  stakeAssetIds: ["nep141:usdc.testnet", "wrap.testnet"],
  fundTokenContracts: ["usdc.testnet", "wrap.testnet"],
  wnearContract: "wrap.testnet",
};
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const stake = (token_id: string, amount: string, kind = "Open") =>
  enc({ token_id, receiver_id: ESCROW, amount, msg: JSON.stringify({ kind }) });
const ok = (c: RelayerPolicyConfig, recv: string, m: string, a: Uint8Array, dep = 0n) => assertAllowedCall(c, recv, m, a, dep, USER);
const bad = (c: RelayerPolicyConfig, recv: string, m: string, a: Uint8Array, dep = 0n) =>
  assert.throws(() => assertAllowedCall(c, recv, m, a, dep, USER), PolicyViolation);

test("normalizeAssetId: bare NEP-141 ids get the nep141: prefix, prefixed ids are unchanged", () => {
  assert.equal(normalizeAssetId("wrap.testnet"), "nep141:wrap.testnet");
  assert.equal(normalizeAssetId("nep141:wrap.testnet"), "nep141:wrap.testnet");
  assert.equal(normalizeAssetId(" nep141:usdc.testnet "), "nep141:usdc.testnet");
  assert.equal(normalizeAssetId("nep245:v2_1.omni.hot.tg:56_x"), "nep245:v2_1.omni.hot.tg:56_x");
});

test("open with 3 NEAR (nep141:wrap.testnet, 24 decimals) is allowed (the live 400 tonight)", () => {
  ok(cfg, INTENTS, "transfer_with_msg", stake("nep141:wrap.testnet", "3000000000000000000000000"));
});

test("open/take/bond in USDC are allowed, prefixed or bare token id", () => {
  for (const kind of ["Open", "Take", "Bond"]) {
    ok(cfg, INTENTS, "transfer_with_msg", stake("nep141:usdc.testnet", "5000000", kind));
    ok(cfg, INTENTS, "transfer_with_msg", stake("usdc.testnet", "5000000", kind));
    ok(cfg, INTENTS, "transfer_with_msg", stake("wrap.testnet", "1000000000000000000000000", kind));
  }
});

test("D-CAP3: no relayer stake cap -- a stake far above the old 1e12 ceiling is allowed", () => {
  ok({ ...cfg, maxTransferAmount: 1_000_000n }, INTENTS, "transfer_with_msg", stake("nep141:usdc.testnet", "999999999999999999"));
});

test("asset not enabled for staking is refused", () => {
  bad(cfg, INTENTS, "transfer_with_msg", stake("nep141:evil.testnet", "1"));
  bad(cfg, INTENTS, "transfer_with_msg", stake("", "1"));
});

test("receiver must still be the escrow; amount must be a positive decimal string; msg a string", () => {
  bad(cfg, INTENTS, "transfer_with_msg", enc({ token_id: "nep141:wrap.testnet", receiver_id: "attacker.testnet", amount: "1", msg: "{}" }));
  bad(cfg, INTENTS, "transfer_with_msg", stake("nep141:wrap.testnet", "0"));
  bad(cfg, INTENTS, "transfer_with_msg", enc({ token_id: "nep141:wrap.testnet", receiver_id: ESCROW, amount: 5, msg: "{}" }));
  bad(cfg, INTENTS, "transfer_with_msg", enc({ token_id: "nep141:wrap.testnet", receiver_id: ESCROW, amount: "1", msg: 1 }));
});

test("stakeAssetSet: falls back to usdcTokenId + fund token contracts (normalised) when no explicit list is configured", () => {
  const s = stakeAssetSet({ escrowContract: ESCROW, intentsContract: INTENTS, usdcTokenId: "usdc.testnet", fundTokenContracts: ["wrap.testnet"] });
  assert.deepEqual([...s].sort(), ["nep141:usdc.testnet", "nep141:wrap.testnet"]);
});

test("real NEP-141 ft_transfer_call to the escrow is allowed on every stake token contract, no amount cap", () => {
  const args = enc({ receiver_id: ESCROW, amount: "3000000000000000000000000", msg: "open" });
  ok(cfg, "wrap.testnet", "ft_transfer_call", args, 1n);
  ok(cfg, "usdc.testnet", "ft_transfer_call", args, 1n);
  bad(cfg, "evil.testnet", "ft_transfer_call", args, 1n);
});

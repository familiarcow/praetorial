// LIVE2 / WITHDRAW1: relayer allowlist for real intents.near ft_withdraw (to the signer only) (SEC1/MON-1: NEP-145 storage_deposit is no longer relayed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowedCall, PolicyViolation, MAX_STORAGE_DEPOSIT_YOCTO, type RelayerPolicyConfig } from "../src/policy.js";

const ESCROW = "escrow.praetorial.testnet";
const INTENTS = "intents.near";
const USER = "a".repeat(64);
const cfg: RelayerPolicyConfig = { escrowContract: ESCROW, intentsContract: INTENTS, usdcTokenId: "nep141:usdc.testnet", stakeAssetIds: ["nep141:usdc.testnet", "nep141:wrap.testnet"] };
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const wd = (over: Record<string, unknown> = {}) => enc({ token: "wrap.testnet", receiver_id: USER, amount: "1000", ...over });
const ok = (recv: string, m: string, a: Uint8Array, dep: bigint, sender: string | undefined = USER) => assertAllowedCall(cfg, recv, m, a, dep, sender);
const bad = (recv: string, m: string, a: Uint8Array, dep: bigint, re: RegExp, sender: string | null = USER) =>
  assert.throws(() => assertAllowedCall(cfg, recv, m, a, dep, sender ?? undefined), (e: any) => e instanceof PolicyViolation && re.test(e.message));

test("ft_withdraw: the signer withdrawing a stake asset to themselves with 1 yocto is allowed (memo optional)", () => {
  ok(INTENTS, "ft_withdraw", wd(), 1n);
  ok(INTENTS, "ft_withdraw", wd({ token: "usdc.testnet" }), 1n);
  ok(INTENTS, "ft_withdraw", wd({ memo: "withdraw" }), 1n);
});
test("ft_withdraw: never to a third party", () => {
  bad(INTENTS, "ft_withdraw", wd({ receiver_id: "attacker.testnet" }), 1n, /receiver_id must be the signer/);
  bad(INTENTS, "ft_withdraw", wd({ receiver_id: undefined }), 1n, /receiver_id must be the signer/);
  bad(INTENTS, "ft_withdraw", wd(), 1n, /sender id/, null);
});
test("ft_withdraw: no msg (ft_transfer_call into some contract), no storage_deposit, no unknown fields", () => {
  bad(INTENTS, "ft_withdraw", wd({ msg: "x" }), 1n, /unexpected field "msg"/);
  bad(INTENTS, "ft_withdraw", wd({ storage_deposit: "1" }), 1n, /unexpected field/);
  bad(INTENTS, "ft_withdraw", wd({ min_gas: "1" }), 1n, /unexpected field/);
});
test("ft_withdraw: exactly 1 yocto; positive decimal-string amount; token must be a stake asset's bare contract", () => {
  bad(INTENTS, "ft_withdraw", wd(), 0n, /exactly 1 yocto/);
  bad(INTENTS, "ft_withdraw", wd(), 2n, /exactly 1 yocto/);
  bad(INTENTS, "ft_withdraw", wd({ amount: "0" }), 1n, /> 0/);
  bad(INTENTS, "ft_withdraw", wd({ amount: 1000 }), 1n, /decimal string/);
  bad(INTENTS, "ft_withdraw", wd({ token: "evil.testnet" }), 1n, /not a stake asset/);
  bad(INTENTS, "ft_withdraw", wd({ token: "nep141:wrap.testnet" }), 1n, /not a stake asset/);
});
test("ft_withdraw is only on the intents contract (not on escrow, not on a token)", () => {
  bad(ESCROW, "ft_withdraw", wd(), 1n, /not on the allowlist/);
  bad("wrap.testnet", "ft_withdraw", wd(), 1n, /not on the allowlist/);
});
test("transfer_with_msg on intents still refuses an attached deposit (non-payable)", () => {
  bad(INTENTS, "transfer_with_msg", enc({ token_id: "nep141:wrap.testnet", receiver_id: ESCROW, amount: "1", msg: "{}" }), 1n, /not payable/);
});
test("SEC1/MON-1: storage_deposit is never relayed (the user signs and pays it): every shape, every token, refused", () => {
  const sd = (over: Record<string, unknown> = {}) => enc({ account_id: USER, registration_only: true, ...over });
  for (const [token, dep] of [["wrap.testnet", 1_250_000_000_000_000_000_000n], ["usdc.testnet", MAX_STORAGE_DEPOSIT_YOCTO], ["wrap.testnet", 1n]] as const) {
    bad(token, "storage_deposit", sd(), dep, /never relayed/);
  }
  bad("evil.testnet", "storage_deposit", sd(), 1n, /never relayed/);
  bad(INTENTS, "storage_deposit", sd(), 1n, /not on the allowlist/);
});

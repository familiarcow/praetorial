// RELAYFUND1: policy for D-FUND1 path 3 ("Move to betting balance"):
// ft_transfer_call(intents, amount, {"receiver_id": <sender>}) with 1 yocto on the launch token contracts,
// and near_deposit on the configured wNEAR contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowedCall, PolicyViolation, LAUNCH_TOKEN_CONTRACTS, type RelayerPolicyConfig } from "../src/policy.js";

const ESCROW = "escrow3.praetorial-dev-1101.testnet";
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const WNEAR = "wrap.near";
const USER = "alice.testnet";
const cfg: RelayerPolicyConfig = {
  escrowContract: ESCROW,
  intentsContract: INTENTS,
  usdcTokenId: "usdc.testnet",
  maxTransferAmount: 1_000_000_000n,
  fundTokenContracts: [...LAUNCH_TOKEN_CONTRACTS],
  wnearContract: WNEAR,
};
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const move = (over: Record<string, unknown> = {}) =>
  enc({ receiver_id: INTENTS, amount: "100000000000000000000000", msg: JSON.stringify({ receiver_id: USER }), ...over });
const ok = (recv: string, m: string, a: Uint8Array, dep: bigint, sender: string | null = USER) =>
  assertAllowedCall(cfg, recv, m, a, dep, sender ?? undefined);
const bad = (recv: string, m: string, a: Uint8Array, dep: bigint, sender: string | null = USER) =>
  assert.throws(() => assertAllowedCall(cfg, recv, m, a, dep, sender ?? undefined), PolicyViolation);

test("launch token list is the six D-ASSET1 assets (mainnet ids) plus the testnet pair", () => {
  for (const t of ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "usdt.tether-token.near", "btc.omft.near", "wrap.near", "eth.omft.near", "zec.omft.near", "usdc.testnet", "wrap.testnet"]) {
    assert.ok(LAUNCH_TOKEN_CONTRACTS.includes(t), t);
  }
});

test("move-to-betting: allowed on every launch token contract", () => {
  for (const t of LAUNCH_TOKEN_CONTRACTS) ok(t, "ft_transfer_call", move(), 1n);
});

test("move-to-betting: refuses wrong receiver", () => {
  bad(WNEAR, "ft_transfer_call", move({ receiver_id: "attacker.testnet" }), 1n);
  bad(WNEAR, "ft_transfer_call", move({ receiver_id: USER }), 1n);
});

test("move-to-betting: refuses msg recipient != sender (and malformed msg)", () => {
  bad(WNEAR, "ft_transfer_call", move({ msg: JSON.stringify({ receiver_id: "bob.testnet" }) }), 1n);
  bad(WNEAR, "ft_transfer_call", move({ msg: "" }), 1n);
  bad(WNEAR, "ft_transfer_call", move({ msg: USER }), 1n);
  bad(WNEAR, "ft_transfer_call", move({ msg: "not json" }), 1n);
  bad(WNEAR, "ft_transfer_call", move({ msg: JSON.stringify({ receiver_id: USER, extra: 1 }) }), 1n);
  bad(WNEAR, "ft_transfer_call", move({ msg: JSON.stringify({}) }), 1n);
});

test("move-to-betting: deposit must be exactly 1 yocto", () => {
  bad(WNEAR, "ft_transfer_call", move(), 0n);
  bad(WNEAR, "ft_transfer_call", move(), 2n);
  bad(WNEAR, "ft_transfer_call", move(), 10n ** 24n);
});

test("move-to-betting: refuses unknown token contract", () => {
  bad("evil-token.testnet", "ft_transfer_call", move(), 1n);
});

test("move-to-betting: refuses without a sender id", () => {
  bad(WNEAR, "ft_transfer_call", move(), 1n, null);
});

test("move-to-betting: bad amounts and extra fields refused", () => {
  bad(WNEAR, "ft_transfer_call", move({ amount: "0" }), 1n);
  bad(WNEAR, "ft_transfer_call", move({ amount: 5 }), 1n);
  bad(WNEAR, "ft_transfer_call", move({ token_id: "x" }), 1n);
  bad(WNEAR, "ft_transfer_call", move({ extra: 1 }), 1n);
});

test("move-to-betting: other token methods stay refused", () => {
  bad(WNEAR, "ft_transfer", move(), 1n);
  bad(WNEAR, "storage_deposit", enc({}), 1n);
});

// D-RELAYDEP1 supersedes RELAYFUND1's "the relayer sponsors near_deposit": a delegate's inner deposit is paid by the RELAYER,
// so near_deposit is refused for every deposit, contract and arg shape (see relaydep1.test.ts).
test("near_deposit: never relayed (D-RELAYDEP1), whatever the contract, args or deposit", () => {
  for (const dep of [0n, 1n, 10n ** 23n]) {
    bad(WNEAR, "near_deposit", enc({}), dep);
    bad(WNEAR, "near_deposit", new Uint8Array(), dep);
    bad("wrap.testnet", "near_deposit", enc({}), dep);
    bad("usdc.testnet", "near_deposit", enc({}), dep);
  }
  bad(WNEAR, "near_deposit", enc({ account_id: "bob.testnet" }), 10n ** 23n);
});

test("existing escrow path on a token that is also a launch token is unchanged", () => {
  const usdc = "usdc.testnet";
  ok(usdc, "ft_transfer_call", enc({ receiver_id: ESCROW, amount: "1000", msg: "{}" }), 1n);
  bad(usdc, "ft_transfer_call", enc({ receiver_id: ESCROW, amount: "1000", msg: "{}" }), 2n);
});

test("intents/escrow rules are not loosened by the fund config", () => {
  bad(INTENTS, "ft_transfer_call", move(), 1n);
  bad(ESCROW, "near_deposit", enc({}), 1n);
});

test("without fund config, move-to-betting stays refused (default-deny)", () => {
  const c2: RelayerPolicyConfig = { ...cfg, fundTokenContracts: undefined, wnearContract: undefined };
  assert.throws(() => assertAllowedCall(c2, WNEAR, "ft_transfer_call", move(), 1n, USER), PolicyViolation);
  assert.throws(() => assertAllowedCall(c2, WNEAR, "near_deposit", enc({}), 10n, USER), PolicyViolation);
});

// RELAYFUND2 (2): with intentsContract unset, a launch-token ft_transfer_call without receiver_id used to match
// `undefined === undefined` and reach assertMoveToBettingArgs. It must be refused outright.
test("move-to-betting: refused when intentsContract is unset (no receiver_id, or any receiver_id)", () => {
  const noIntents: any = { ...cfg, intentsContract: undefined };
  for (const args of [enc({ amount: "1", msg: JSON.stringify({ receiver_id: USER }) }), move(), move({ receiver_id: undefined })]) {
    assert.throws(() => assertAllowedCall(noIntents, WNEAR, "ft_transfer_call", args, 1n, USER), (e: any) => e instanceof PolicyViolation && /intents/i.test(e.message));
  }
  const emptyIntents: any = { ...cfg, intentsContract: "" };
  assert.throws(() => assertAllowedCall(emptyIntents, WNEAR, "ft_transfer_call", enc({ amount: "1", msg: "" }), 1n, USER), PolicyViolation);
});

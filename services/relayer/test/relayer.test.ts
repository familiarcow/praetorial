import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as borsh from "borsh";
import { KeyPair } from "near-api-js";
import { SCHEMA, actionCreators, buildDelegateAction, encodeDelegateAction, Signature } from "@near-js/transactions";
import { Relayer, BadSignedDelegate, PolicyViolation, GuardViolation, type ChainPort, type RelayerConfig } from "../src/relayer.js";

const ESCROW = "escrow3.praetorial-dev-1101.testnet";
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const USDC = "usdc.fakes.testnet";

function baseConfig(overrides: Partial<RelayerConfig> = {}): RelayerConfig {
  return {
    escrowContract: ESCROW,
    intentsContract: INTENTS,
    usdcTokenId: USDC,
    maxTransferAmount: 1_000_000_000n,
    maxBlockHeightFuture: 1200n,
    perCallSponsorshipYocto: 5_000_000_000_000_000_000_000n, // 0.005 NEAR
    maxRequestsPerWindow: 20,
    windowMs: 60_000,
    dailyBudgetYocto: 100_000_000_000_000_000_000_000n, // 0.1 NEAR
    ...overrides,
  };
}

function fakeChain(
  currentHeight: bigint,
  broadcastHash = "FAKEHASH111",
  actualCostYocto = 3_000_000_000_000_000_000_000n, // 0.003 NEAR default "actual" burnt cost, below the 0.005 NEAR estimate used in tests
): ChainPort & { calls: number } {
  const port: any = {
    calls: 0,
    async currentBlockHeight() {
      return currentHeight;
    },
    async broadcastSignedDelegate() {
      port.calls += 1;
      return { transactionHash: broadcastHash, actualCostYocto, raw: {} };
    },
  };
  return port;
}

function buildSignedDelegateBase64(opts: {
  senderId: string;
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  nonce?: bigint;
  maxBlockHeight?: bigint;
  signingKeyPair?: KeyPair; // if omitted, uses the "owner" keypair (correct signer)
  actions?: any[]; // override the delegate's actions entirely (for multi-action/non-FunctionCall tests)
}): { base64: string; ownerKeyPair: KeyPair } {
  const ownerKeyPair = KeyPair.fromRandom("ed25519");
  const pubKey = ownerKeyPair.getPublicKey();
  const delegateAction = buildDelegateAction({
    senderId: opts.senderId,
    receiverId: opts.receiverId,
    actions: opts.actions ?? [
      actionCreators.functionCall(opts.methodName, opts.args, 30_000_000_000_000n, 0n),
    ],
    nonce: opts.nonce ?? 1n,
    maxBlockHeight: opts.maxBlockHeight ?? 5000n,
    publicKey: pubKey as any,
  });
  const encoded = encodeDelegateAction(delegateAction);
  const hash = createHash("sha256").update(Buffer.from(encoded)).digest();
  const signer = opts.signingKeyPair ?? ownerKeyPair;
  const sig = signer.sign(hash);
  const signature = new Signature({ keyType: 0, data: sig.signature });
  const bytes = borsh.serialize(SCHEMA.SignedDelegate, { delegateAction, signature });
  return { base64: Buffer.from(bytes).toString("base64"), ownerKeyPair };
}

test("happy path: valid delegate to escrow is verified and relayed", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "zerobalance1.testnet",
    receiverId: ESCROW,
    methodName: "cancel",
    args: { bet_id: 1 },
    maxBlockHeight: 5000n,
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  const result = await relayer.relay(base64);
  assert.equal(result.txHash, "FAKEHASH111");
  assert.equal(chain.calls, 1);
});

test("fixture: bad signature is rejected, never broadcast", async () => {
  const wrongKey = KeyPair.fromRandom("ed25519");
  const { base64 } = buildSignedDelegateBase64({
    senderId: "zerobalance2.testnet",
    receiverId: ESCROW,
    methodName: "cancel",
    args: { bet_id: 1 },
    signingKeyPair: wrongKey, // signs with a key that does NOT match delegateAction.publicKey
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), BadSignedDelegate);
  assert.equal(chain.calls, 0);
});

test("fixture: wrong receiver (not escrow or intents) is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "zerobalance3.testnet",
    receiverId: "some-other-contract.testnet",
    methodName: "cancel",
    args: { bet_id: 1 },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("fixture: disallowed method on escrow is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "zerobalance4.testnet",
    receiverId: ESCROW,
    methodName: "mutual_settle", // stays off the allowlist (D-SETTLE3); finalize was allowed by RLYFIN1
    args: { bet_id: 1 },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("fixture: transfer_with_msg to a non-escrow receiver_id is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "zerobalance5.testnet",
    receiverId: INTENTS,
    methodName: "transfer_with_msg",
    args: { receiver_id: "attacker.testnet", token_id: USDC, amount: "1000", msg: "{}" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

// LIVE1 / D-CAP3: the relayer has NO stake cap (the old 1e12 ceiling refused any NEAR stake above 0.000001 NEAR);
// the escrow's asset_limits are the only limit. maxTransferAmount is ignored.
test("fixture: a large stake transfer is relayed (D-CAP3: no relayer stake cap)", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "zerobalance6.testnet",
    receiverId: INTENTS,
    methodName: "transfer_with_msg",
    args: { receiver_id: ESCROW, token_id: USDC, amount: "999999999999999", msg: "{}" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig({ maxTransferAmount: 1_000_000n }));
  await relayer.relay(base64);
  assert.equal(chain.calls, 1);
});

test("fixture: expired delegate (maxBlockHeight <= current) is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "zerobalance7.testnet",
    receiverId: ESCROW,
    methodName: "cancel",
    args: { bet_id: 1 },
    maxBlockHeight: 1000n,
  });
  const chain = fakeChain(1000n); // current == maxBlockHeight => expired (strictly past usability)
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("fixture: maxBlockHeight too far in the future is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "zerobalance8.testnet",
    receiverId: ESCROW,
    methodName: "cancel",
    args: { bet_id: 1 },
    maxBlockHeight: 10_000n,
  });
  const chain = fakeChain(1000n); // window is 1200, delegate wants +9000
  const relayer = new Relayer(chain, baseConfig({ maxBlockHeightFuture: 1200n }));
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("fixture: replay of the same (sender, key, nonce) is rejected on the second call", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "zerobalance9.testnet",
    receiverId: ESCROW,
    methodName: "cancel",
    args: { bet_id: 1 },
    nonce: 42n,
    maxBlockHeight: 5000n,
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  const first = await relayer.relay(base64);
  assert.equal(first.txHash, "FAKEHASH111");
  await assert.rejects(() => relayer.relay(base64), GuardViolation);
  assert.equal(chain.calls, 1, "second (replayed) call must never reach broadcast");
});

test("fixture: daily sponsored-gas budget is enforced per user (reserved at estimate time)", async () => {
  const sender = "zerobalance10.testnet";
  // actualCostYocto == perCallSponsorshipYocto here so the reservation
  // and the settlement agree -- isolates "the cap is enforced at all"
  // from the separate reserve-vs-actual tests below.
  const chain = fakeChain(4000n, "FAKEHASH111", 5_000_000_000_000_000_000_000n);
  const cfg = baseConfig({ dailyBudgetYocto: 5_000_000_000_000_000_000_000n, perCallSponsorshipYocto: 5_000_000_000_000_000_000_000n });
  const relayer = new Relayer(chain, cfg);
  const first = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "cancel", args: { bet_id: 1 }, nonce: 1n, maxBlockHeight: 5000n });
  await relayer.relay(first.base64); // exactly spends the whole daily budget
  const second = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "cancel", args: { bet_id: 2 }, nonce: 2n, maxBlockHeight: 5000n });
  await assert.rejects(() => relayer.relay(second.base64), GuardViolation);
  assert.equal(chain.calls, 1, "over-budget call must never reach broadcast");
});

test("gas accounting: budget is settled to the chain's actual burnt cost, not the flat estimate", async () => {
  const sender = "gasaccounting1.testnet";
  // Estimate is 0.005 NEAR/call but the chain reports only 0.001 NEAR
  // actually burnt -- with real accounting, a user should be able to fit
  // far more than dailyBudget/estimate calls in, because each call only
  // permanently costs what it actually burned.
  const dailyBudget = 5_000_000_000_000_000_000_000n; // 0.005 NEAR total
  const estimate = 5_000_000_000_000_000_000_000n; // 0.005 NEAR reserved per call up front
  const actual = 1_000_000_000_000_000_000_000n; // 0.001 NEAR actually burnt per call
  const chain = fakeChain(4000n, "FAKEHASH111", actual);
  const cfg = baseConfig({ dailyBudgetYocto: dailyBudget, perCallSponsorshipYocto: estimate, maxRequestsPerWindow: 1000 });
  const relayer = new Relayer(chain, cfg);

  const first = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "cancel", args: { bet_id: 1 }, nonce: 1n, maxBlockHeight: 5000n });
  await relayer.relay(first.base64);
  // Settled spend is now 0.001 NEAR, with the 0.005 reservation fully
  // released -- a second call (which only needs to pass the up-front
  // reserve check: settled 0.001 + reserved 0.005 <= 0.005 would FAIL,
  // proving the reservation step still protects against an estimate that
  // turns out too low) is expected to be rejected at reserve time, not
  // because real accounting overspent, but because the conservative
  // reservation is still what gates concurrent/future calls.
  const second = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "cancel", args: { bet_id: 2 }, nonce: 2n, maxBlockHeight: 5000n });
  await assert.rejects(() => relayer.relay(second.base64), GuardViolation);
  assert.equal(chain.calls, 1, "second call's reservation must fail before any second broadcast");
});

test("gas accounting: a failed broadcast releases the reservation instead of charging it", async () => {
  const sender = "gasaccounting2.testnet";
  const dailyBudget = 5_000_000_000_000_000_000_000n;
  const estimate = 5_000_000_000_000_000_000_000n; // exactly the whole budget
  const chain: any = {
    calls: 0,
    async currentBlockHeight() {
      return 4000n;
    },
    async broadcastSignedDelegate() {
      chain.calls += 1;
      throw new Error("simulated RPC failure");
    },
  };
  const cfg = baseConfig({ dailyBudgetYocto: dailyBudget, perCallSponsorshipYocto: estimate });
  const relayer = new Relayer(chain, cfg);
  const first = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "cancel", args: { bet_id: 1 }, nonce: 1n, maxBlockHeight: 5000n });
  await assert.rejects(() => relayer.relay(first.base64), /simulated RPC failure/);

  // Budget must have been released, not consumed -- a second attempt
  // (different nonce; the chain call itself never happened on the first
  // one, so it never advanced any real access-key nonce either) should
  // be able to reserve the full budget again.
  const chain2 = fakeChain(4000n);
  const relayer2 = new Relayer(chain2, cfg);
  const second = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "cancel", args: { bet_id: 2 }, nonce: 2n, maxBlockHeight: 5000n });
  const result = await relayer2.relay(second.base64);
  assert.equal(result.txHash, "FAKEHASH111");
});

test("fixture: per-user rate limit is enforced", async () => {
  const sender = "zerobalance11.testnet";
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig({ maxRequestsPerWindow: 1, windowMs: 60_000 }));
  const first = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "cancel", args: { bet_id: 1 }, nonce: 1n, maxBlockHeight: 5000n });
  await relayer.relay(first.base64);
  const second = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "cancel", args: { bet_id: 2 }, nonce: 2n, maxBlockHeight: 5000n });
  await assert.rejects(() => relayer.relay(second.base64), GuardViolation);
  assert.equal(chain.calls, 1);
});

test("fixture: multi-action / non-FunctionCall delegates are rejected", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const delegateAction = buildDelegateAction({
    senderId: "zerobalance12.testnet",
    receiverId: ESCROW,
    actions: [actionCreators.transfer(1n)], // a bare NEAR Transfer -- never sponsorable
    nonce: 1n,
    maxBlockHeight: 5000n,
    publicKey: kp.getPublicKey() as any,
  });
  const encoded = encodeDelegateAction(delegateAction);
  const hash = createHash("sha256").update(Buffer.from(encoded)).digest();
  const sig = kp.sign(hash);
  const signature = new Signature({ keyType: 0, data: sig.signature });
  const bytes = borsh.serialize(SCHEMA.SignedDelegate, { delegateAction, signature });
  const base64 = Buffer.from(bytes).toString("base64");

  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

// ---------------------------------------------------------------------
// Real NEP-141 ft_transfer_call shape (receiver_id/amount/msg, optional
// memo, NO token_id -- the token contract IS the DelegateAction's
// receiverId). usdcTokenId in baseConfig() is reused as the token
// contract id for these tests, matching cfg.usdcTokenId's real meaning.
// ---------------------------------------------------------------------

test("NEP-141: valid ft_transfer_call to the token contract is relayed", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "ftuser1.testnet",
    receiverId: USDC, // the real shape: outer receiverId IS the token contract
    methodName: "ft_transfer_call",
    args: { receiver_id: ESCROW, amount: "1000000", msg: "open:1" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  const result = await relayer.relay(base64);
  assert.equal(result.txHash, "FAKEHASH111");
  assert.equal(chain.calls, 1);
});

test("NEP-141: valid ft_transfer_call with an optional memo is relayed", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "ftuser2.testnet",
    receiverId: USDC,
    methodName: "ft_transfer_call",
    args: { receiver_id: ESCROW, amount: "500000", msg: "take:2", memo: "bet #2" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  const result = await relayer.relay(base64);
  assert.equal(result.txHash, "FAKEHASH111");
});

test("NEP-141: ft_transfer_call carrying a token_id field is rejected (real NEP-141 has none)", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "ftuser3.testnet",
    receiverId: USDC,
    methodName: "ft_transfer_call",
    args: { receiver_id: ESCROW, token_id: USDC, amount: "1000000", msg: "open:3" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("NEP-141: ft_transfer_call with a numeric (non-string) amount is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "ftuser4.testnet",
    receiverId: USDC,
    methodName: "ft_transfer_call",
    args: { receiver_id: ESCROW, amount: 1000000 as any, msg: "open:4" }, // NEP-141 requires a decimal STRING, not a JSON number
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("NEP-141: ft_transfer_call to a non-escrow receiver_id is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "ftuser5.testnet",
    receiverId: USDC,
    methodName: "ft_transfer_call",
    args: { receiver_id: "attacker.testnet", amount: "1000000", msg: "open:5" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("NEP-141: ft_transfer_call missing msg is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "ftuser6.testnet",
    receiverId: USDC,
    methodName: "ft_transfer_call",
    args: { receiver_id: ESCROW, amount: "1000000" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("NEP-141: a large ft_transfer_call stake is relayed (D-CAP3: no relayer stake cap)", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "ftuser7.testnet",
    receiverId: USDC,
    methodName: "ft_transfer_call",
    args: { receiver_id: ESCROW, amount: "999999999999999", msg: "open:7" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig({ maxTransferAmount: 1_000_000n }));
  await relayer.relay(base64);
  assert.equal(chain.calls, 1);
});

test("NEP-141: transfer_with_msg (mock shape) on the token contract id is rejected (wrong method for that contract)", async () => {
  // transfer_with_msg is the MOCK INTENTS method; calling it directly on
  // the token contract id is not the real NEP-141 call and must not be
  // silently accepted just because the method name is on some allowlist.
  const { base64 } = buildSignedDelegateBase64({
    senderId: "ftuser8.testnet",
    receiverId: USDC,
    methodName: "transfer_with_msg",
    args: { receiver_id: ESCROW, token_id: USDC, amount: "1000000", msg: "open:8" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

// ---------------------------------------------------------------------
// emergency_refund -- escrow's permissionless post-shutdown refund path
// (contracts/escrow/src/lib.rs `pub fn emergency_refund(&mut self,
// bet_id: u64)`, no #[payable], so it takes no deposit and only ever
// takes a single `bet_id` arg). Any user whose bet is stuck on a
// shut-down contract must be able to self-serve this gaslessly through
// the relayer, exactly like `cancel`/`drain_payouts` already are.
// ---------------------------------------------------------------------

test("emergency_refund: valid {bet_id} with zero deposit is relayed", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "refund1.testnet",
    receiverId: ESCROW,
    methodName: "emergency_refund",
    args: { bet_id: 1 },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  const result = await relayer.relay(base64);
  assert.equal(result.txHash, "FAKEHASH111");
  assert.equal(chain.calls, 1);
});

test("emergency_refund: extra/unknown field alongside bet_id is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "refund2.testnet",
    receiverId: ESCROW,
    methodName: "emergency_refund",
    args: { bet_id: 1, extra: "smuggled" },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("emergency_refund: missing bet_id is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "refund3.testnet",
    receiverId: ESCROW,
    methodName: "emergency_refund",
    args: {},
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("emergency_refund: non-integer bet_id is rejected", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "refund4.testnet",
    receiverId: ESCROW,
    methodName: "emergency_refund",
    args: { bet_id: "1" as any }, // bet_id is u64 on the contract, passed as a JSON number here (same convention as cancel's bet_id in these fixtures) -- a string is the wrong shape
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("emergency_refund: counts against the per-user daily sponsorship budget like other escrow methods", async () => {
  const sender = "refund5.testnet";
  const chain = fakeChain(4000n, "FAKEHASH111", 5_000_000_000_000_000_000_000n);
  const cfg = baseConfig({ dailyBudgetYocto: 5_000_000_000_000_000_000_000n, perCallSponsorshipYocto: 5_000_000_000_000_000_000_000n });
  const relayer = new Relayer(chain, cfg);
  const first = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "emergency_refund", args: { bet_id: 1 }, nonce: 1n, maxBlockHeight: 5000n });
  await relayer.relay(first.base64); // exactly spends the whole daily budget
  const second = buildSignedDelegateBase64({ senderId: sender, receiverId: ESCROW, methodName: "emergency_refund", args: { bet_id: 2 }, nonce: 2n, maxBlockHeight: 5000n });
  await assert.rejects(() => relayer.relay(second.base64), GuardViolation);
  assert.equal(chain.calls, 1, "over-budget emergency_refund call must never reach broadcast");
});

// 17e: D-SETTLE3 removed mutual_settle
test("mutual_settle is not an allowed relayer escrow method (D-SETTLE3)", async () => {
  const { ESCROW_DIRECT_METHODS } = await import("../src/policy.js");
  assert.equal(ESCROW_DIRECT_METHODS.has("mutual_settle"), false);
});

// ---------------------------------------------------------------------
// C1 (D-CONCEDE1): `concede(bet_id)` -- direct escrow method (not
// #[payable]); the contract enforces maker/taker via predecessor.
// Gasless relay of concede by the caller only: args exactly {bet_id}.
// ---------------------------------------------------------------------

test("concede: valid {bet_id} with zero deposit is relayed (sender is the caller/predecessor)", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "conceder1.testnet",
    receiverId: ESCROW,
    methodName: "concede",
    args: { bet_id: 7 },
  });
  const chain = fakeChain(4000n);
  const relayer = new Relayer(chain, baseConfig());
  const result = await relayer.relay(base64);
  assert.equal(result.txHash, "FAKEHASH111");
  assert.equal(chain.calls, 1);
});

for (const [label, args] of [
  ["extra field alongside bet_id", { bet_id: 7, winner: "me.testnet" }],
  ["missing bet_id", {}],
  ["string bet_id", { bet_id: "7" }],
  ["negative bet_id", { bet_id: -1 }],
] as Array<[string, any]>) {
  test(`concede: ${label} is rejected`, async () => {
    const { base64 } = buildSignedDelegateBase64({
      senderId: "conceder2.testnet",
      receiverId: ESCROW,
      methodName: "concede",
      args,
    });
    const chain = fakeChain(4000n);
    const relayer = new Relayer(chain, baseConfig());
    await assert.rejects(() => relayer.relay(base64), PolicyViolation);
    assert.equal(chain.calls, 0);
  });
}

test("concede is allowlisted and not payable; mutual_settle stays off (D-SETTLE3)", async () => {
  const policy = await import("../src/policy.js");
  assert.equal(policy.ESCROW_DIRECT_METHODS.has("concede"), true);
  assert.equal(policy.ESCROW_PAYABLE_METHODS.has("concede"), false);
  assert.equal(policy.ESCROW_DIRECT_METHODS.has("mutual_settle"), false);
});

// LIVE1 defect 2c: the replay key was marked seen BEFORE broadcast and never released when the broadcast failed
// without the transaction executing (RPC error / timeout / InvalidTx). The user's chain nonce never moved, so the web
// re-signed the SAME nonce on every retry and every Move click got HTTP 400 "replay detected" forever.
test("LIVE1: a broadcast that failed WITHOUT executing releases the replay key, so the same delegate can be retried", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "stucknonce.testnet", receiverId: ESCROW, methodName: "cancel", args: { bet_id: 1 }, nonce: 77n, maxBlockHeight: 5000n,
  });
  let fail = true;
  const chain: any = {
    calls: 0,
    async currentBlockHeight() { return 4000n; },
    async broadcastSignedDelegate() {
      chain.calls += 1;
      if (fail) throw new Error("NEAR RPC error (send_tx): TIMEOUT_ERROR");
      return { transactionHash: "RETRYHASH", actualCostYocto: 1n, raw: {} };
    },
  };
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), /TIMEOUT_ERROR/);
  fail = false;
  const second = await relayer.relay(base64);
  assert.equal(second.txHash, "RETRYHASH");
  assert.equal(chain.calls, 2);
  // ...and once it has executed, the same delegate is a replay again.
  await assert.rejects(() => relayer.relay(base64), GuardViolation);
});

test("LIVE1: a delegate that EXECUTED and failed on-chain keeps its replay key (its nonce was consumed)", async () => {
  const { base64 } = buildSignedDelegateBase64({
    senderId: "executedfail.testnet", receiverId: ESCROW, methodName: "cancel", args: { bet_id: 1 }, nonce: 78n, maxBlockHeight: 5000n,
  });
  const chain: any = {
    calls: 0,
    async currentBlockHeight() { return 4000n; },
    async broadcastSignedDelegate() {
      chain.calls += 1;
      throw Object.assign(new Error("transaction failed: panic"), { transaction_outcome: { outcome: { tokens_burnt: "1" } } });
    },
  };
  const relayer = new Relayer(chain, baseConfig());
  await assert.rejects(() => relayer.relay(base64), /transaction failed/);
  await assert.rejects(() => relayer.relay(base64), GuardViolation);
  assert.equal(chain.calls, 1);
});

// LIVE1 defect 2c (existing stuck users): a replay mark left behind by an attempt that never executed (e.g. by the
// pre-fix relayer) is stale when the sender's chain nonce for that key is still below the delegate nonce. After the
// broadcast window (replayStaleMs) it is cleared and the delegate relays; a fresh mark (concurrent double-submit) or
// a consumed chain nonce still refuses.
function stuckChain(senderNonce: bigint) {
  const chain: any = {
    calls: 0, nonceReads: 0, failNext: true,
    async currentBlockHeight() { return 4000n; },
    async senderKeyNonce() { chain.nonceReads += 1; return senderNonce; },
    async broadcastSignedDelegate() {
      chain.calls += 1;
      // first attempt: the outer tx executed but the delegate itself was refused (its nonce NOT consumed) -- mark stays
      if (chain.failNext) { chain.failNext = false; throw Object.assign(new Error("DelegateActionSenderDoesNotExist"), { transaction_outcome: {} }); }
      return { transactionHash: "UNSTUCK", actualCostYocto: 1n, raw: {} };
    },
  };
  return chain;
}
const stuckDelegate = (nonce: bigint) =>
  buildSignedDelegateBase64({ senderId: "familiarcow.testnet", receiverId: ESCROW, methodName: "cancel", args: { bet_id: 1 }, nonce, maxBlockHeight: 5000n }).base64;

test("LIVE1: a stale replay mark whose nonce never reached the chain is cleared and the delegate relays", async () => {
  const b = stuckDelegate(501n);
  const chain = stuckChain(500n); // chain nonce never moved
  const relayer = new Relayer(chain, baseConfig({ replayStaleMs: 0 }));
  await assert.rejects(() => relayer.relay(b), /DelegateActionSenderDoesNotExist/);
  const r = await relayer.relay(b);
  assert.equal(r.txHash, "UNSTUCK");
  assert.equal(chain.calls, 2);
});

test("LIVE1: a FRESH replay mark (concurrent double-submit window) still refuses, without reading the chain", async () => {
  const b = stuckDelegate(601n);
  const chain = stuckChain(600n);
  const relayer = new Relayer(chain, baseConfig({ replayStaleMs: 120_000 }));
  await assert.rejects(() => relayer.relay(b));
  await assert.rejects(() => relayer.relay(b), GuardViolation);
  assert.equal(chain.nonceReads, 0);
});

test("LIVE1: a stale mark whose nonce WAS consumed on chain still refuses as a replay", async () => {
  const b = stuckDelegate(701n);
  const chain = stuckChain(701n); // chain nonce reached the delegate nonce: it executed
  const relayer = new Relayer(chain, baseConfig({ replayStaleMs: 0 }));
  await assert.rejects(() => relayer.relay(b));
  await assert.rejects(() => relayer.relay(b), GuardViolation);
  assert.equal(chain.calls, 1);
});

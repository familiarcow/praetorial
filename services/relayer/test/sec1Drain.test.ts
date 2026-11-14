// SEC1 (SM1 MON-1, MON-9): relayer drains. Promoted from spikes/sm1/tests/mon_relayer.test.ts "MON-1".
// MON-1: in NEP-366 the relayer (outer signer) pays every deposit attached to a delegate's inner action, and NEP-145
// storage_deposit refunds it to the delegate sender. A relayed storage_deposit(0.01 NEAR) was allowed and the budget
// only counted gas, so anyone could pull 0.01 NEAR per call out of the relayer. Fix: storage_deposit is never relayed
// (the web signs it as the user's own tx, like near_deposit), and every attached deposit counts against the budgets.
// MON-9: /activate paid 0.002 NEAR to any fresh id holding 1 base unit of a stake asset, and two concurrent calls both paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as borsh from "borsh";
import { KeyPair } from "near-api-js";
import { SCHEMA, actionCreators, buildDelegateAction, encodeDelegateAction, Signature } from "@near-js/transactions";
import { Relayer, PolicyViolation, type ChainPort, type RelayerConfig } from "../src/relayer.js";
import { Guards } from "../src/guards.js";
import { activateImplicitAccount, DEFAULT_ACTIVATION_YOCTO, type ActivationPorts } from "../src/activation.js";
import { GuardStoreCore, type SqlDriver } from "../src/guardStoreCore.js";

const ESCROW = "bets.praetorial.near";
const INTENTS = "intents.near";
const USDC = "usdc.fakes.testnet";
const USER = "a".repeat(64);
const cfg: RelayerConfig = {
  escrowContract: ESCROW, intentsContract: INTENTS, usdcTokenId: USDC, stakeAssetIds: [`nep141:${USDC}`],
  maxTransferAmount: 1_000_000_000n, maxBlockHeightFuture: 1200n,
  perCallSponsorshipYocto: 5_000_000_000_000_000_000_000n,
  maxRequestsPerWindow: 20, windowMs: 60_000,
  dailyBudgetYocto: 100_000_000_000_000_000_000_000n,
} as any;

const kp = KeyPair.fromRandom("ed25519");
function signed(receiverId: string, methodName: string, args: object, deposit: bigint, nonce: bigint): string {
  const da = buildDelegateAction({ senderId: USER, receiverId, actions: [actionCreators.functionCall(methodName, args, 30_000_000_000_000n, deposit)], nonce, maxBlockHeight: 5000n, publicKey: kp.getPublicKey() as any });
  const sig = kp.sign(createHash("sha256").update(Buffer.from(encodeDelegateAction(da))).digest());
  return Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, { delegateAction: da, signature: new Signature({ keyType: 0, data: sig.signature }) })).toString("base64");
}

const GAS = 300_000_000_000_000_000_000n;
function relayWorld() {
  let depositsPaidByRelayer = 0n;
  let broadcasts = 0;
  const chain: ChainPort = {
    async currentBlockHeight() { return 4000n; },
    async broadcastSignedDelegate(d: any) { broadcasts++; depositsPaidByRelayer += BigInt(d.actions[0].functionCall.deposit); return { transactionHash: "h", actualCostYocto: GAS, raw: {} }; },
  };
  const guards = new Guards(cfg, ":memory:");
  return { r: new Relayer(chain, cfg, guards), guards, paid: () => depositsPaidByRelayer, broadcasts: () => broadcasts };
}

test("MON-1: a relayed storage_deposit is refused before anything is broadcast (any deposit, registered or not)", async () => {
  const w = relayWorld();
  for (const dep of [1n, 1_250_000_000_000_000_000_000n, 10_000_000_000_000_000_000_000n]) {
    await assert.rejects(w.r.relay(signed(USDC, "storage_deposit", { account_id: USER, registration_only: true }, dep, dep)), (e: any) => e instanceof PolicyViolation && /storage_deposit is never relayed/.test(e.message));
  }
  assert.equal(w.broadcasts(), 0);
  assert.equal(w.paid(), 0n);
  assert.equal(w.guards.spentYoctoToday(USER), 0n);
});

test("MON-1: the 20-call drain from the SM1 scratch test moves nothing out of the relayer", async () => {
  const w = relayWorld();
  const DEP = 10_000_000_000_000_000_000_000n;
  for (let n = 1n; n <= 20n; n++) await assert.rejects(w.r.relay(signed(USDC, "storage_deposit", { account_id: USER, registration_only: true }, DEP, n)), PolicyViolation);
  assert.equal(w.paid(), 0n);
});

test("MON-1: any deposit the relayer does carry (the 1-yocto ft_withdraw security deposit) is charged to the budget on top of gas", async () => {
  const w = relayWorld();
  await w.r.relay(signed(INTENTS, "ft_withdraw", { token: USDC, receiver_id: USER, amount: "5" }, 1n, 1n));
  assert.equal(w.paid(), 1n);
  assert.equal(w.guards.spentYoctoToday(USER), GAS + 1n);
  // global cap sees it too
  assert.equal(w.r.globalBudgetStatus().usedYocto, GAS + 1n);
});

// ---- MON-9: /activate ----
const ID = "12c24877c6fa5fb58eea8400bde5f9d7b0f74787536c34f619ba840b081b21ab";
const AUSDC = "nep141:usdc.testnet", AWNEAR = "nep141:wrap.testnet";
const acfg = { escrowContract: "escrow.testnet", intentsContract: "intents.testnet", usdcTokenId: AUSDC, stakeAssetIds: [AUSDC, AWNEAR],
  perCallSponsorshipYocto: 5_000_000_000_000_000_000_000n, maxRequestsPerWindow: 20, windowMs: 60_000, dailyBudgetYocto: 100_000_000_000_000_000_000_000n };
const MIN: Record<string, bigint> = { [AUSDC]: 5_000_000n, [AWNEAR]: 2_000_000_000_000_000_000_000_000n };

function sqlDriver(): SqlDriver {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (q: string) => db.exec(q),
    run: (q: string, ...b: any[]) => ({ lastInsertRowid: Number(db.prepare(q).run(...b).lastInsertRowid) }),
    get: (q: string, ...b: any[]) => db.prepare(q).get(...b) as any,
    transaction: <T>(fn: () => T): T => { db.exec("BEGIN IMMEDIATE;"); try { const r = fn(); db.exec("COMMIT;"); return r; } catch (e) { db.exec("ROLLBACK;"); throw e; } },
  };
}
function activationWorld(balances: Record<string, bigint>, o: { slowTransfer?: boolean; transferFails?: "not-executed" } = {}) {
  const sent: string[] = [];
  const ports: ActivationPorts = {
    accountExists: async () => false, // stays "not found" until the transfer lands: the window two concurrent calls race in
    intentsBalance: async (_id, t) => balances[t] ?? 0n,
    minStake: async (t) => MIN[t] ?? null,
    transfer: async (to) => {
      if (o.slowTransfer) await new Promise((r) => setTimeout(r, 20));
      if (o.transferFails === "not-executed") throw new Error("rpc network error");
      sent.push(to); return { transactionHash: "ACTTX", actualCostYocto: 1n, raw: {} };
    },
  };
  return { sent, ports, guards: new GuardStoreCore(sqlDriver(), acfg as any) };
}
const activate = (w: ReturnType<typeof activationWorld>) => activateImplicitAccount({ accountId: ID, cfg: acfg, activationYocto: DEFAULT_ACTIVATION_YOCTO, ports: w.ports, guards: w.guards });

test("MON-9: 1 base unit (below every asset's min stake) no longer buys an activation", async () => {
  const w = activationWorld({ [AUSDC]: 1n, [AWNEAR]: 1n });
  await assert.rejects(activate(w), (e: any) => e instanceof PolicyViolation && /minimum stake/.test(e.message));
  assert.deepEqual(w.sent, []);
});

test("MON-9: a balance >= the asset's min stake qualifies; an asset with no readable limit never does", async () => {
  assert.equal((await activate(activationWorld({ [AUSDC]: 5_000_000n }))).activated, true);
  const w = activationWorld({ "nep141:unknown.testnet": 10n ** 30n });
  await assert.rejects(activate(w), PolicyViolation);
});

test("MON-9: two concurrent /activate for one id send ONE transfer; the other is told it is in progress", async () => {
  const w = activationWorld({ [AUSDC]: 20_000_000n }, { slowTransfer: true });
  const [a, b] = await Promise.all([activate(w), activate(w)]);
  assert.equal(w.sent.length, 1);
  assert.deepEqual([a.activated, b.activated].sort(), [false, true]);
  assert.equal((a.activated ? b : a).inProgress, true);
  // and a third call right after (account view may still lag) does not send again
  const c = await activate(w);
  assert.equal(c.activated, false);
  assert.equal(w.sent.length, 1);
});

test("MON-9: a transfer that never reached the chain frees the id so the user can retry", async () => {
  const w = activationWorld({ [AUSDC]: 20_000_000n }, { transferFails: "not-executed" });
  await assert.rejects(activate(w), /network error/);
  const w2 = { ...w, ports: { ...w.ports, transfer: async (to: string) => { w.sent.push(to); return { transactionHash: "T2", actualCostYocto: 1n, raw: {} }; } } };
  assert.equal((await activate(w2 as any)).activated, true);
  assert.equal(w.sent.length, 1);
});

// ---- MON-2 (server side), promoted from spikes/sm1/tests/mon_relayer.test.ts "MON-2" ----
import { OutcomeUnknown } from "../src/relayerErrors.js";

test("MON-2: send_tx timeout after the tx landed -> 'unknown' + hash (not an error); a resend of that delegate is answered from the chain, not run again", async () => {
  const executed: bigint[] = [];
  let first = true;
  const landed = new Map<string, any>();
  const chain: ChainPort = {
    async currentBlockHeight() { return 4000n; },
    async broadcastSignedDelegate(d: any, _s, hooks) {
      const hash = `H${d.nonce}`;
      hooks?.onSigned?.(hash);
      executed.push(BigInt(d.nonce)); // the tx reaches the chain and executes...
      landed.set(hash, { status: { SuccessValue: "" }, transaction: { hash }, transaction_outcome: { outcome: { tokens_burnt: "5" } }, receipts_outcome: [] });
      if (first) { first = false; throw new OutcomeUnknown(hash, new Error("TIMEOUT_ERROR")); } // ...but the RPC answer is a timeout
      return { transactionHash: hash, actualCostYocto: 5n, raw: landed.get(hash) };
    },
    async txStatus(h) { return landed.get(h) ?? null; },
  };
  const guards = new Guards(cfg, ":memory:");
  const r = new Relayer(chain, cfg, guards);
  const wd = { token: USDC, receiver_id: USER, amount: "5000000" };
  const a = await r.relay(signed(INTENTS, "ft_withdraw", wd, 1n, 1n));
  assert.deepEqual(a, { txHash: "H1", status: "unknown" });
  // the hold stays booked until resolved (not released as "nothing happened")
  assert.equal(r.globalBudgetStatus().usedYocto, cfg.perCallSponsorshipYocto + 1n);
  const again = await r.relay(signed(INTENTS, "ft_withdraw", wd, 1n, 1n));
  assert.deepEqual(again, { txHash: "H1" });
  assert.deepEqual(executed, [1n], "the same user intent ran once");
  assert.equal(guards.spentYoctoToday(USER), 5n + 1n); // settled to the real cost + the 1-yocto deposit
});

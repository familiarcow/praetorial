// SEC1 / SM1 MON-2 + MON-5 (client): an "outcome unknown" send is never reported as failed, it is stored (localStorage,
// keyed by the action) before it is relayed, and a retry or reload resolves it before anything new is signed.
// Promoted from spikes/sm1/tests/mon_web.test.ts "MON-2 (client side)".
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithdraw, type WithdrawDeps } from "../lib/withdraw";
import { actionKey, guardedRelay, loadInflight, checkInflight, CHECKING_MESSAGE, CONSUMED_MESSAGE, type KV, type GuardedRelayDeps, type StatusAnswer } from "../lib/inflightSend";
import type { RelayResult } from "../lib/relayerClient";

const ACC = "a".repeat(64);
function memKV(): KV & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

/** A small chain + relayer: a relayed withdraw executes; the relayer may answer "unknown" instead of the result. */
function world(o: { unknown?: boolean } = {}) {
  const st = { betting: 10_000_000n, wallet: 0n, chainNonce: 0n, height: 1000n, signs: 0, sends: 0, executedHash: null as string | null, statusUp: true };
  const store = memKV();
  const statusByHash = new Map<string, StatusAnswer>();
  const deps = (p: { args: Record<string, unknown>; receiverId: string; methodName: string }, extra: Partial<GuardedRelayDeps> = {}): GuardedRelayDeps => ({
    store,
    async status(by) {
      if (!st.statusUp) return null;
      if ("txHash" in by) return statusByHash.get(by.txHash) ?? { state: "not_found" };
      return { state: "not_found" };
    },
    async chainNonce() { return st.chainNonce; },
    async height() { return st.height; },
    async signNew() { st.signs++; return { signedDelegateB64: `sd${st.signs}`, nonce: st.chainNonce + 1n, maxBlockHeight: st.height + 200n }; },
    async relay(): Promise<RelayResult> {
      st.sends++;
      const amt = BigInt(String(p.args.amount));
      st.betting -= amt; st.wallet += amt; st.chainNonce++; // it executes on chain...
      const hash = `h${st.sends}`;
      statusByHash.set(hash, { state: "pending", txHash: hash }); // ...the relayer has not resolved it yet
      st.executedHash = hash;
      return o.unknown ? { ok: false, status: "unknown", txHash: hash, error: "sent to NEAR, but the result is not known yet" } : { ok: true, txHash: hash };
    },
    async sleep() {},
    pollAttempts: 2,
    ...extra,
  });
  const withdrawDeps = (): WithdrawDeps => ({
    relay: (step) => guardedRelay(actionKey({ senderId: ACC, ...step }), { senderId: ACC, publicKeyHex: ACC }, deps(step)),
    direct: async () => { throw new Error("no direct tx expected"); },
    inflight: (step) => checkInflight(actionKey({ senderId: ACC, ...step }), deps(step)),
    view: async (_c, m) => (m === "mt_balance_of" ? st.betting.toString() : m === "storage_balance_of" ? { total: "1" } : st.wallet.toString()),
    txFailure: async () => null,
    sleep: async () => {},
  });
  return { st, store, statusByHash, deps, withdrawDeps };
}

test("MON-2: relayer 'unknown' after the withdraw landed -> NOT failed (pending, 'checking'); the retry resolves it and signs nothing new", async () => {
  const w = world({ unknown: true });
  const a = await runWithdraw({ symbol: "USDC", amountUnits: "4000000" }, ACC, w.withdrawDeps(), "testnet");
  assert.equal(a.ok, false);
  assert.equal((a as any).pending, true, "an unknown outcome is pending, never failed");
  assert.equal((a as any).detail, CHECKING_MESSAGE);
  // the relayer resolves it a bit later
  w.statusByHash.set(w.st.executedHash!, { state: "executed", txHash: w.st.executedHash! });
  const b = await runWithdraw({ symbol: "USDC", amountUnits: "4000000" }, ACC, w.withdrawDeps(), "testnet");
  assert.deepEqual(b, { ok: true, txHashes: ["h1"], receivedUnits: "4000000", resumed: true });
  assert.equal(w.st.sends, 1, "the user asked for 4 USDC once and it was sent once");
  assert.equal(w.st.signs, 1);
  assert.equal(w.st.wallet, 4_000_000n);
  assert.equal(w.store.m.size, 0, "resolved -> the in-flight record is gone");
});

test("MON-2: while it is still unknown, every retry says 'checking' and signs nothing", async () => {
  const w = world({ unknown: true });
  await runWithdraw({ symbol: "USDC", amountUnits: "4000000" }, ACC, w.withdrawDeps(), "testnet");
  for (let i = 0; i < 3; i++) {
    const r = await runWithdraw({ symbol: "USDC", amountUnits: "4000000" }, ACC, w.withdrawDeps(), "testnet");
    assert.equal((r as any).pending, true);
  }
  assert.equal(w.st.sends, 1);
});

test("MON-5: the send is stored BEFORE the relay request, so a reload mid-request still knows about it", async () => {
  const w = world();
  const step = { receiverId: "intents.near", methodName: "ft_withdraw", args: { token: "usdc.testnet", receiver_id: ACC, amount: "5" } };
  const key = actionKey({ senderId: ACC, ...step, depositYocto: "1" });
  let seen: unknown = null;
  await guardedRelay(key, { senderId: ACC, publicKeyHex: ACC }, w.deps(step, {
    relay: async () => { seen = loadInflight(w.store, key); throw new Error("tab closed"); },
  }));
  assert.ok(seen && (seen as any).nonce === "1" && (seen as any).maxBlockHeight === "1200");
  assert.ok(loadInflight(w.store, key), "a network error keeps the record (it may have reached the relayer)");
});

test("an earlier send that never executed (past maxBlockHeight, nonce unused) is cleared and the action is signed again", async () => {
  const w = world();
  const step = { receiverId: "intents.near", methodName: "ft_withdraw", args: { token: "usdc.testnet", receiver_id: ACC, amount: "5" } };
  const key = actionKey({ senderId: ACC, ...step });
  w.store.setItem(key, JSON.stringify({ senderId: ACC, publicKeyHex: ACC, nonce: "1", maxBlockHeight: "900", at: 0 }));
  const r = await guardedRelay(key, { senderId: ACC, publicKeyHex: ACC }, w.deps(step));
  assert.equal(r.ok, true);
  assert.equal(w.st.signs, 1);
  assert.equal(w.store.m.size, 0);
});

test("nonce already used but no outcome available -> 'already reached NEAR, check your balance', no new signature", async () => {
  const w = world();
  w.st.chainNonce = 1n; w.st.statusUp = false;
  const step = { receiverId: "intents.near", methodName: "ft_withdraw", args: { token: "usdc.testnet", receiver_id: ACC, amount: "5" } };
  const key = actionKey({ senderId: ACC, ...step });
  w.store.setItem(key, JSON.stringify({ senderId: ACC, publicKeyHex: ACC, nonce: "1", maxBlockHeight: "1200", at: 0 }));
  const r = await guardedRelay(key, { senderId: ACC, publicKeyHex: ACC }, w.deps(step));
  assert.equal(r.ok, false);
  assert.equal(r.error, CONSUMED_MESSAGE);
  assert.equal(w.st.signs, 0);
});

test("a definite answer (done / refused) clears the record; a different action is not blocked", async () => {
  const w = world();
  const s1 = { receiverId: "intents.near", methodName: "ft_withdraw", args: { token: "usdc.testnet", receiver_id: ACC, amount: "5" } };
  assert.equal((await guardedRelay(actionKey({ senderId: ACC, ...s1 }), { senderId: ACC, publicKeyHex: ACC }, w.deps(s1))).ok, true);
  assert.equal(w.store.m.size, 0);
  const refused = await guardedRelay("k2", { senderId: ACC, publicKeyHex: ACC }, w.deps(s1, { relay: async () => ({ ok: false, error: "policy says no" }) }));
  assert.equal(refused.error, "policy says no");
  assert.equal(w.store.m.size, 0);
  assert.notEqual(actionKey({ senderId: ACC, ...s1 }), actionKey({ senderId: ACC, ...s1, args: { ...s1.args, amount: "6" } }));
  assert.equal(actionKey({ senderId: ACC, ...s1, args: { amount: "5", receiver_id: ACC, token: "usdc.testnet" } }), actionKey({ senderId: ACC, ...s1 }), "key ignores arg order");
});

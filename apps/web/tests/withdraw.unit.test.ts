// LIVE2 / WITHDRAW1: Escrow (betting) balance -> wallet. Real intents.near ft_withdraw shape; success judged on chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWithdrawStep, runWithdraw, withdrawTokenContract, MAX_STORAGE_DEPOSIT_YOCTO, type WithdrawDeps, type WithdrawStep } from "../lib/withdraw";
import { INTENTS_CONTRACT_ID } from "../lib/config";

const ME = "a".repeat(64);
const AMT = "100000000000000000000000";

test("buildWithdrawStep: exactly intents ft_withdraw {token (bare NEP-141), receiver_id = me, amount}, 1 yocto", () => {
  const s = buildWithdrawStep({ symbol: "NEAR", account: ME, amountUnits: AMT, network: "testnet" });
  assert.deepEqual(s, { receiverId: INTENTS_CONTRACT_ID, methodName: "ft_withdraw", args: { token: "wrap.testnet", receiver_id: ME, amount: AMT }, depositYocto: "1", gasTgas: 100 });
  assert.equal(buildWithdrawStep({ symbol: "USDC", account: ME, amountUnits: "5", network: "testnet" }).args.token, "usdc.testnet");
  assert.equal(withdrawTokenContract("USDC", "mainnet"), "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  assert.equal(withdrawTokenContract("NEAR", "mainnet"), "wrap.near");
  assert.throws(() => buildWithdrawStep({ symbol: "NEAR", account: ME, amountUnits: "0", network: "testnet" }));
  assert.throws(() => buildWithdrawStep({ symbol: "NEAR", account: ME, amountUnits: "1.5", network: "testnet" }));
});

function chain(o: { intents?: bigint; registered?: boolean; wallet?: bigint; arrives?: boolean; relayErr?: string; directErr?: string; txFail?: string; storageMin?: string }) {
  const st = { intents: o.intents ?? 10n ** 24n, registered: o.registered ?? true, wallet: o.wallet ?? 7n };
  const sent: WithdrawStep[] = [];
  const via: string[] = [];
  const deps: WithdrawDeps = {
    async direct(step) {
      sent.push(step); via.push(`direct:${step.methodName}`);
      if (o.directErr) return { ok: false, error: o.directErr };
      if (step.methodName === "storage_deposit") st.registered = true;
      return { ok: true, txHash: `tx${sent.length}` };
    },
    async relay(step) {
      sent.push(step); via.push(`relay:${step.methodName}`);
      if (o.relayErr) return { ok: false, error: o.relayErr };
      if (step.methodName === "storage_deposit") st.registered = true;
      if (step.methodName === "ft_withdraw" && (o.arrives ?? true) && st.registered) { st.intents -= BigInt(String(step.args.amount)); st.wallet += BigInt(String(step.args.amount)); }
      return { ok: true, txHash: `tx${sent.length}` };
    },
    async view(c, m, a) {
      if (m === "mt_balance_of") { assert.equal(c, INTENTS_CONTRACT_ID); assert.equal(a.token_id, "nep141:wrap.testnet"); return String(st.intents); }
      if (m === "storage_balance_of") return st.registered ? { total: "1250000000000000000000", available: "0" } : null;
      if (m === "storage_balance_bounds") return { min: o.storageMin ?? "1250000000000000000000", max: "1250000000000000000000" };
      if (m === "ft_balance_of") { assert.equal(c, "wrap.testnet"); assert.equal(a.account_id, ME); return String(st.wallet); }
      throw new Error(`unexpected view ${m}`);
    },
    async txFailure() { return o.txFail ?? null; },
    async sleep() {},
  };
  return { deps, sent, st, via };
}

test("runWithdraw: registered wallet -> one ft_withdraw; ok only when the wallet balance rose by exactly the amount", async () => {
  const { deps, sent, st } = chain({});
  const r = await runWithdraw({ symbol: "NEAR", amountUnits: AMT }, ME, deps, "testnet");
  assert.deepEqual(r, { ok: true, txHashes: ["tx1"], receivedUnits: AMT });
  assert.deepEqual(sent.map((s) => s.methodName), ["ft_withdraw"]);
  assert.equal(st.wallet, 7n + BigInt(AMT));
});

test("runWithdraw: unregistered wallet -> storage_deposit {account_id: me, registration_only} with the token's min, then ft_withdraw", async () => {
  const { deps, sent } = chain({ registered: false });
  const r = await runWithdraw({ symbol: "NEAR", amountUnits: AMT }, ME, deps, "testnet");
  assert.equal(r.ok, true);
  assert.deepEqual(sent[0], { receiverId: "wrap.testnet", methodName: "storage_deposit", args: { account_id: ME, registration_only: true }, depositYocto: "1250000000000000000000", gasTgas: 30 });
  assert.equal(sent[1].methodName, "ft_withdraw");
});

test("SEC1/MON-1: the registration is a user-signed tx (the relayer would pay its deposit and NEP-145 refunds it to the user); ft_withdraw stays relayed", async () => {
  const { deps, via } = chain({ registered: false });
  assert.equal((await runWithdraw({ symbol: "NEAR", amountUnits: AMT }, ME, deps, "testnet")).ok, true);
  assert.deepEqual(via, ["direct:storage_deposit", "relay:ft_withdraw"]);
  const b = chain({ registered: false, directErr: "NotEnoughBalance" });
  const r = await runWithdraw({ symbol: "NEAR", amountUnits: AMT }, ME, b.deps, "testnet");
  assert.equal(r.ok, false);
  assert.match((r as any).detail, /one-time 0.00125 NEAR from your NEAR account.*NotEnoughBalance/);
  assert.deepEqual(b.via, ["direct:storage_deposit"]);
});

test("runWithdraw: refuses an absurd storage deposit, and more than the betting balance, before sending anything", async () => {
  const a = chain({ registered: false, storageMin: (MAX_STORAGE_DEPOSIT_YOCTO + 1n).toString() });
  assert.equal((await runWithdraw({ symbol: "NEAR", amountUnits: AMT }, ME, a.deps, "testnet")).ok, false);
  assert.equal(a.sent.length, 0);
  const b = chain({ intents: 5n });
  const r = await runWithdraw({ symbol: "NEAR", amountUnits: "6" }, ME, b.deps, "testnet");
  assert.equal(r.ok, false); assert.equal(b.sent.length, 0);
});

test("runWithdraw: the relayer's reason is reported verbatim; a failed receipt is a failure", async () => {
  const a = chain({ relayErr: 'ft_withdraw receiver_id must be the signer' });
  const ra = await runWithdraw({ symbol: "NEAR", amountUnits: AMT }, ME, a.deps, "testnet");
  assert.equal(ra.ok, false); assert.match((ra as any).detail, /receiver_id must be the signer/);
  const b = chain({ txFail: "Smart contract panicked: not registered" });
  const rb = await runWithdraw({ symbol: "NEAR", amountUnits: AMT }, ME, b.deps, "testnet");
  assert.equal(rb.ok, false); assert.match((rb as any).detail, /not registered/); assert.deepEqual(rb.txHashes, ["tx1"]);
});

test("runWithdraw: a clean tx whose tokens never arrive (intents refunded it) is NOT reported as success", async () => {
  const { deps } = chain({ arrives: false });
  const r = await runWithdraw({ symbol: "NEAR", amountUnits: AMT }, ME, deps, "testnet");
  assert.equal(r.ok, false); assert.match((r as any).detail, /did not arrive/);
});

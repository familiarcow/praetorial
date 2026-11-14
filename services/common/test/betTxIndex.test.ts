// V1 (familiarcow 2026-11-11 "We should be able to verify the results of every action"): every bet action -> its on-chain tx.
// Fixture: REAL testnet receipts of escrow praetorial-frz3-2611100414 for bets 32 (cancel), 38 (referee), 44 (concede),
// 46 (expire), 49 (AI ruling + challenge + finalize), from tx.test.fastnear.com (read-only), trimmed to escrow/OutLayer receipts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexBetTxs, betTxsFor, type BetTx } from "../src/betTxIndex.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/betTxs.testnet.json", import.meta.url), "utf8")) as { escrow: string; hist: { hash: string; signer: string; rc: any }[] };
const all = indexBetTxs(fx.escrow, fx.hist);
const of = (bet: number) => all.filter((t) => t.bet_id === bet);
const one = (bet: number, hash: string): BetTx => { const t = of(bet).find((x) => x.hash === hash); assert.ok(t, `bet ${bet} tx ${hash} indexed`); return t!; };
const USDC = "nep141:usdc.testnet";

test("every bet in the fixture has exactly one create, made by its maker, with the stake moved in", () => {
  for (const id of [32, 38, 44, 46, 49]) {
    const c = of(id).filter((t) => t.kind === "create");
    assert.equal(c.length, 1, `bet ${id}`);
    assert.equal(c[0].ok, true);
    assert.equal(c[0].method, "mt_on_transfer");
    assert.equal(c[0].moved_in.length, 1);
    assert.equal(c[0].moved_in[0].account, c[0].actor);
    assert.ok(BigInt(c[0].moved_in[0].amount) > 0n);
  }
});

test("bet 49: challenge bond, signed AI ruling, request result (OutLayer program named) and the finalize payouts", () => {
  const bond = one(49, "4N3EanAwrJ4yStku1fwovW1UeVC5aTfyHnuHyGVHjwKW");
  assert.equal(bond.kind, "challenge");
  assert.equal(bond.round, 1);
  assert.equal(bond.signer, "relayer.praetorial-dev-1101.testnet");
  assert.equal(bond.actor, "371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488");
  assert.deepEqual(bond.moved_in, [{ account: bond.actor, token: USDC, amount: "5005000" }]);

  const ruling = one(49, "AXvXrG32NxybxRhrxCWBBVCipWG99PhvDsN8t5WqvJ7m");
  assert.equal(ruling.kind, "ruling");
  assert.equal(ruling.method, "submit_outcome");
  assert.equal(ruling.signer, "keeper.praetorial-dev-1101.testnet");
  assert.equal(ruling.outcome, "YES");
  assert.equal(ruling.run_no, 10);
  assert.ok(ruling.signed);
  assert.match(ruling.signed!.signature_hex, /^922ee56f/);
  assert.equal(JSON.parse(ruling.signed!.result_json).checked_until, "0"); // exact digits kept as sent

  const req = one(49, "9SbiLsizpBHSGnnragbY5Z8porbzpnZtWggaYfKPLG6j");
  assert.equal(req.kind, "request-result");
  assert.equal(req.actor, "371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488");
  assert.deepEqual(req.moved_in, [{ account: req.actor, token: "near", amount: "20062500000000000000000" }]);
  assert.ok(req.program, "the OutLayer execution_requested event names the program");
  assert.match(req.program!.wasm_hash, /^[0-9a-f]{64}$/);
  assert.ok(req.program!.url.endsWith(`${req.program!.wasm_hash}.wasm`));

  const fin = one(49, "3hJouvbQA5vQQGxX1FazaNUgRmxS3CbyGpv63CXJynaK");
  assert.equal(fin.kind, "finalize");
  for (const m of [
    { account: "979f2614c265b2dfacbde2628b66979c26afac83ba2f98f826a010aaab8eba7d", token: USDC, amount: "44000000" },
    { account: "keeper.praetorial-dev-1101.testnet", token: USDC, amount: "5000" },
    { account: "fee.praetorial-dev-1101.testnet", token: USDC, amount: "1125566" },
  ]) assert.ok(fin.moved_out.some((x) => x.account === m.account && x.token === m.token && x.amount === m.amount), JSON.stringify(m));
});

test("concede, referee rule, cancel (refund out) and expire are indexed with who acted", () => {
  const c = one(44, "B3UgG4aa6WaBTpTPBX4GmvEYVUrRojzaPXtjCgHxwytt");
  assert.equal(c.kind, "concede"); assert.equal(c.actor, "maker1.praetorial-dev-1101.testnet");
  const r = one(38, "3BH5nqcibwvfpTjMHi8L81AiGohvGnRPzFZCmMVqVq4b");
  assert.equal(r.kind, "referee-rule"); assert.equal(r.outcome, "YES");
  assert.equal(r.actor, "bd647fa44695487cedebee20d528d41d76739a6e0d718cfe432cb41b898851a4");
  assert.equal(r.signer, "relayer.praetorial-dev-1101.testnet");
  const x = one(32, "5suHGRdXiZ79CshaS68mDr5kwc2EKUUkVdu8yBJYcw4");
  assert.equal(x.kind, "cancel"); assert.equal(x.actor, "8941e607b64ff1b0d62ff6e061ce073df75a53a1205852708f965779240981c7");
  // the refund is queued by cancel and paid by a later drain_payouts tx (escrow payout queue)
  const back = of(32).filter((t) => t.kind === "payout" && t.moved_out.some((m) => m.account === x.actor));
  assert.equal(back.length, 1, "the stake went back to the maker");
  assert.equal(back[0].moved_out.find((m) => m.account === x.actor)!.amount, of(32).find((t) => t.kind === "create")!.moved_in[0].amount);
  const e = one(46, "F7LBrAtkAviCVkucMZCQqoetf9GcC5TZDzo4DsNuogdg");
  assert.equal(e.kind, "expire");
});

test("txs are in block order, carry a block time, and nothing is attributed to a bet it doesn't touch", () => {
  for (const id of [32, 38, 44, 46, 49]) {
    const xs = of(id);
    for (let i = 1; i < xs.length; i++) assert.ok(BigInt(xs[i - 1].at_ns) <= BigInt(xs[i].at_ns));
    for (const t of xs) assert.match(t.at_ns, /^\d{19}$/);
  }
  assert.equal(of(54).length, 0);
  assert.deepEqual(betTxsFor(all, 44).map((t) => t.hash), of(44).map((t) => t.hash));
});

test("a receipt the escrow refused is kept as failed, and a fully refunded transfer moves nothing in", () => {
  const rc = (method: string, args: unknown, status: unknown, logs: string[] = []) => ({
    hash: "H", signer: "relayer.x", rc: { receipt: { receipt_id: `${method}-${JSON.stringify(status)}`, predecessor_id: "intents.x", receiver_id: "esc.x", receipt: { Action: { signer_id: "relayer.x", actions: [{ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: "0" } }] } } }, execution_outcome: { block_timestamp: "1794423865849395398", outcome: { status, logs } } },
  });
  const take = { sender_id: "bob.x", token_ids: [USDC], amounts: ["100"], msg: JSON.stringify({ kind: "Take", bet_id: 7 }) };
  const refunded = indexBetTxs("esc.x", [rc("mt_on_transfer", take, { SuccessValue: Buffer.from('["100"]').toString("base64") }, ["take_rejected bet_id=7"])]);
  assert.equal(refunded.length, 1);
  assert.equal(refunded[0].kind, "take");
  assert.equal(refunded[0].ok, false, "fully refunded = the escrow did not accept it");
  assert.deepEqual(refunded[0].moved_in, []);
  const failed = indexBetTxs("esc.x", [rc("concede", { bet_id: 7 }, { Failure: { ActionError: {} } })]);
  assert.equal(failed[0].ok, false);
});

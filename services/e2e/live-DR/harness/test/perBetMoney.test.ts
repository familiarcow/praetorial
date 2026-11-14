// DR1b (D-PM3): per-bet money check. Credits are computed from the escrow's OWN finalize/payout receipts for THIS bet_id
// (intents mt_transfer calls), so they stay exact when maker/fee/escrow accounts are shared with other bets over a long wait.
// Fixture: DR1 bet 18 keeper finalize tx EkMbnyrD... (public testnet RPC, saved once, offline here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { creditsFromReceipts, checkPerBetMoney, checkObserved, expectedSettlement, assertEscrowDrained, loadFeeConfig, freshBettorAccounts, assertFreshBefore, type Params } from "../money.js";

const here = dirname(fileURLToPath(import.meta.url));
const tx = JSON.parse(readFileSync(join(here, "..", "fixtures", "dr1_bet18_finalize_tx_status.json"), "utf8")).result;
const taken = JSON.parse(readFileSync(join(here, "..", "..", "DR1", "run", "bet_taken.json"), "utf8"));
const saved = JSON.parse(readFileSync(join(here, "..", "fixtures", "dr1_bet18_shared_account_money_check.json"), "utf8"));
const ESCROW = "praetorial-frz2-2611091914.praetorial-dev-1101.testnet", INTENTS = "intents-mock.praetorial-dev-1101.testnet", TOKEN = "nep141:wrap.testnet";
const ctx = { escrow: ESCROW, intents: INTENTS, betId: 18, token: TOKEN };
const acc = { maker: taken.envelope.maker as string, taker: taken.taker as string, fee: "fee.praetorial-dev-1101.testnet" };
const TAKER = 5728260869565217391304348n, FEE = 306039130434782608695652n;

const params = (): Params => ({
  stakeMaker: BigInt(taken.envelope.stake_maker), stakeTaker: BigInt(taken.envelope.stake_taker), feeBps: loadFeeConfig().feeBps,
  minFeeMaker: BigInt(taken.fee_min_maker), minFeeTaker: BigInt(taken.fee_min_taker),
  storageMaker: BigInt(taken.storage_maker), storageTaker: BigInt(taken.storage_taker),
  keepTerms: taken.envelope.keep_terms === true, makerSide: taken.envelope.maker_side, referee: false, tipMaker: false, tipTaker: false,
});
const settlement = () => { const s = expectedSettlement("NO", params()); assertEscrowDrained(s); return s; }; // maker YES, outcome NO: taker wins
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const okInput = () => ({ accounts: acc, credits: creditsFromReceipts(tx, ctx).credits, bettorDeltas: { maker: 0n, taker: TAKER }, fresh: { maker: true, taker: true }, isFullyPaid: true });

test("bet 18 finalize receipts credit exactly taker 5728260869565217391304348, fee 306039130434782608695652, maker nothing", () => {
  const { credits, payoutBetIds } = creditsFromReceipts(tx, ctx);
  assert.equal(credits[acc.taker], TAKER);
  assert.equal(credits[acc.fee], FEE);
  assert.equal(credits[acc.maker] ?? 0n, 0n);
  assert.deepEqual(Object.keys(credits).sort(), [acc.fee, acc.taker].sort());
  assert.deepEqual([...new Set(payoutBetIds)], [18]);
});

test("receipt credits == expected settlement to the yocto; no mismatch for bet 18 with fresh bettor accounts", () => {
  const s = settlement();
  assert.deepEqual(checkPerBetMoney(s, okInput()), []);
});

test("the shared-account balance deltas DR1 recorded are NOT a valid assertion: flagged as not-fresh, never silently accepted", () => {
  const bad = checkObserved(settlement(), { maker: BigInt(saved.deltas.maker), taker: BigInt(saved.deltas.taker), fee: BigInt(saved.deltas.fee) }, { escrowAfter: BigInt(saved.escrow_vs_before) });
  assert.equal(bad.length, 3, "documents the DR1 failure: the old check goes red on shared accounts");
  const inp = okInput();
  const m = checkPerBetMoney(settlement(), { ...inp, bettorDeltas: { maker: BigInt(saved.deltas.maker), taker: BigInt(saved.deltas.taker) }, fresh: { maker: false, taker: true } });
  assert.ok(m.some((x) => /maker.*not fresh/i.test(x)), m.join(" | "));
});

test("a fresh bettor account whose delta is off by 1 yocto stays a hard failure (assertion not loosened)", () => {
  const inp = okInput();
  assert.ok(checkPerBetMoney(settlement(), { ...inp, bettorDeltas: { maker: 0n, taker: TAKER + 1n } }).some((x) => /taker.*delta/i.test(x)));
  assert.ok(checkPerBetMoney(settlement(), { ...inp, bettorDeltas: { maker: 1n, taker: TAKER } }).some((x) => /maker.*delta/i.test(x)));
});

test("receipts off by 1 yocto, a missing payout, or a credit to a stranger each fail", () => {
  const s = settlement();
  const inp = okInput();
  assert.ok(checkPerBetMoney(s, { ...inp, credits: { ...inp.credits, [acc.fee]: FEE + 1n } }).some((x) => /fee/.test(x)));
  const { [acc.fee]: _drop, ...noFee } = inp.credits;
  assert.ok(checkPerBetMoney(s, { ...inp, credits: noFee }).some((x) => /fee/.test(x)));
  assert.ok(checkPerBetMoney(s, { ...inp, credits: { ...inp.credits, stranger: 1n } }).some((x) => /stranger/.test(x)));
});

test("bet residue is derived per bet: deposits minus receipt credits; not fully paid fails", () => {
  const s = settlement();
  const inp = okInput();
  assert.ok(checkPerBetMoney(s, { ...inp, isFullyPaid: false }).some((x) => /fully.?paid/i.test(x)));
  assert.ok(checkPerBetMoney(s, { ...inp, credits: { ...inp.credits, [acc.taker]: TAKER - 1n } }).some((x) => /residue/i.test(x)));
});

test("receipt parsing refuses a tx whose payout events name another bet, a transfer not sent by the escrow, or a foreign token", () => {
  const other = clone(tx);
  for (const o of other.receipts_outcome) o.outcome.logs = o.outcome.logs.map((l: string) => l.replace('"bet_id":18', '"bet_id":19'));
  assert.throws(() => creditsFromReceipts(other, ctx), /bet_id/);
  const foreign = clone(tx);
  for (const r of foreign.receipts) if (r.receiver_id === INTENTS) r.predecessor_id = "evil.testnet";
  assert.deepEqual(creditsFromReceipts(foreign, ctx).credits, {}, "transfers not sent by the escrow are not counted");
  const tok = clone(tx);
  for (const r of tok.receipts) if (r.receiver_id === INTENTS) { const f = r.receipt.Action.actions[0].FunctionCall; f.args = Buffer.from(Buffer.from(f.args, "base64").toString().replace("nep141:wrap.testnet", "nep141:other")).toString("base64"); }
  assert.throws(() => creditsFromReceipts(tok, ctx), /token/);
});

test("a failed receipt is not a credit", () => {
  const failed = clone(tx);
  const id = failed.receipts.find((r: any) => r.receiver_id === INTENTS).receipt_id;
  failed.receipts_outcome.find((o: any) => o.id === id).outcome.status = { Failure: { ActionError: {} } };
  assert.throws(() => creditsFromReceipts(failed, ctx), /fail/i);
});

test("fresh per-run bettor accounts: distinct implicit accounts each run; a non-zero starting balance is refused", () => {
  const a = freshBettorAccounts(), b = freshBettorAccounts();
  for (const r of ["maker", "taker"] as const) {
    assert.match(a[r].account, /^[0-9a-f]{64}$/);
    assert.notEqual(a[r].account, b[r].account);
  }
  assert.notEqual(a.maker.account, a.taker.account);
  assert.doesNotThrow(() => assertFreshBefore("taker", 0n));
  assert.throws(() => assertFreshBefore("taker", 1n), /not fresh/i);
});

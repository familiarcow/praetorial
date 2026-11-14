// FE13 (S15): payout and refund screens. Every amount is derived from the bet's own contract fields (fee_bps, the bet's own fee floor copies,
// tips, storage) exactly as contracts/escrow/src/lib.rs schedules them; these tests pin that arithmetic and the reason strings to the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { payoutScreen, expectedPayouts, drainPayoutsArgs, DRAIN_METHOD, type PayoutLine } from "../lib/payoutScreen";
import { ruleConfirmSentence } from "../lib/refereeScreen";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
const fnBody = (name: string) => { const a = rs.indexOf(`pub fn ${name}(`); assert.ok(a > 0, name); return rs.slice(a, rs.indexOf("\n    pub fn ", a + 1)); };

const USDC = "nep141:usdc.testnet";
const BTC = "nep141:btc.omft.near";
const RESOLVE = Date.UTC(2037, 0, 5) * 1e6;
const bet = (o: { env?: any; rest?: any } = {}) => ({
  envelope: { maker: "maker.testnet", maker_side: "YES", outcomes: ["YES", "NO"], referee: null, maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", fee_bps: 100, keep_terms: false, funding_deadline: 0, resolve_deadline: RESOLVE, ...(o.env ?? {}) },
  status: "Settled", taker: "taker.testnet", bonds: [], outcome: "YES", proposed_at: 1, challenged_by: null,
  fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: "0", tip_taker: "0", storage_maker: "20000", storage_taker: "20000", ...o.rest,
}) as any;
const REF = { account: "ref.testnet", mode: "Human" };
const sc = (b: any, me: string | null, pending: PayoutLine[] | null = []) => { const s = payoutScreen(b, me, pending); assert.ok(s, "a screen"); return s!; };
const line = (o: Partial<PayoutLine> = {}): PayoutLine => ({ id: 1, bet_id: 7, token_id: USDC, receiver: "maker.testnet", amount: "19000000", reason: "payout_winner", attempts: 0, done: false, in_flight: false, ...o });

test("the contract facts the screens rely on still exist in lib.rs (reason strings, fee math, who pays tips, drain method)", () => {
  assert.equal(DRAIN_METHOD, "drain_payouts");
  assert.ok(rs.includes("pub fn drain_payouts(&mut self, bet_id: u64, limit: u64)"));
  for (const r of ["payout_winner", "fee_and_storage", "referee_tip", "void_refund_maker", "void_refund_taker", "void_deadline_maker", "void_deadline_taker", "void_storage_refund_maker", "void_storage_keep_terms", "cancel_expire_refund", "emergency_refund_maker", "emergency_refund_taker"]) assert.ok(rs.includes(`"${r}"`), r);
  assert.ok(rs.includes("std::cmp::min(stake, std::cmp::max(stake * fee_bps / BPS_DENOM, min_fee_per_side))"), "side_fee");
  // a winning referee ruling / concede carve the tip out of the winner's per-asset payout; the deadline VOID pays the tip too (silent referee still earns it)
  assert.ok(fnBody("referee_rule").includes("stake_maker - fee_maker - tip_maker"));
  assert.ok(fnBody("concede").includes("stake_maker - fee_maker - tip_maker"));
  assert.ok(fnBody("void_after_deadline").includes("self.pay_tips(bet_id)") && fnBody("void_after_deadline").includes("stake_maker - tip_maker"));
  assert.ok(!fnBody("emergency_refund").includes("pay_tips"), "emergency refund pays no tip");
  assert.ok(fnBody("emergency_refund").includes("stake_maker.0 + bet.storage_maker.0"));
  assert.ok(rs.includes("let amount = bet.envelope.stake_maker.0 + bet.storage_maker.0;"), "cancel/expire refund = stake + storage");
});

test("won: pot, fee (with the $0.50 floor), net, storage kept", () => {
  const s = sc(bet(), "maker.testnet");
  assert.equal(s.ending, "won");
  assert.equal(s.headline, "You won 19.00 USDC.");
  assert.deepEqual(s.lines, ["Pot 20.00 USDC − fee 1.00 USDC = 19.00 USDC", "The network storage charge (0.04 USDC) went with the fee."]);
});

test("won on a big stake: the fee is 1%, not the floor", () => {
  const s = sc(bet({ env: { stake_maker: "100000000", stake_taker: "100000000" } }), "maker.testnet");
  assert.equal(s.headline, "You won 198.00 USDC.");
  assert.equal(s.lines[0], "Pot 200.00 USDC − fee 2.00 USDC = 198.00 USDC");
});

test("won with a tip (referee ruled): pot − fee − tip", () => {
  const b = bet({ env: { referee: REF }, rest: { tip_maker: "500000", tip_taker: "500000" } });
  const s = sc(b, "maker.testnet");
  assert.equal(s.headline, "You won 18.00 USDC.");
  assert.equal(s.lines[0], "Pot 20.00 USDC − fee 1.00 USDC − tip 1.00 USDC = 18.00 USDC");
  // consistent with what the referee saw before ruling (FE12 confirm sentence)
  assert.ok(ruleConfirmSentence({ ...b, status: "Taken", outcome: null } as any, "YES").includes("wins 18 USDC"));
});

test("lost: your stake, who was paid, your tip", () => {
  const s = sc(bet(), "taker.testnet");
  assert.equal(s.ending, "lost");
  assert.equal(s.headline, "You lost 10.00 USDC.");
  assert.deepEqual(s.lines, ["maker.testnet was paid."]);
  const t = sc(bet({ env: { referee: REF }, rest: { tip_taker: "500000" } }), "taker.testnet");
  assert.deepEqual(t.lines, ["maker.testnet was paid.", "Your tip of 0.50 USDC to ref.testnet came out of your stake."]);
});

test("VOID by the AI: stake + storage back, no fee; a challenged bet carries the run-cost caveat", () => {
  const s = sc(bet({ rest: { outcome: "VOID" } }), "maker.testnet");
  assert.equal(s.ending, "void-ai");
  assert.equal(s.headline, "This bet was voided. You got your stake back.");
  assert.deepEqual(s.lines, ["No fee was charged.", "Refunded: 10.00 USDC stake + 0.02 USDC storage charge = 10.02 USDC."]);
  const c = sc(bet({ rest: { outcome: "VOID", challenged_by: "taker.testnet" } }), "maker.testnet");
  assert.match(c.lines[c.lines.length - 1], /challenge.*judge's run cost.*other side's refund/);
});

test("VOID by the AI on a keep_terms bet: the storage charge is not refunded (it goes to the fee account)", () => {
  const s = sc(bet({ env: { keep_terms: true }, rest: { outcome: "VOID" } }), "maker.testnet");
  assert.deepEqual(s.lines.slice(0, 2), ["No fee was charged.", "Refunded: 10.00 USDC stake. The 0.02 USDC storage charge was kept because the terms were stored."]);
});

test("VOID by the referee: tip is paid, no platform fee", () => {
  const s = sc(bet({ env: { referee: REF }, rest: { outcome: "VOID", proposed_at: 5, tip_maker: "500000" } }), "maker.testnet");
  assert.equal(s.ending, "void-referee");
  assert.equal(s.headline, "ref.testnet voided this bet.");
  assert.deepEqual(s.lines, ["No platform fee was charged.", "Refunded: 9.50 USDC stake after your 0.50 USDC tip + 0.02 USDC storage charge = 9.52 USDC.", "Your tip of 0.50 USDC was paid to ref.testnet."]);
  const t = sc(bet({ env: { referee: REF }, rest: { outcome: "VOID", proposed_at: 5, tip_maker: "500000" } }), "taker.testnet");
  assert.deepEqual(t.lines, ["No platform fee was charged.", "Refunded: 10.00 USDC stake + 0.02 USDC storage charge = 10.02 USDC."]);
});

test("referee never ruled: deadline refund; the contract still pays an opted-in tip (D-UX21 #1, not the spec's 'no tip')", () => {
  const b = bet({ env: { referee: REF }, rest: { status: "Voided", outcome: "VOID", proposed_at: null, tip_maker: "500000" } });
  const s = sc(b, "maker.testnet");
  assert.equal(s.ending, "deadline");
  assert.equal(s.headline, "ref.testnet didn't rule by 2037-01-05 00:00 UTC. You were both refunded.");
  assert.deepEqual(s.lines, ["Refunded: 9.50 USDC stake after your 0.50 USDC tip + 0.02 USDC storage charge = 9.52 USDC.", "Your tip of 0.50 USDC was paid to ref.testnet."]);
  const ai = sc(bet({ rest: { status: "Voided", outcome: "VOID", proposed_at: null } }), "taker.testnet");
  assert.equal(ai.headline, "Nobody ruled by 2037-01-05 00:00 UTC. You were both refunded.");
});

test("concede: you conceded / they conceded (no proposal on the bet), same fee as a normal ending", () => {
  const c = bet({ rest: { status: "Finalized", outcome: "YES", proposed_at: null } }); // maker wins: the taker conceded
  const mine = sc(c, "taker.testnet");
  assert.equal(mine.ending, "conceded-by-me");
  assert.equal(mine.headline, "You conceded. maker.testnet was paid.");
  assert.equal(mine.lines[0], "Same fee as a normal ending: pot 20.00 USDC − fee 1.00 USDC = 19.00 USDC paid.");
  const theirs = sc(c, "maker.testnet");
  assert.equal(theirs.ending, "conceded-by-other");
  assert.equal(theirs.headline, "taker.testnet conceded. You won 19.00 USDC.");
  assert.equal(sc(bet({ rest: { outcome: "YES", proposed_at: 9 } }), "taker.testnet").ending, "lost"); // a ruled bet is never shown as a concede
});

test("cancelled / expired: refunded in full including storage", () => {
  for (const status of ["Cancelled", "Expired"]) {
    const b = bet({ rest: { status, taker: null, outcome: null, proposed_at: null, storage_taker: "0" } });
    const s = sc(b, "maker.testnet");
    assert.equal(s.ending, status === "Cancelled" ? "cancelled" : "expired");
    assert.equal(s.headline, "Nobody took this bet. You were refunded in full.");
    assert.deepEqual(s.lines, ["Refunded: 10.00 USDC stake + 0.02 USDC storage charge = 10.02 USDC."]);
  }
});

test("emergency refund: your own deposits back, no fee, no tip taken", () => {
  const b = bet({ env: { referee: REF }, rest: { status: "Voided", outcome: null, proposed_at: null, tip_maker: "500000" } });
  const s = sc(b, "maker.testnet");
  assert.equal(s.ending, "emergency");
  assert.equal(s.headline, "The app was shut down. You got your own deposits back.");
  assert.deepEqual(s.lines, ["No fee was charged.", "Refunded: 10.00 USDC stake + 0.02 USDC storage charge = 10.02 USDC."]);
});

test("cross-asset bets show each asset on its own (never summed across assets)", () => {
  const b = bet({ env: { maker_asset: USDC, taker_asset: BTC, stake_maker: "10000000", stake_taker: "20000" }, rest: { fee_min_taker: "50", storage_taker: "10" } });
  const ex = expectedPayouts(b)!;
  const winnerBtc = ex.find((l: { reason: string; asset: string }) => l.reason === "payout_winner" && l.asset === BTC)!;
  assert.equal(winnerBtc.amount, 20000n - 200n); // 1% of 20000 = 200 > floor 50
  const s = sc(b, "maker.testnet");
  assert.match(s.headline, /^You won 9\.50 USDC \+ 0\.000198 BTC\.$/);
});

test("I-1 per asset: every scheduled line adds back to what each side deposited (stake + storage), over a grid", () => {
  const asset = (b: any, side: "maker" | "taker") => (side === "maker" ? b.envelope.maker_asset : b.envelope.taker_asset);
  for (const stake of ["10000000", "50000000", "1000000"]) for (const tip of ["0", "500000"]) for (const keep of [true, false]) for (const status of ["Settled", "Finalized", "Voided", "Cancelled", "Expired"]) for (const outcome of ["YES", "NO", "VOID", null]) for (const ref of [null, REF]) for (const proposed of [null, 3]) {
    const b = bet({ env: { stake_maker: stake, stake_taker: stake, keep_terms: keep, referee: ref }, rest: { status, outcome, proposed_at: proposed, tip_maker: ref ? tip : "0", tip_taker: ref ? tip : "0", taker: status === "Cancelled" || status === "Expired" ? null : "taker.testnet" } });
    const ex = expectedPayouts(b);
    if (!ex) continue;
    const dep = 2n * BigInt(stake) + 40000n - (b.taker ? 0n : BigInt(stake) + 20000n);
    const total = ex.reduce((n: bigint, l: { amount: bigint }) => n + l.amount, 0n);
    assert.equal(total, dep, JSON.stringify({ stake, tip, keep, status, outcome, ref: !!ref, proposed }));
    void asset;
  }
});

test("payout progress: Paid only when the pending list is empty; otherwise in progress with exact line amounts", () => {
  const settled = bet();
  assert.equal(sc(settled, "maker.testnet", []).progress.state, "paid");
  assert.equal(sc(settled, "maker.testnet", []).progress.message, "Paid.");
  assert.equal(sc(settled, "maker.testnet", null).progress.state, "unknown");
  const fin = bet({ rest: { status: "Finalized" } });
  assert.equal(sc(fin, "maker.testnet", []).progress.state, "paying"); // Finalized with an empty list is not Paid: the bet has not reached Settled
  assert.equal(sc(fin, "maker.testnet", []).progress.canRetry, true);
  const inflight = sc(fin, "maker.testnet", [line({ attempts: 1, in_flight: true })]);
  assert.equal(inflight.progress.state, "paying");
  assert.equal(inflight.progress.message, "Payout in progress…");
  assert.deepEqual(inflight.progress.lines, ["Sending 19.00 USDC to maker.testnet"]);
  assert.equal(inflight.progress.canRetry, false); // the contract skips in-flight lines
  const slow = sc(fin, "maker.testnet", [line({ attempts: 2 }), line({ id: 2, receiver: "fee.testnet", amount: "1040000", reason: "fee_and_storage", attempts: 1, in_flight: true })]);
  assert.equal(slow.progress.state, "slow");
  assert.equal(slow.progress.message, "Payout is taking longer than usual. Your money is safe in escrow. Retry.");
  assert.equal(slow.progress.canRetry, true);
  assert.deepEqual(slow.progress.lines, ["Sending 19.00 USDC to maker.testnet", "Sending 1.04 USDC to fee.testnet"]);
  assert.equal(sc(fin, "maker.testnet", [line()]).progress.state, "paying"); // never attempted yet: waiting, retry available
  assert.equal(sc(fin, "maker.testnet", [line()]).progress.canRetry, true);
  assert.equal(sc(bet({ rest: { status: "Cancelled", taker: null, outcome: null, proposed_at: null } }), "maker.testnet", [line({ receiver: "maker.testnet", amount: "10020000", reason: "cancel_expire_refund" })]).progress.state, "paying");
});

test("retry calls the contract's drain_payouts(bet_id, limit) -- one call re-sends every unsent group", () => {
  assert.deepEqual(drainPayoutsArgs(7), { bet_id: 7, limit: 10 });
  assert.ok(rs.includes("const MAX_DRAIN_BATCH: u64 = 10;"));
});

test("no screen before there is an ending", () => {
  for (const status of ["Open", "Taken", "Resolving", "Proposed", "Challenged", "Evidence", "Rejudge"]) assert.equal(payoutScreen(bet({ rest: { status, outcome: null } }), "maker.testnet", []), null, status);
});

test("a bystander gets the same facts in the third person", () => {
  const s = sc(bet(), "stranger.testnet");
  assert.equal(s.headline, "maker.testnet won 19.00 USDC.");
  assert.equal(sc(bet({ rest: { status: "Voided", outcome: null, proposed_at: null } }), null).headline, "The app was shut down. Both sides got their own deposits back.");
});

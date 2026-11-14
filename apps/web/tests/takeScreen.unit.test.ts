// RF2d (D-REFUI4): the Take screen's pure logic -- referee line, taker tip cost, stale-referee refusal, Take msg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { takeRefereeLine, takeTipOffer, prepareTake } from "../lib/takeScreen";
import { feeForSideUnits } from "../lib/escrowAdapter";

const here = dirname(fileURLToPath(import.meta.url));
const NS = 1_800_000_000n * 1_000_000_000n;
const bet = (over: Record<string, any> = {}, env: Record<string, any> = {}): any => ({
  status: "Open", taker: null, storage_rates: new Proxy({}, { get: () => "457" }) as any, // STG1b fixture: ceil(3136*457/2048)=700
  fee_min_taker: "500000",
  envelope: {
    maker: "maker.testnet", taker_asset: "nep141:usdc.testnet", stake_taker: "10000000", storage_charge_per_side: "700",
    fee_bps: 100, resolve_deadline: Number(NS), referee: { account: "ref.testnet", mode: "Human" }, taker_options: [], ...env,
  },
  ...over,
});
const same = (b: any) => async () => b;

test("referee line: human mode names the referee and the deadline; AI mode has the AI line", () => {
  const h = takeRefereeLine(bet(), "Jan 15, 2027");
  assert.equal(h.mode, "human");
  assert.equal(h.referee, "ref.testnet");
  assert.equal(h.text, "A person decides this bet: ref.testnet. If they don't rule by Jan 15, 2027, you're both refunded.");
  const a = takeRefereeLine(bet({}, { referee: null }), "x");
  assert.equal(a.mode, "ai");
  assert.equal(a.referee, null);
  assert.match(a.text, /AI/);
  assert.ok(!/person|refund/i.test(a.text));
});

test("tip offer: same formula as the maker side; hidden in AI mode", () => {
  const o = takeTipOffer(bet());
  assert.equal(o.visible, true);
  assert.equal(o.tipUnits, feeForSideUnits(10_000_000n, 500_000n));
  assert.equal(o.tipUnits, 500_000n);
  assert.equal(o.problem, null);
  assert.equal(takeTipOffer(bet({}, { referee: null })).visible, false);
});

test("tip offer: uses the bet's min_fee copy, not the live asset table", () => {
  assert.equal(takeTipOffer(bet({ fee_min_taker: "2000000" })).tipUnits, 2_000_000n);
});

test("tip offer: refuses when protocol fee + tip exceeds the taker stake", () => {
  const o = takeTipOffer(bet({ fee_min_taker: "6000000" }));
  assert.match(o.problem ?? "", /exceeds the stake/);
});

test("prepareTake: tip + referee_ack = the referee shown; deposit = taker stake + storage in the taker asset", async () => {
  const b = bet();
  const r = await prepareTake({ betId: 7, shown: b, tip: true, inviteSig: null, readBet: same(b) });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(JSON.parse(r.msg), { kind: "Take", bet_id: 7, invite_sig: null, tip: true, referee_ack: "ref.testnet" });
  assert.equal(r.tokenId, "nep141:usdc.testnet");
  assert.equal(r.amount, "10000700");
});

test("prepareTake: no tip -> tip false; AI mode -> referee_ack null", async () => {
  const b = bet();
  const r1 = await prepareTake({ betId: 7, shown: b, tip: false, inviteSig: "sig", readBet: same(b) });
  assert.ok(r1.ok && JSON.parse(r1.msg).tip === false && JSON.parse(r1.msg).invite_sig === "sig");
  const ai = bet({}, { referee: null });
  const r2 = await prepareTake({ betId: 7, shown: ai, tip: true, inviteSig: null, readBet: same(ai) });
  assert.ok(r2.ok && JSON.parse(r2.msg).tip === false && JSON.parse(r2.msg).referee_ack === null);
});

test("prepareTake: refuses (no msg) when the referee changed since the page loaded", async () => {
  const shown = bet();
  const now = bet({}, { referee: { account: "other.testnet", mode: "Human" } });
  const r = await prepareTake({ betId: 7, shown, tip: true, inviteSig: null, readBet: same(now) });
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.match(r.message, /referee changed/i);
  assert.ok(!("msg" in r));
  const cleared = bet({}, { referee: null });
  assert.ok(!(await prepareTake({ betId: 7, shown, tip: false, inviteSig: null, readBet: same(cleared) })).ok);
  assert.ok(!(await prepareTake({ betId: 7, shown: cleared, tip: false, inviteSig: null, readBet: same(shown) })).ok);
});

test("prepareTake: refuses when the bet is gone, no longer open, or the re-read fails", async () => {
  const shown = bet();
  for (const rb of [async () => null, same(bet({ status: "Taken" })), async () => { throw new Error("rpc"); }]) {
    const r = await prepareTake({ betId: 7, shown, tip: false, inviteSig: null, readBet: rb as any });
    assert.ok(!r.ok);
  }
});

test("prepareTake: refuses a tip whose fee + tip exceeds the stake", async () => {
  const b = bet({ fee_min_taker: "6000000" });
  const r = await prepareTake({ betId: 7, shown: b, tip: true, inviteSig: null, readBet: same(b) });
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.message, /exceeds the stake/);
});

test("BetPage: the disabled stub is gone; take screen has tip checkbox, referee line, and sends via intents mt_transfer_call (INTENTS1)", () => {
  const src = readFileSync(join(here, "../src/components/BetPage.tsx"), "utf8") + readFileSync(join(here, "../src/components/TakeBetModal.tsx"), "utf8"); // MODAL1c2: the take logic moved into TakeBetModal
  assert.ok(!/pending redeploy/.test(src));
  // M1 (UX-37 #5): the referee line is the shared 5-line review's "Who decides" row (C1 ReviewCard, take variant: @username / the AI).
  for (const id of ["take-tip-checkbox", "take-tip-cost", "take-error", "take-confirm"]) assert.ok(src.includes(`"${id}"`), id);
  assert.ok(/<ReviewCard offer=\{review\.offer\}/.test(src) && /takerReviewOffer\(betR, \{[^}]*refereeUsername/.test(src), "take sheet renders the shared review (take) with the referee's username");
  assert.ok(/prepareTake\(/.test(src) && /buildStakeTransfer\(/.test(src) && !/transfer_with_msg/.test(src));
});

test("README no longer describes Witness/Source/FinalSay as live modes", () => {
  const md = readFileSync(join(here, "../README.md"), "utf8");
  assert.ok(!/Witness|FinalSay|Final say/.test(md));
  assert.match(md, /A person decides/);
});

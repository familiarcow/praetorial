// FE12 (S14): the human referee's screen logic + the bettors' waiting view (UX-19/UX-20). Mirrors contracts/escrow/src/lib.rs referee_rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { refereeScreen, ruleConfirmSentence, refereeRuleArgs, confirmRule, REFEREE_RULE_METHOD } from "../lib/refereeScreen";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
const a = rs.indexOf("pub fn referee_rule(");
const rule = rs.slice(a, rs.indexOf("\n    pub fn ", a + 1));

const USDC = "nep141:usdc.testnet";
const SEC = 1_000_000_000;
const FUND = Date.UTC(2037, 0, 2) * 1e6, RESOLVE = Date.UTC(2037, 0, 5) * 1e6;
const at = (ns: number) => Math.floor(ns / 1e6);
const bet = (o: any = {}) => ({
  envelope: { maker: "maker.testnet", maker_side: "YES", outcomes: ["YES", "NO"], referee: { account: "ref.testnet", mode: "Human" }, maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", fee_bps: 100, funding_deadline: FUND, resolve_deadline: RESOLVE, ...(o.env ?? {}) },
  status: "Taken", taker: "taker.testnet", bonds: [], outcome: null, fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: "0", tip_taker: "0", ...o.rest,
}) as any;
const MID = at(FUND) + 3_600_000;

test("the guards the screen mirrors still exist in referee_rule", () => {
  for (const t of ["only the named referee may rule", "bet is not awaiting a ruling", "already ruled", "too early: funding_deadline not reached", "resolve_deadline passed", "outcome must be YES, NO or VOID"]) assert.ok(rule.includes(t), t);
  assert.equal(REFEREE_RULE_METHOD, "referee_rule");
});

test("referee in the window sees YES / NO / VOID buttons, the deadline and no AI suggestion", () => {
  const v = refereeScreen(bet(), "ref.testnet", MID);
  assert.equal(v.kind, "referee");
  if (v.kind !== "referee") return;
  assert.equal(v.state, "ready");
  assert.deepEqual(v.buttons.map((b) => b.outcome), ["YES", "NO", "VOID"]);
  assert.equal(v.buttons[2].label, "VOID — refund both");
  assert.match(v.deadlineLine, /^You can rule any time until 2037-01-05 00:00 UTC\. If you don't, both are refunded\.$/);
  assert.ok(!/AI/.test(JSON.stringify(v)), "no AI suggestion");
});

test("too early: 'you can rule from <time>' (funding_deadline), no buttons", () => {
  const v = refereeScreen(bet(), "ref.testnet", at(FUND) - 1000);
  assert.ok(v.kind === "referee" && v.state === "early");
  if (v.kind === "referee") { assert.equal(v.message, "You can rule from 2037-01-02 00:00 UTC."); assert.equal(v.buttons.length, 0); }
});

test("after the resolve deadline: window closed, no buttons", () => {
  const v = refereeScreen(bet(), "ref.testnet", at(RESOLVE) + 1000);
  assert.ok(v.kind === "referee" && v.state === "closed");
  if (v.kind === "referee") { assert.equal(v.message, "The ruling window closed with no ruling. Both bettors get their stakes back; the refund is sent automatically."); assert.equal(v.buttons.length, 0); }
});

test("already ruled / not awaiting a ruling: no buttons", () => {
  const v = refereeScreen(bet({ rest: { status: "Finalized", outcome: "YES" } }), "ref.testnet", MID);
  assert.ok(v.kind === "referee" && v.state === "ruled" && v.buttons.length === 0);
  if (v.kind === "referee") assert.equal(v.message, "A ruling has already been made.");
});

test("a non-referee (bettor, stranger, logged out) never gets rule buttons; bettors get the waiting line", () => {
  for (const me of ["stranger.testnet", null]) assert.equal(refereeScreen(bet(), me, MID).kind, "none");
  for (const me of ["maker.testnet", "taker.testnet"]) {
    const v = refereeScreen(bet(), me, MID);
    assert.equal(v.kind, "wait");
    if (v.kind === "wait") assert.equal(v.line, "Waiting for ref.testnet to rule · they have until 2037-01-05 00:00 UTC");
  }
  assert.equal(refereeScreen(bet({ env: { referee: null } }), "maker.testnet", MID).kind, "none"); // AI bet
  assert.equal(refereeScreen(bet({ rest: { status: "Settled", outcome: "YES" } }), "maker.testnet", MID).kind, "none");
});

test("tip line: shown only when someone tipped, summed from the bet's own tip fields", () => {
  const none = refereeScreen(bet(), "ref.testnet", MID);
  assert.ok(none.kind === "referee" && none.tipLine === null);
  const tipped = refereeScreen(bet({ rest: { tip_maker: "500000", tip_taker: "500000" } }), "ref.testnet", MID);
  assert.ok(tipped.kind === "referee");
  if (tipped.kind === "referee") assert.equal(tipped.tipLine, "You'll receive 1 USDC whatever you decide.");
});

test("confirm sentence names the winner and the amount (fee via side_fee, floor included, tip taken out), same wording for NO", () => {
  // 10 USDC each, 1% = 0.1 but floor 0.5 -> each side pays 0.5 -> winner gets 9.5 + 9.5 = 19
  assert.equal(ruleConfirmSentence(bet(), "YES"), "You're ruling YES: maker.testnet wins 19 USDC. This pays out immediately and can't be changed or challenged.");
  assert.equal(ruleConfirmSentence(bet(), "NO"), "You're ruling NO: taker.testnet wins 19 USDC. This pays out immediately and can't be changed or challenged.");
  // with tips of 0.5 each: 9 + 9
  assert.equal(ruleConfirmSentence(bet({ rest: { tip_maker: "500000", tip_taker: "500000" } }), "YES"), "You're ruling YES: maker.testnet wins 18 USDC. This pays out immediately and can't be changed or challenged.");
  assert.equal(ruleConfirmSentence(bet(), "VOID"), "You're ruling VOID: both bettors get their stake back, no fee. This pays out immediately and can't be changed or challenged.");
});

test("the signed call is exactly referee_rule(bet_id, outcome)", () => {
  assert.deepEqual(refereeRuleArgs(7, "NO"), { bet_id: 7, outcome: "NO" });
  assert.throws(() => refereeRuleArgs(7, "MAYBE" as any));
});

test("confirmRule: success only when get_bet shows the ruling; otherwise honest", async () => {
  const sleep = async () => {};
  const ruled = bet({ rest: { status: "Finalized", outcome: "YES" } });
  const ok = await confirmRule({ betId: 7, outcome: "YES", deps: { getBet: async () => ruled, sleep }, attempts: 2 });
  assert.equal(ok.kind, "ruled");
  assert.match(ok.message, /^Done\. maker\.testnet has been paid\./);
  const pending = await confirmRule({ betId: 7, outcome: "YES", deps: { getBet: async () => bet(), sleep }, attempts: 2 });
  assert.equal(pending.kind, "pending");
  const refused = await confirmRule({ betId: 7, outcome: "YES", deps: { getBet: async () => bet({ rest: { status: "Voided" } }), sleep }, attempts: 2 });
  assert.equal(refused.kind, "refused");
  const void_ = await confirmRule({ betId: 7, outcome: "VOID", deps: { getBet: async () => bet({ rest: { status: "Finalized", outcome: "VOID" } }), sleep }, attempts: 2 });
  assert.match(void_.message, /^Done\. Both bettors are being refunded\./);
});

test("M1 (PEOPLE RULE): confirmRule names the paid side through the caller's labeller (@username), never the raw id", async () => {
  const ruled = bet({ rest: { status: "Finalized", outcome: "YES" } });
  const ok = await confirmRule({ betId: 7, outcome: "YES", deps: { getBet: async () => ruled, sleep: async () => {} }, attempts: 1, name: (a) => (a === "maker.testnet" ? "@mia" : "Unnamed account") });
  assert.match(ok.message, /^Done\. @mia has been paid\./);
});

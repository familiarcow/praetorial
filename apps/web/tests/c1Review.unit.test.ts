// C1 (UIR1 §3.4 + §2.2 ReviewSummary, familiarcow UX-37 #5 #6 #7, PEOPLE RULE 2026-11-11): the create / take review is FIVE lines (the
// claim, the deadline, both stakes, who decides incl. the referee's @username, the closing time) + everything else under a collapsed
// "Full terms". Amounts follow lib/money.ts (stables 2 dp, others <= 6 significant, "< 0.01" for tiny storage, exact in Full terms);
// dates are relative with the exact local + UTC time in Full terms; no raw status, hash, 21-decimal amount or account id anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewModel } from "../lib/reviewCard";

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const DAY = 86_400_000;
const base: any = {
  termSheet: {}, typedSheet: { template: "nws_daily_high", fields: {} }, claimText: "NYC's high on Dec 8, 2027 is 72°F or more.", sources: ["NWS CLI", "IEM CLI"],
  deadlineLabel: "2027-12-08", eventAtSecs: (NOW + 391 * DAY) / 1000, makerAssetSymbol: "USDC", makerAmount: 10, takerAssetSymbol: "USDC", takerAmount: 10,
  odds: 1, settlementPeriodLabel: "24h", settlementSecs: 86400, takerOptions: [], referee: { mode: "ai" },
  offerClosesLabel: "This offer closes 2026-11-19 12:00 UTC.", offerClosesAtSecs: (NOW + 7 * DAY) / 1000, takerAccount: null, flags: [], priceWarning: null, customVenueNotes: [],
};
const ALICE = "a".repeat(64);
const human: any = { ...base, referee: { mode: "human", referee: ALICE }, refereeUsername: "alice", resolveSecs: (NOW + 800 * DAY) / 1000, resolveByLabel: "2029-01-20 12:00 UTC", tipMaker: true, settlementSecs: undefined };
const storage = { maker: "0.000004 USDC", taker: "0.000004 USDC", makerUnits: "4", takerUnits: "4" };

const all = (m: ReturnType<typeof buildReviewModel>) => [...m.summary.map((r) => `${r.label} ${r.text}`), ...m.terms.map((r) => `${r.label} ${r.value}`)].join("\n");

test("five lines, in order: the bet, the deadline, both stakes, who decides, when the offer closes", () => {
  const m = buildReviewModel(base, storage, { nowMs: NOW });
  assert.deepEqual(m.summary.map((r) => r.id), ["claim", "deadline", "stakes", "decider", "closes"]);
  assert.equal(m.summary[0].text, "NYC's high on Dec 8, 2027 is 72°F or more.");
  assert.equal(m.summary[1].text, "Ends in 13 months");
  assert.equal(m.summary[1].at, base.eventAtSecs * 1000);
  assert.equal(m.summary[2].text, "You put in 10.00 USDC · they put in 10.00 USDC");
  assert.equal(m.summary[3].text, "The AI judge, from NWS CLI and IEM CLI");
  assert.equal(m.summary[4].text, "Closes in 7 days");
  assert.equal(m.summary[4].at, base.offerClosesAtSecs * 1000);
});

test("amounts: lib/money rule (no float toFixed): NEAR trimmed, BTC significant digits, uneven stakes", () => {
  const near = buildReviewModel({ ...base, makerAssetSymbol: "NEAR", takerAssetSymbol: "NEAR", makerAmount: 25, takerAmount: 12.5 }, null, { nowMs: NOW });
  assert.equal(near.summary[2].text, "You put in 25 NEAR · they put in 12.5 NEAR");
  const btc = buildReviewModel({ ...base, makerAssetSymbol: "BTC", takerAssetSymbol: "BTC", makerAmount: 0.12345678, takerAmount: 0.001 }, null, { nowMs: NOW });
  assert.equal(btc.summary[2].text, "You put in 0.123457 BTC · they put in 0.001 BTC");
});

test("the referee is their @username, never an account id; a missing name is 'Unnamed account'", () => {
  const m = buildReviewModel(human, storage, { nowMs: NOW });
  assert.equal(m.summary[3].text, "@alice, a person (no AI)");
  assert.ok(!all(m).includes(ALICE), "raw referee id on the review");
  const anon = buildReviewModel({ ...human, refereeUsername: undefined }, storage, { nowMs: NOW });
  assert.equal(anon.summary[3].text, "Unnamed account, a person (no AI)");
  assert.ok(!all(anon).includes(ALICE));
});

test("a direct taker is shown by @username (looked up), never the raw account; invite-only and open offers say so", () => {
  const BOB = "b".repeat(64);
  const named = buildReviewModel({ ...base, takerAccount: BOB }, storage, { nowMs: NOW, names: { [BOB]: "bob" } });
  assert.equal(named.terms.find((t) => t.id === "takers")!.value, "Only @bob can take it.");
  assert.ok(!all(named).includes(BOB));
  const loading = buildReviewModel({ ...base, takerAccount: BOB }, storage, { nowMs: NOW, names: { [BOB]: undefined } });
  assert.equal(loading.terms.find((t) => t.id === "takers")!.value, "Only … can take it.");
  assert.equal(buildReviewModel({ ...base, inviteByLink: true }, storage, { nowMs: NOW }).terms.find((t) => t.id === "takers")!.value,
    "Only people you send a personal invite link to can take it.");
  assert.equal(buildReviewModel(base, storage, { nowMs: NOW }).terms.find((t) => t.id === "takers")!.value, "Anyone with the link can take it.");
});

test("Full terms: sources, exact times (local + UTC), challenge window, money with exact values, fee, refunds, worst case", () => {
  const m = buildReviewModel(base, storage, { nowMs: NOW });
  const t = Object.fromEntries(m.terms.map((r) => [r.id, r.value]));
  assert.equal(t.sources, "NWS CLI, IEM CLI");
  assert.match(t["offer-closes"], /19 Nov 2026, 12:00 UTC/);
  assert.match(t.event, /Dec 2027/);
  assert.equal(t.window, "24h to challenge a ruling, 2 rounds.");
  assert.equal(t.stake, "10.00 USDC");
  assert.equal(t.storage, "< 0.01 USDC (exactly 0.000004 USDC)");
  assert.equal(t["pay-now"], "10.00 USDC (exactly 10.000004 USDC)");
  assert.match(t.fee, /^1% of the stake, at least 0\.\d\d USDC per person, taken from the pot when the bet ends\.$/);
  assert.match(t.refunds, /Nobody takes it: full refund\./);
  assert.equal(t["worst-case"], "If you lose, you lose your 10.00 USDC stake. You can't lose more than what you pay now.");
  assert.equal(m.payNow, "10.00 USDC");
});

test("person decides: rule-by date and the refund rule instead of a challenge window; the tip line", () => {
  const m = buildReviewModel(human, storage, { nowMs: NOW });
  const t = Object.fromEntries(m.terms.map((r) => [r.id, r.value]));
  assert.match(t.window, /^@alice can rule any time until .*2029.* If they don't, you're both refunded\.$/);
  assert.match(t.tip, /^Tip to the referee: 0\.\d\d USDC, out of your 10\.00 USDC stake\. It is not added on top\.$/);
  assert.ok(!t.refunds.includes("AI can't decide"));
});

test("storage still loading: pay-now is null (button says 'Open the bet'), Full terms says it is loading", () => {
  const m = buildReviewModel(base, null, { nowMs: NOW });
  assert.equal(m.payNow, null);
  assert.equal(m.terms.find((t) => t.id === "pay-now")!.value, "Loading…");
});

test("nothing raw on the review: no status words, hashes, nep141 ids, long decimals, odds, Maker/Taker", () => {
  const sheet = { template: "btc_close_at_t", fields: { open_utc: "2026-11-12T12:00:00Z" } };
  for (const o of [base, human, { ...base, typedSheet: sheet }, { ...base, side: "taker" }]) {
    const text = all(buildReviewModel(o, { ...storage, maker: "0.000000000000000000165 NEAR" }, { nowMs: NOW }));
    assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/, "hash or implicit id");
    assert.doesNotMatch(text, /nep141:|sha256|fingerprint/i);
    assert.doesNotMatch(text, /\d\.\d{9,}/, "long decimals");
    assert.doesNotMatch(text, /\b(ready|blocked|idle|Odds|Maker|Taker)\b/);
    assert.doesNotMatch(text, /\d{4}-\d\d-\d\dT\d\d:/, "raw ISO time");
  }
});

test("take side: the first stake is the viewer's ('You put in' = their own stake)", () => {
  const m = buildReviewModel({ ...base, side: "taker", makerAmount: 5, takerAmount: 10 }, storage, { nowMs: NOW });
  assert.equal(m.summary[2].text, "You put in 5.00 USDC · they put in 10.00 USDC");
});

test("an expiry cut back to the event start says so in Full terms", () => {
  const m = buildReviewModel({ ...base, offerClosesClamped: true }, storage, { nowMs: NOW });
  assert.match(m.terms.find((t) => t.id === "offer-closes")!.value, /UTC \(the event starts then, so that is as long as it can stay open\)$/);
});

test("TPL1: a price bet's own decider line (Bitcoin: by code; another coin: the AI judge reading the venues) replaces the generic one; a person still wins", () => {
  const zec = { ...base, deciderText: "Decided by the AI judge reading Coinbase ZEC-USD, Bitstamp zecusd and Kraken ZEC/USD" };
  assert.equal(buildReviewModel(zec, storage, { nowMs: NOW }).summary[3].text, "Decided by the AI judge reading Coinbase ZEC-USD, Bitstamp zecusd and Kraken ZEC/USD");
  assert.equal(buildReviewModel({ ...zec, deciderText: null }, storage, { nowMs: NOW }).summary[3].text, "The AI judge, from NWS CLI and IEM CLI");
  assert.equal(buildReviewModel({ ...human, deciderText: "Decided by code" }, storage, { nowMs: NOW }).summary[3].text, "@alice, a person (no AI)");
});

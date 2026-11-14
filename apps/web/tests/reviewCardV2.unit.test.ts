// FE7 (S7): ReviewCard v2 view-model. Rendered only from structured fields; the only free text is the term-sheet sentence.
// C1 (UX-37 #5 #7, PEOPLE RULE): the FE7 blocks (pay table, deadlines, refunds, worst case) now live in the collapsed Full terms
// (model.terms); amounts follow lib/money.ts (USDC 2 dp, exact value next to a rounded one); the referee is an @username.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildReviewModel } from "../lib/reviewCard";
import { findAsset } from "../lib/assets";

const here = dirname(fileURLToPath(import.meta.url));
const base: any = {
  termSheet: {}, typedSheet: null, claimText: "Bitcoin touches $76,000 before Dec 8.", sources: ["api.exchange.coinbase.com"],
  deadlineLabel: "2027-12-08 00:00 UTC", makerAssetSymbol: "USDC", makerAmount: 10, takerAssetSymbol: "USDC", takerAmount: 10,
  odds: 1, settlementPeriodLabel: "6h", settlementSecs: 21600, takerOptions: [], referee: { mode: "ai" },
  offerClosesLabel: "This offer closes 2026-11-10 12:00 UTC.", takerAccount: null, flags: [], priceWarning: null, customVenueNotes: [],
};
const human: any = { ...base, referee: { mode: "human", referee: "alice.testnet" }, refereeUsername: "alice", resolveByLabel: "2028-12-08 00:00 UTC", tipMaker: true, settlementSecs: undefined };
const NOW = Date.UTC(2026, 10, 1);
const T = (o: any, st: any = storage) => Object.fromEntries(buildReviewModel(o, st, { nowMs: NOW }).terms.map((r) => [r.id, r.value]));
const storage = { maker: "0.000004 USDC", taker: "0.000004 USDC", makerUnits: "4", takerUnits: "4" };

test("pay-now: stake + storage (+ tip line), numbers from the asset table and the contract storage quote, exact value kept", () => {
  const m = buildReviewModel(base, storage, { nowMs: NOW });
  const floor = Number(findAsset("USDC")!.minFeePerSide) / 1e6;
  assert.equal(m.table.stake, "10.00 USDC");
  assert.equal(m.table.storage, "< 0.01 USDC (exactly 0.000004 USDC)");
  assert.equal(m.table.payNow, "10.00 USDC");
  assert.equal(T(base)["pay-now"], "10.00 USDC (exactly 10.000004 USDC)");
  assert.equal(m.table.tip, null);
  assert.equal(m.fee.maker, `${floor.toFixed(2)} USDC`); // 1% of 10 USDC is under the floor
  assert.equal(m.fee.floor, `${floor.toFixed(2)} USDC`);
  assert.match(m.fee.line, new RegExp(`at least ${floor.toFixed(2)} USDC per person`));
});
test("storage still loading: pay-now is null, not a guess", () => {
  const m = buildReviewModel(base, null, { nowMs: NOW });
  assert.equal(m.payNow, null);
  assert.equal(m.table.storage, null);
  assert.equal(T(base, null)["pay-now"], "Loading…");
});
test("fee floor binds on a small stake and the line says so", () => {
  const m = buildReviewModel({ ...base, makerAmount: 10, takerAmount: 10 }, storage, { nowMs: NOW });
  assert.ok(Number(m.fee.maker.split(" ")[0]) >= Number(findAsset("USDC")!.minFeePerSide) / 1e6);
});
test("deadlines: offer closes, event, challenge window (AI)", () => {
  const t = T(base);
  assert.equal(t["offer-closes"], "This offer closes 2026-11-10 12:00 UTC.");
  assert.equal(t.event, "2027-12-08 00:00 UTC");
  assert.equal(t.window, "6h to challenge a ruling, 2 rounds.");
});
test("deadlines: human mode shows the referee's rule-by date and no challenge window", () => {
  const t = T(human);
  assert.equal(t.window, "@alice can rule any time until 2028-12-08 00:00 UTC. If they don't, you're both refunded.");
  assert.ok(!/challenge/.test(t.window));
});
test("worst case and refund rules, AI variant", () => {
  const t = T(base);
  assert.equal(t["worst-case"], "If you lose, you lose your 10.00 USDC stake. You can't lose more than what you pay now.");
  assert.equal(t.refunds, "Nobody takes it: full refund. The AI can't decide (VOID): you both get your stakes back and no fee is charged. If the app is shut down, anyone can trigger a full refund.");
});
test("human variant: a person decides (no AI), referee-silent refund, tip line, the referee by @username only", () => {
  const m = buildReviewModel(human, storage, { nowMs: NOW });
  const t = T(human);
  assert.equal(m.summary.find((r) => r.id === "decider")!.text, "@alice, a person (no AI)");
  assert.match(t.refunds, /The referee never rules: you're both refunded on 2028-12-08 00:00 UTC\./);
  assert.ok(!/AI can't decide/.test(t.refunds));
  assert.match(m.table.tip!, /^Tip to the referee: 0\.50 USDC, out of your 10\.00 USDC stake\./);
  assert.ok(!JSON.stringify(m).includes("alice.testnet"), "no raw referee id");
});
test("human, no tip: the tip row says so", () => {
  const m = buildReviewModel({ ...human, tipMaker: false }, storage, { nowMs: NOW });
  assert.match(m.table.tip!, /^No tip/);
});
test("the card reads no free text except the term-sheet sentence (and the sources list)", () => {
  const poison = { ...base, priceWarning: "POISON", customVenueNotes: ["POISON"], flags: ["POISON"] };
  const a = JSON.stringify(buildReviewModel(base, storage, { nowMs: NOW }));
  const b = JSON.stringify(buildReviewModel(poison, storage, { nowMs: NOW }));
  assert.equal(a, b); // warnings/flags/notes are rendered by the card from their own fields, never copied into the model
  const c = JSON.parse(JSON.stringify(buildReviewModel({ ...base, claimText: "ZZZ" }, storage, { nowMs: NOW })));
  const d = JSON.parse(a);
  assert.equal(c.summary[0].text, "ZZZ");
  c.summary[0].text = d.summary[0].text = "";
  assert.deepEqual(c, d, "claimText feeds only the first line");
});
test("copy snapshot: AI and human variants", () => {
  const snap = (o: any) => { const m = buildReviewModel(o, storage, { nowMs: NOW }); return { summary: m.summary.map((r) => [r.label, r.text]), terms: m.terms.map((r) => [r.label, r.value]) }; };
  assert.deepEqual(snap(base), JSON.parse(readFileSync(join(here, "fixtures/reviewCardV2.ai.json"), "utf8")));
  assert.deepEqual(snap(human), JSON.parse(readFileSync(join(here, "fixtures/reviewCardV2.human.json"), "utf8")));
});
test("wiring: ReviewCard renders the five lines + Full terms from buildReviewModel with the kit (no raw lines)", () => {
  const rc = readFileSync(join(here, "../src/components/ReviewCard.tsx"), "utf8");
  for (const id of ["review-card", "review-summary", "review-full-terms", "review-flags", "review-warnings"]) assert.ok(rc.includes(`data-testid="${id}"`), id);
  assert.ok(rc.includes("buildReviewModel") && rc.includes("review-${r.id}") && rc.includes("review-term-${t.id}"));
  for (const gone of ["review-terms-hash", "review-open-gate", "review-odds", "review-taker-options", "termsHash", "toFixed"]) assert.ok(!rc.includes(gone), gone);
});

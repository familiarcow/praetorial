// SET1 (PM, 2026-11-14: "I cant see the bets that have already finished, I just see the in progress ones. I want all users to be able
// to see them"): Home's public "Settled" section. Everyone's finished, accepted bets (mine too), newest first, as read-only "public"
// cards whose line says the ruling (YES / NO / VOID) and how it ended (AI judge, referee, conceded, refunded).
import { test } from "node:test";
import assert from "node:assert/strict";
import { settledCandidates, settledCards, settledEnding, SETTLED_STATUSES, SETTLED_LIMIT, type HomeBet } from "../lib/homeSections";
import { betView } from "../lib/betView";
import { fixtureByKey, ME, DAY, FIXTURE_CONTRACT } from "./fixtures/bets";

const NOW = Date.UTC(2026, 10, 11, 12);
const NAMES = { "dave.near": "dave", "erin.near": "erin", "frank.near": "frank", "gina.near": "gina", "hal.near": "hal", "kim.near": "kim", [ME]: "me" };
const CTX = { contractId: FIXTURE_CONTRACT, names: NAMES };
const item = (key: string): HomeBet => { const f = fixtureByKey(NOW, key); return { id: f.id, bet: structuredClone(f.bet), pending: f.pending ?? null }; };
const ids = (cards: { view: { id: number } }[]) => cards.map((c) => c.view.id);
const ALL = () => ["won", "lost", "voided", "conceded", "referee-decided", "expired", "cancelled", "live", "open-theirs", "paying"].map(item);
const sentence = (cards: { view: { id: number; sentence: string } }[], id: number) => cards.find((c) => c.view.id === id)!.view.sentence;

// ---------------------------------------------------------------- candidates (indexer /history -> ids to read with get_bet)
test("Settled candidates: the indexer's finished statuses (Settled, Voided), newest first, deduped, hide list applied", () => {
  assert.deepEqual([...SETTLED_STATUSES], ["Settled", "Voided"]);
  const h = [
    { bet_id: 1, status: "Settled" }, { bet_id: 2, status: "Taken" }, { bet_id: 3, status: "Voided" }, { bet_id: 4, status: "Expired" },
    { bet_id: 5, status: "Cancelled" }, { bet_id: 6, status: "settling, confirming" }, { bet_id: 7, status: "Finalized" }, { bet_id: 8, status: "Settled" },
    { bet_id: 8, status: "Settled" }, { bet_id: 9, status: "Open" },
  ];
  assert.deepEqual(settledCandidates(h), [8, 3, 1], "never-taken (Cancelled/Expired), unconfirmed and unfinished bets are not candidates");
  assert.deepEqual(settledCandidates(h, new Set([3])), [8, 1]);
  assert.equal(settledCandidates(Array.from({ length: 70 }, (_, i) => ({ bet_id: i + 1, status: "Settled" }))).length, 70, "all of them: the section pages through");
  assert.equal(SETTLED_LIMIT, 20);
});

test("Settled candidates: the mainnet indexer's row for bet 1 (Settled, NO) is one", () => {
  const mainnet = [
    { bet_id: 1, contract_id: "bets.praetorial.near", maker: "ad39…", taker: "03c1…", status: "Settled", outcome: "NO", display_status: "Settled" },
    { bet_id: 2, contract_id: "bets.praetorial.near", maker: "ad39…", taker: "03c1…", status: "Taken", outcome: null, display_status: "Taken" },
  ];
  assert.deepEqual(settledCandidates(mainnet), [1]);
});

// ---------------------------------------------------------------- cards (get_bet is the truth)
test("Settled cards: every finished, accepted bet (mine too, for a guest and for me), newest first, read-only 'public' cards", () => {
  for (const me of [null, ME, "zed.near"]) {
    const cards = settledCards(ALL(), me, NOW, CTX);
    assert.deepEqual(ids(cards), [212, 211, 210, 209, 208], `me=${me}: settled + refunded only; never-taken, live, open and paying bets dropped`);
    assert.ok(cards.every((c) => c.variant === "public" && c.view.primary === null && c.view.secondary.length === 0), `me=${me}`);
  }
});

test("Settled cards: the chain is the truth: a candidate that is not finished on chain, unreadable, or never taken is dropped", () => {
  const noTerms = item("won"); noTerms.id = 240; noTerms.bet.envelope.bet_id = 240; (noTerms.bet.envelope as any).terms = null; (noTerms.bet.envelope as any).keep_terms = false;
  const noTaker = item("voided"); noTaker.id = 241; noTaker.bet.envelope.bet_id = 241; (noTaker.bet as any).taker = null; (noTaker.bet as any).outcome = "VOID_EMERGENCY";
  assert.deepEqual(ids(settledCards([noTerms, noTaker, item("live")], null, NOW, CTX)), []);
});

test("Settled card line: the ruling and who made it (AI judge, referee), then how it was paid", () => {
  const cards = settledCards(ALL(), null, NOW, CTX);
  assert.equal(sentence(cards, 208), "The AI judge ruled NO. @me won 39.00 USDC.");
  assert.equal(sentence(cards, 209), "The AI judge ruled YES. @erin won 39.00 USDC.");
  assert.equal(sentence(cards, 212), "@kim ruled YES. @me won 38.60 USDC.");
});

test("Settled card line: conceded and refunded endings say so (VOID by the AI, by the referee, nobody in time)", () => {
  const cards = settledCards(ALL(), null, NOW, CTX);
  assert.equal(sentence(cards, 211), "Ended NO by concession. @me conceded. @gina was paid 9.00 USDC.");
  assert.equal(sentence(cards, 210), "Ended VOID: nobody decided in time. Both sides were refunded.");
  const voidAi = item("won"); voidAi.id = 242; voidAi.bet.envelope.bet_id = 242; voidAi.bet.outcome = "VOID";
  const voidRef = item("referee-decided"); voidRef.id = 243; voidRef.bet.envelope.bet_id = 243; voidRef.bet.outcome = "VOID";
  const v = settledCards([voidAi, voidRef], null, NOW, CTX);
  assert.equal(sentence(v, 242), "The AI judge ruled VOID. Both sides got their stake back.");
  assert.equal(sentence(v, 243), "@kim ruled VOID. Both sides were refunded.");
});

test("Settled card line, my own bet: the same ruling words, with my result ('You won')", () => {
  const cards = settledCards([item("won"), item("conceded")], ME, NOW, CTX);
  assert.equal(sentence(cards, 208), "The AI judge ruled NO. You won 39.00 USDC.");
  assert.equal(sentence(cards, 211), "Ended NO by concession. You conceded. @gina was paid.");
  assert.equal(cards.find((c) => c.view.id === 208)!.view.pill.id, "won");
});

test("Settled card line: a refund still on its way is not called done", () => {
  const voided = item("voided");
  voided.pending = [{ id: 9, bet_id: 210, token_id: voided.bet.envelope.maker_asset, receiver: "frank.near", amount: "1", reason: "refund", attempts: 0, done: false, in_flight: true }];
  assert.equal(sentence(settledCards([voided], null, NOW, CTX), 210), "Ended VOID: nobody decided in time. Both stakes are on their way back.");
});

test("settledEnding: null for a bet that has not ended", () => {
  const live = item("live");
  assert.equal(settledEnding(betView(live.bet, null, NOW, CTX), live.bet), null);
  const old = item("won"); old.bet.envelope.funding_deadline = (NOW - 9 * DAY) * 1e6;
  assert.ok(settledEnding(betView(old.bet, null, NOW, CTX), old.bet)!.startsWith("The AI judge ruled NO."));
});

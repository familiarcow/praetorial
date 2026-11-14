// K0 (UIR1 §2): the one amount rule (lib/money.ts), the one date formatter (lib/dates.ts), the one bet phase (lib/betLifecycle.ts
// phaseOf) and the one bet view model + status wording (lib/betView.ts), checked against every fixture state (tests/fixtures/bets.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { money, formatMoney, moneyText, sumMoney } from "../lib/money";
import { relTime, exactTime, timeLeft } from "../lib/dates";
import { phaseOf, type PhaseId } from "../lib/betLifecycle";
import { betView, person, personLabel, shortId, changeToast, PILL_WORDS, type BetView } from "../lib/betView";
import { betFixtures, fixtureByKey, ME, ANON, NAMES, USDC, BTC, HOUR, DAY } from "./fixtures/bets";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const CONTRACT = "bets.praetorial.near";
const view = (key: string): BetView => {
  const f = fixtureByKey(NOW, key);
  return betView(f.bet, f.me, NOW, { names: NAMES, pending: f.pending ?? null, shutdown: f.shutdown ?? false, contractId: CONTRACT });
};

// ---------------------------------------------------------------- money (familiarcow UX-37 #7)
test("money: stablecoins always 2 dp, rounded half-up; never '$'", () => {
  assert.equal(moneyText(money(10_000_000n, "USDC")), "10.00 USDC");
  assert.equal(moneyText(money(1_005_000n, "USDC")), "1.01 USDC");
  assert.equal(moneyText(money(1_004_999n, "USDT")), "1.00 USDT");
  assert.equal(moneyText(money(0n, "USDC")), "0.00 USDC");
  assert.equal(moneyText(money("1234567891000", "USDC")), "1,234,567.89 USDC");
  assert.ok(!moneyText(money(1n, "USDC")).includes("$"));
});

test("money: other tokens trimmed to at most 6 significant digits, integer digits never dropped", () => {
  assert.equal(moneyText(money((10n * 10n ** 24n).toString(), "NEAR")), "10 NEAR");
  assert.equal(moneyText(money("39600", "BTC")), "0.000396 BTC");
  assert.equal(moneyText(money("12345678", "BTC")), "0.123457 BTC");
  assert.equal(moneyText(money("1234567891200000000000000000", "NEAR")), "1,234.57 NEAR");
  assert.equal(moneyText(money("1234567800000000000000000000000", "NEAR")), "1,234,568 NEAR");
  assert.equal(moneyText(money("999999950000000000", "ETH")), "1 ETH");
});

test("money: tiny amounts read '< 0.01', the exact value is kept for Details", () => {
  const storage = formatMoney(money("1654", "NEAR"), { minor: true });
  assert.equal(storage.text, "< 0.01 NEAR");
  assert.equal(storage.tiny, true);
  assert.equal(storage.exact, "0.000000000000000000001654 NEAR");
  const fee = formatMoney(money("4000", "USDC"));
  assert.equal(fee.text, "< 0.01 USDC");
  assert.equal(fee.exact, "0.004 USDC");
  // a real stake in a non-stable token is never hidden behind "< 0.01"
  assert.equal(moneyText(money("20000", "BTC")), "0.0002 BTC");
  assert.equal(formatMoney(money("1000000000000000001", "ETH")).exact, "1.000000000000000001 ETH");
});

test("money: asset ids resolve to symbols; unknown assets never throw", () => {
  assert.equal(money("39600", BTC).symbol, "BTC");
  assert.equal(money("1", USDC).symbol, "USDC");
  assert.match(moneyText(money("5", "nep141:mystery.near")), /^5 /);
  assert.equal(sumMoney([money(1_000_000n, "USDC"), money(2_500_000n, USDC), money("39600", "BTC")]).map((m) => moneyText(m)).join(" + "), "3.50 USDC + 0.000396 BTC");
});

// ---------------------------------------------------------------- dates (familiarcow UX-37 #6)
test("dates: relative words, seconds only in the last minute", () => {
  assert.equal(relTime(NOW + 6 * DAY + HOUR, NOW), "in 6 days");
  assert.equal(relTime(NOW + DAY + HOUR, NOW), "in 1 day");
  assert.equal(relTime(NOW + 18 * HOUR + 5 * 60_000, NOW), "in 18 h");
  assert.equal(relTime(NOW + 45 * 60_000, NOW), "in 45 min");
  assert.equal(relTime(NOW + 30_000, NOW), "in 30 s");
  assert.equal(relTime(NOW - 2 * DAY, NOW), "2 days ago");
  assert.equal(relTime(NOW - 5 * HOUR, NOW), "5 h ago");
  assert.equal(relTime(NOW + 90 * DAY, NOW), "in 3 months");
  assert.equal(relTime(NOW + 800 * DAY, NOW), "in 2 years");
  assert.equal(relTime(NOW, NOW), "now");
});

test("dates: exact local + UTC for the tap/tooltip", () => {
  const at = Date.UTC(2026, 10, 17, 5, 28);
  const e = exactTime(at, { locale: "en-GB", timeZone: "America/New_York" });
  assert.equal(e.utc, "17 Nov 2026, 05:28 UTC");
  assert.match(e.local, /17 Nov 2026/);
  assert.match(e.local, /00:28/);
  assert.equal(e.iso, "2026-11-17T05:28:00.000Z");
});

test("dates: timeLeft labels future/past and marks the last hour urgent", () => {
  assert.deepEqual(timeLeft({ at: NOW + 2 * DAY, now: NOW, future: "Closes", past: "Closed" }), { text: "Closes in 2 days", urgent: false, past: false });
  assert.deepEqual(timeLeft({ at: NOW + 20 * 60_000, now: NOW, future: "Final" }), { text: "Final in 20 min", urgent: true, past: false });
  assert.deepEqual(timeLeft({ at: NOW - DAY, now: NOW, future: "Closes", past: "Closed" }), { text: "Closed 1 day ago", urgent: false, past: true });
});

// ---------------------------------------------------------------- people (familiarcow: usernames are the identity)
test("people: You / @username / 'Unnamed account' (SM2 PEOPLE RULE: never a raw id)", () => {
  assert.equal(shortId(ANON), "a1b2…f9e0");
  assert.equal(personLabel(person(ME, ME, NAMES)), "You");
  assert.equal(personLabel(person("bob.near", ME, NAMES)), "@bob");
  assert.equal(personLabel(person(ANON, ME, NAMES)), "Unnamed account");
  assert.equal(personLabel(person("judge.near", ME, NAMES)), "Unnamed account");
  assert.equal(personLabel(person("a-very-long-named-account-id-here.near", null, {})), "Unnamed account");
  assert.equal(personLabel(person(ME, null, NAMES)), "@familiarcow");
});

// ---------------------------------------------------------------- the one phase (LIFE1 / SM1 root cause #1)
const PHASES: Record<string, PhaseId> = {
  "open-mine": "open", "open-theirs": "open", "open-lapsed": "open-lapsed", live: "live", "awaiting-result": "awaiting-result",
  judging: "judging", "ruling-lost": "ruling", "ruling-won": "ruling", "ruling-final": "ruling-final", challenged: "challenged",
  rejudge: "challenged", paying: "paying", "payout-stuck": "paying", won: "settled", lost: "settled", voided: "refunded",
  conceded: "settled", "referee-decided": "settled", expired: "expired", cancelled: "cancelled", "referee-ready": "awaiting-referee",
  "referee-waiting": "awaiting-referee", "referee-legacy": "awaiting-referee", stuck: "stuck", "no-result": "no-result", shutdown: "live", "no-terms": "open",
};

test("phaseOf: every fixture maps to exactly one phase", () => {
  const fx = betFixtures(NOW);
  assert.deepEqual(fx.map((f) => f.key).sort(), Object.keys(PHASES).sort(), "a fixture without an expected phase (or the reverse)");
  for (const f of fx) assert.equal(phaseOf(f.bet, NOW * 1e6, CONTRACT), PHASES[f.key], f.key);
});

test("phaseOf: follows the contract gates at the edges (finalize window, funding deadline, resolve deadline)", () => {
  const r = fixtureByKey(NOW, "ruling-lost").bet; // proposed 5 h ago, 24 h window
  assert.equal(phaseOf(r, (NOW + 18 * HOUR) * 1e6, CONTRACT), "ruling");
  assert.equal(phaseOf(r, (NOW + 19 * HOUR + 1) * 1e6, CONTRACT), "ruling-final");
  const o = fixtureByKey(NOW, "open-theirs").bet; // closes in 2 days
  assert.equal(phaseOf(o, (NOW + 2 * DAY + 1) * 1e6, CONTRACT), "open-lapsed");
  const t = fixtureByKey(NOW, "live").bet;
  assert.equal(phaseOf(t, (NOW + 3 * DAY) * 1e6, CONTRACT), "awaiting-result");
  assert.equal(phaseOf(t, (NOW + 31 * DAY) * 1e6, CONTRACT), "refund-due");
});

// ---------------------------------------------------------------- the one view model (UIR1 §3.5 table)
const PILLS: Record<string, string> = {
  "open-mine": "Open", "open-theirs": "Open", "open-lapsed": "Closed", live: "Live", "awaiting-result": "Waiting for result",
  judging: "AI is deciding", "ruling-lost": "Ruling made", "ruling-won": "Ruling made", "ruling-final": "Final", challenged: "Being re-checked",
  rejudge: "Being re-checked", paying: "Paying out", "payout-stuck": "Payout delayed", won: "Won", lost: "Lost", voided: "Refunded",
  conceded: "Conceded", "referee-decided": "Won", expired: "Expired", cancelled: "Cancelled", "referee-ready": "You decide",
  "referee-waiting": "Waiting for referee", "referee-legacy": "Waiting for referee", stuck: "Stuck", "no-result": "No result", shutdown: "Refund available", "no-terms": "Open",
};
const PRIMARY: Record<string, string | null> = {
  "open-mine": "share", "open-theirs": "take", "open-lapsed": null, live: null, "awaiting-result": "request-result", judging: null,
  "ruling-lost": "challenge", "ruling-won": null, "ruling-final": "finalize", challenged: null, rejudge: null, paying: null,
  "payout-stuck": "retry-payout", won: null, lost: null, voided: null, conceded: null, "referee-decided": null, expired: null,
  cancelled: null, "referee-ready": "rule", "referee-waiting": null, "referee-legacy": null, stuck: null, "no-result": null, shutdown: "refund-all", "no-terms": "take",
};

test("betView: one pill wording and one primary action per state", () => {
  for (const f of betFixtures(NOW)) {
    const v = view(f.key);
    assert.equal(v.pill.label, PILLS[f.key], `pill ${f.key}`);
    assert.equal(v.primary?.id ?? null, PRIMARY[f.key], `primary ${f.key}`);
    assert.ok(Object.values(PILL_WORDS).some((w) => w.label === v.pill.label || v.pill.label.startsWith("Waiting for")), `pill ${f.key} not from PILL_WORDS`);
    assert.ok(v.sentence.length > 0, `sentence ${f.key}`);
    assert.ok(!v.secondary.some((a) => a.id === v.primary?.id), `primary repeated in More actions ${f.key}`);
  }
});

test("betView: More actions per state", () => {
  const ids = (k: string) => view(k).secondary.map((a) => a.id);
  assert.deepEqual(ids("open-mine"), ["cancel", "change-referee", "duplicate"]);
  assert.deepEqual(ids("live"), ["concede", "change-referee"]);
  assert.deepEqual(ids("ruling-lost"), ["concede"]);
  // LFIX1 (SM1 LIFE-11): ME is the maker and the standing ruling (YES) is ME's side, so conceding would hand bob the pot mid-re-judge.
  assert.deepEqual(ids("challenged"), ["add-evidence"]);
  assert.deepEqual(ids("won"), ["duplicate", "new-bet"]);
  assert.deepEqual(ids("stuck"), ["concede"]);
  assert.deepEqual(ids("referee-ready"), []);
  assert.deepEqual(ids("shutdown"), []);
});

test("betView: no raw 64-hex account id outside Details' account rows", () => {
  for (const f of betFixtures(NOW)) {
    const v = view(f.key);
    // Person objects carry the account (UserChip needs it for the tooltip); every string a person reads must not.
    const shown = JSON.stringify({ q: v.question, h: v.headline, s: v.sentence, p: v.pill, n: v.next, a: v.activity, pr: v.primary, se: v.secondary,
      r: v.ruling && { ...v.ruling, who: undefined }, pay: v.payout && { ...v.payout, rows: v.payout.rows.map((r) => r.label) } });
    for (const id of [ME, ANON]) assert.ok(!shown.includes(id), `${f.key} shows a raw id: ${shown}`);
    assert.ok(v.details.some((d) => d.id === "bet"), `${f.key} details has the bet number`);
  }
});

test("betView: the people, the sides and the stakes", () => {
  const live = view("live");
  assert.equal(live.role, "maker");
  assert.equal(live.me.side, "YES");
  assert.equal(personLabel(live.them.who!), "@lee");
  assert.equal(moneyText(live.me.stake!), "10 NEAR");
  assert.deepEqual(live.decider, { kind: "ai" });
  const ref = view("referee-waiting");
  assert.equal(ref.decider.kind, "person");
  assert.equal(ref.decider.kind === "person" && personLabel(ref.decider.who), "@kim");
  const legacy = view("referee-legacy");
  assert.equal(legacy.decider.kind === "person" && personLabel(legacy.decider.who), "Unnamed account");
  const offer = view("open-theirs");
  assert.equal(offer.role, "viewer");
  assert.equal(offer.sentence, "You put in 40.00 USDC to win 50.00 USDC.");
  assert.equal(view("referee-ready").role, "referee");
  assert.equal(view("no-terms").question, "Terms not available");
  assert.equal(view("live").question, "The Lakers beat the Celtics on 14 Nov 2026 (ESPN final score).");
});

test("betView: next deadline is relative with the exact time kept", () => {
  const n = view("ruling-lost").next!;
  assert.equal(n.label, "Final");
  assert.equal(n.at, NOW - 5 * HOUR + DAY);
  assert.equal(view("open-mine").next!.label, "Closes");
  assert.equal(view("won").next, null);
});

test("betView: ruling and payout cards", () => {
  const r = view("ruling-lost").ruling!;
  assert.equal(r.kind, "ai");
  assert.equal(r.outcome, "YES");
  assert.equal(r.evidence[0]!.sourceName, "Coinbase BTC-USD");
  const p = view("referee-decided").ruling!;
  assert.equal(p.kind, "person");
  assert.equal(p.kind === "person" && personLabel(p.who), "@kim");
  assert.equal(view("voided").ruling?.outcome ?? "VOID", "VOID");
  const won = view("won").payout!;
  assert.equal(won.ending, "won");
  assert.equal(won.headline, "You won 39.00 USDC.");
  assert.equal(won.state, "paid");
  const stuck = view("payout-stuck").payout!;
  assert.equal(stuck.state, "slow");
  assert.equal(stuck.canRetry, true);
  assert.equal(view("lost").payout!.headline, "You lost 20.00 USDC.");
  assert.equal(view("lost").payout!.rows.some((r) => r.toMe), false, "a loss never shows the winner's amount as mine");
  assert.equal(view("payout-stuck").payout!.headline, "You won 0.000396 BTC.");
  // a fee floor that eats the whole stake leaves nothing to name: never "You won ."
  const f = fixtureByKey(NOW, "won");
  const eaten = betView({ ...f.bet, fee_min_maker: "99000000", fee_min_taker: "99000000" } as any, f.me, NOW, { names: NAMES, pending: [], contractId: CONTRACT });
  assert.equal(eaten.payout!.headline, "You won.");
  assert.equal(view("conceded").payout!.headline, "You conceded. @gina was paid.");
  assert.equal(view("live").payout, null);
});

test("betView: Activity holds the full history, oldest first, with names", () => {
  const a = view("challenged").activity.map((e) => e.text);
  assert.deepEqual(a, [
    "You made this bet on YES with 25 NEAR.",
    "@bob took it on NO with 25 NEAR.",
    "The AI ruled YES.",
    "@bob challenged the ruling (round 1).",
    "@bob added evidence.",
  ]);
  assert.equal(view("won").activity.at(-1)!.text, "Paid out.");
  assert.equal(view("expired").activity.at(-1)!.text, "Nobody took it. The stake went back to you.");
});

test("CS1 (testnet bet 49): Activity keeps the challenge and the AI's second look, before and after the payout", () => {
  // finalize mem::takes bet.bonds; challenged_by and all_results (decisive rulings only, RETRY is never stored) survive.
  const f = fixtureByKey(NOW, "challenged");
  const yes = (run_no: number) => ({ run_no, outcome: "YES", element_results_hash: "00", checked_until: "0" });
  const texts = (b: any) => betView(b, f.me, NOW, { names: NAMES, pending: [], contractId: CONTRACT }).activity.map((e) => e.text);
  const rejudged = { ...f.bet, status: "Proposed", exhibits: [], all_results: [yes(9), yes(10)] } as any;
  assert.deepEqual(texts(rejudged).slice(2), [
    "The AI ruled YES.",
    "@bob challenged the ruling (round 1).",
    "The AI looked again and ruled YES again.",
  ]);
  const settled = { ...rejudged, status: "Settled", bonds: [] } as any;
  assert.deepEqual(texts(settled).slice(2), [
    "The AI ruled YES.",
    "@bob challenged the ruling.",
    "The AI looked again and ruled YES again.",
    "The result is final.",
    "Paid out.",
  ]);
  const flipped = { ...settled, outcome: "NO", all_results: [yes(9), { ...yes(10), outcome: "NO" }] } as any;
  assert.deepEqual(texts(flipped).slice(2, 5), ["The AI ruled YES.", "@bob challenged the ruling.", "The AI looked again and changed the ruling to NO."]);
});

test("CS1 (testnet bet 53): a bet that ended before its challenge window ran out shows no 'Challenge window ends' row", () => {
  const f = fixtureByKey(NOW, "challenged");
  const rows = (b: any) => betView(b, f.me, NOW, { names: NAMES, pending: [], contractId: CONTRACT }).details.map((r) => r.id);
  // @kim_ref ruled 12 s ago and the escrow paid out at once: the window (proposed_at + settlement_period) is in the future.
  const refereeSettled = { ...f.bet, status: "Settled", bonds: [], exhibits: [], challenged_by: null, proposed_at: (NOW - 12_000) * 1e6,
    envelope: { ...f.bet.envelope, referee: { account: "kim.near", mode: "Human" } } } as any;
  assert.ok(!rows(refereeSettled).includes("challenge-window"));
  // still shown while the window is open, and after an AI ruling whose window really ran out
  assert.ok(rows({ ...refereeSettled, status: "Proposed", envelope: f.bet.envelope }).includes("challenge-window"));
  assert.ok(rows({ ...refereeSettled, envelope: f.bet.envelope, proposed_at: (NOW - 2 * DAY) * 1e6 }).includes("challenge-window"));
});

test("changeToast: a toast only when the shown state changes", () => {
  const a = fixtureByKey(NOW, "ruling-lost");
  const before = betView(a.bet, a.me, NOW, { names: NAMES, contractId: CONTRACT });
  const later = betView({ ...a.bet, status: "Challenged", bonds: [{ holder: ME, amount: "1", round: 1, pre_challenge_outcome: "YES", asset: USDC }] }, a.me, NOW, { names: NAMES, contractId: CONTRACT });
  assert.equal(changeToast(before, before), null);
  assert.equal(changeToast(before, later), "Update: Being re-checked.");
});

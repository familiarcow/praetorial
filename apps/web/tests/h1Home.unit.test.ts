// H1 (UIR1 §3.2/§3.3, familiarcow UX-37 #2/#3/#4, PEOPLE RULE, SM2 H1-1/H1-2): the Home model. Every card is a BetView (lib/betView.ts),
// so the pill, the sentence and the one action come from the same place as the bet page. Pure: HomePage / MyBets / BrowsePage /
// InProgressBets only load and render what these return.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  myHome, needsMe, extraReads, exploreCards, inProgressCards, settledSummary, filterChips, homeAccounts, IN_PROGRESS_STATUSES, IN_PROGRESS_LIMIT,
  inProgressCandidates, type HomeBet,
} from "../lib/homeSections";
import { betView, personLabel } from "../lib/betView";
import { money } from "../lib/money";
import { listEnabledAssets } from "../lib/assets";
import { betFixtures, fixtureByKey, ME, USDC, NEAR, DAY, HOUR, usdc, FIXTURE_CONTRACT } from "./fixtures/bets";

const NOW = Date.UTC(2026, 10, 11, 12);
const CTX = { contractId: FIXTURE_CONTRACT };
const item = (key: string): HomeBet => { const f = fixtureByKey(NOW, key); return { id: f.id, bet: f.bet, pending: f.pending ?? null }; };
const mine = () => betFixtures(NOW).filter((f) => f.me === ME && !f.shutdown && f.key !== "no-terms").map((f) => ({ id: f.id, bet: f.bet, pending: f.pending ?? null }));
const ids = (cards: { view: { id: number } }[]) => cards.map((c) => c.view.id);
const clone = <T,>(x: T): T => structuredClone(x);
const theirs = (id: number, o: { maker?: string; taker?: string | null; status?: string; referee?: string | null; asset?: string; fundingMs?: number; claim?: string } = {}): HomeBet => {
  const b = clone(fixtureByKey(NOW, "open-theirs").bet) as any;
  b.envelope.bet_id = id; b.envelope.maker = o.maker ?? "alice.near";
  if (o.asset) { b.envelope.maker_asset = o.asset; b.envelope.taker_asset = o.asset; b.envelope.stake_maker = "1000000000000000000000000"; b.envelope.stake_taker = "1000000000000000000000000"; }
  if (o.referee !== undefined) b.envelope.referee = o.referee ? { account: o.referee, mode: "Human" } : null;
  if (o.fundingMs !== undefined) b.envelope.funding_deadline = o.fundingMs * 1e6;
  b.status = o.status ?? "Open"; b.taker = o.taker === undefined ? null : o.taker;
  if (b.taker) b.taken_at = (NOW - DAY) * 1e6;
  return { id, bet: b, pending: null };
};

// ---------------------------------------------------------------- My Bets
test("My Bets: 'Needs you' first, then Open offers, In progress, Bets you decide; Settled is kept apart (collapsed); each bet once", () => {
  const h = myHome(mine(), ME, NOW, CTX);
  assert.deepEqual(h.groups.map((g) => g.id), ["needs", "open", "progress"]); // no bet names me referee without needing me
  assert.deepEqual(h.groups.map((g) => g.title), ["Needs you", "Open offers", "In progress"]);
  const all = [...h.groups.flatMap((g) => ids(g.cards)), ...ids(h.settled!.cards)];
  assert.equal(new Set(all).size, all.length, "a bet is listed once");
  assert.deepEqual(ids(h.settled!.cards).sort(), [208, 209, 210, 211, 212, 213, 214]);
  assert.ok(h.settled!.cards.every((c) => c.variant === "compact"));
  assert.deepEqual(ids(h.groups.find((g) => g.id === "open")!.cards), [230, 201], "newest first");
});

test("Needs you: exactly the bets whose page asks something of me now (challenge, retry payout, rule), with that one button", () => {
  const h = myHome(mine(), ME, NOW, CTX);
  const needs = h.groups.find((g) => g.id === "needs")!;
  assert.deepEqual(ids(needs.cards).sort(), [205, 216, 217]);
  const by = (id: number) => needs.cards.find((c) => c.view.id === id)!;
  assert.equal(by(205).view.primary!.id, "challenge");
  assert.equal(by(216).view.primary!.id, "retry-payout");
  assert.equal(by(217).view.primary!.id, "rule");
  assert.equal(by(217).variant, "decide", "I only referee 217");
  assert.equal(by(205).variant, "mine");
  // I won the ruling (231), the payout is in flight (207), the AI is deciding (204): nothing for me to do.
  for (const id of [231, 207, 204]) assert.ok(!ids(needs.cards).includes(id), `${id} does not need me`);
});

test("Cards that don't need me carry no button (Share / Duplicate / Finalize never on a Home card; Duplicate lives in the bet page's More actions)", () => {
  const h = myHome(mine(), ME, NOW, CTX);
  for (const g of h.groups.filter((g) => g.id !== "needs")) for (const c of g.cards) assert.equal(c.view.primary, null, `${g.id} ${c.view.id}`);
  for (const c of h.settled!.cards) assert.equal(c.view.primary, null);
  const actions = [...h.groups.flatMap((g) => g.cards), ...h.settled!.cards].map((c) => c.view.primary?.id).filter(Boolean);
  assert.ok(!actions.includes("duplicate") && !actions.includes("share"));
});

test("Needs you: an offer made to me by name (Take); a lapsed one is not shown; a referee change waiting for my answer", () => {
  const direct = theirs(300, { fundingMs: NOW + DAY }); (direct.bet.envelope as any).taker_allow = { Account: ME };
  const h = myHome([direct], ME, NOW, CTX);
  assert.deepEqual(h.groups.map((g) => g.id), ["needs"]);
  assert.equal(h.groups[0]!.cards[0]!.view.primary!.id, "take");
  const lapsed = theirs(301, { fundingMs: NOW - HOUR }); (lapsed.bet.envelope as any).taker_allow = { Account: ME };
  assert.deepEqual(myHome([lapsed], ME, NOW, CTX).groups, []);

  const live = item("live");
  (live.bet as any).referee_proposal = { maker_value: null, taker_value: JSON.stringify({ account: "kim.near", mode: "Human" }) };
  const g = myHome([live], ME, NOW, CTX).groups;
  assert.equal(g[0]!.id, "needs");
  assert.deepEqual(g[0]!.cards[0]!.view.primary, { id: "change-referee", label: "Answer the referee change", kind: "primary" });
  // I already answered: nothing to do
  (live.bet as any).referee_proposal = { maker_value: JSON.stringify({ account: "kim.near", mode: "Human" }), taker_value: null };
  assert.equal(myHome([live], ME, NOW, CTX).groups[0]!.id, "progress");
});

test("Shutdown: my unfinished bets need me (Refund everyone); finished ones don't", () => {
  const h = myHome([item("live"), item("won")], ME, NOW, { ...CTX, shutdown: true });
  assert.deepEqual(ids(h.groups[0]!.cards), [203]);
  assert.equal(h.groups[0]!.cards[0]!.view.primary!.id, "refund-all");
  assert.deepEqual(ids(h.settled!.cards), [208]);
});

test("Settled: one summary row 'Settled (N)' + 'won 2 · lost 1 · refunded 3' in a fixed order, zero counts left out", () => {
  const h = myHome(mine(), ME, NOW, CTX);
  assert.equal(h.settled!.title, "Settled (7)");
  const v = (key: string) => betView(fixtureByKey(NOW, key).bet, ME, NOW, { contractId: FIXTURE_CONTRACT, pending: [] });
  assert.equal(settledSummary([v("won"), v("won"), v("lost"), v("voided"), v("expired"), v("cancelled")]), "won 2 · lost 1 · refunded 1 · cancelled 1 · expired 1");
  assert.equal(settledSummary([]), "");
  assert.equal(myHome([item("live")], ME, NOW, CTX).settled, null);
});

test("Bets you decide: bets that name me referee and need nothing yet; their finished ones go to Settled", () => {
  const early = theirs(310, { status: "Taken", taker: "bob.near", referee: ME, fundingMs: NOW + 2 * DAY });
  const done = theirs(311, { status: "Settled", taker: "bob.near", referee: ME }); (done.bet as any).outcome = "YES"; (done.bet as any).proposed_at = (NOW - DAY) * 1e6;
  const h = myHome([early, done, item("referee-ready")], ME, NOW, CTX);
  assert.deepEqual(h.groups.map((g) => [g.id, ids(g.cards)]), [["needs", [217]], ["decide", [310]]]);
  assert.equal(h.groups[1]!.cards[0]!.variant, "decide");
  assert.deepEqual(ids(h.settled!.cards), [311]);
});

test("Not mine and not my referee (e.g. someone else's offer): not listed under My Bets", () => {
  assert.deepEqual(myHome([theirs(320), theirs(321, { status: "Taken", taker: "bob.near" })], ME, NOW, CTX), { groups: [], settled: null, empty: true });
  assert.equal(myHome(mine(), ME, NOW, CTX).empty, false);
});

test("people are @usernames from the names map (PEOPLE RULE); unnamed people are 'Unnamed account', never an id", () => {
  const h = myHome([item("ruling-lost")], ME, NOW, { ...CTX, names: { "carol.near": "carol" } });
  const v = h.groups[0]!.cards[0]!.view;
  assert.equal(v.them.who!.username, "carol");
  assert.equal(v.them.who!.isMe, false);
  assert.ok(!JSON.stringify([v.sentence, v.headline, v.pill.label]).includes("carol.near"));
  const offer = exploreCards([theirs(330)], ME, NOW, CTX)[0]!.view; // no names map entry: unnamed, never the id
  assert.equal(personLabel(offer.maker.who!), "Unnamed account");
});

test("extra reads only where the view needs them: pending payouts while paying, the challenge bond for a bettor inside the window", () => {
  const r = (key: string, me: string | null = ME) => extraReads(fixtureByKey(NOW, key).bet, me, NOW, FIXTURE_CONTRACT);
  assert.deepEqual(r("payout-stuck"), { pending: true, bond: false });
  assert.deepEqual(r("ruling-lost"), { pending: false, bond: true });
  assert.deepEqual(r("ruling-lost", "zed.near"), { pending: false, bond: false });
  assert.deepEqual(r("live"), { pending: false, bond: false });
  assert.deepEqual(r("won"), { pending: false, bond: false });
});

test("needsMe: null for a viewer with nothing to do; the bond quote 'no more rounds' (null) means no Challenge", () => {
  const f = fixtureByKey(NOW, "ruling-lost");
  assert.equal(needsMe(betView(f.bet, ME, NOW, { contractId: FIXTURE_CONTRACT }), f.bet, ME)!.id, "challenge");
  assert.equal(needsMe(betView(f.bet, ME, NOW, { contractId: FIXTURE_CONTRACT, bond: null }), f.bet, ME), null);
  assert.equal(needsMe(betView(f.bet, ME, NOW, { contractId: FIXTURE_CONTRACT, bond: money(usdc(2), USDC) }), f.bet, ME)!.hint, "2.00 USDC bond. You get it back if you win.");
  assert.equal(needsMe(betView(f.bet, "zed.near", NOW, { contractId: FIXTURE_CONTRACT }), f.bet, "zed.near"), null);
  const offer = fixtureByKey(NOW, "open-theirs").bet;
  assert.equal(needsMe(betView(offer, ME, NOW, { contractId: FIXTURE_CONTRACT }), offer, ME), null, "an open offer to anyone doesn't need me");
});

// ---------------------------------------------------------------- Explore
test("Explore: other people's open offers that can still be taken, as 'offer' cards with the Take button; newest first", () => {
  const cards = exploreCards([theirs(400), theirs(401, { maker: ME }), theirs(402, { fundingMs: NOW - HOUR }), theirs(403)], ME, NOW, CTX);
  assert.deepEqual(ids(cards), [403, 400]);
  assert.ok(cards.every((c) => c.variant === "offer" && c.view.primary?.id === "take"));
  assert.deepEqual(ids(exploreCards([theirs(400), theirs(401, { maker: ME })], null, NOW, CTX)), [401, 400], "logged out: every offer");
});

test("Explore: an offer I referee is not mine to take; a taken or unreadable one is dropped", () => {
  const noTerms = theirs(412); (noTerms.bet.envelope as any).terms = null;
  assert.deepEqual(ids(exploreCards([theirs(410, { referee: ME }), theirs(411, { status: "Taken", taker: "bob.near" }), noTerms], ME, NOW, CTX)), []);
});

test("Explore filter chips: All + this network's bet tokens (mainnet: the six), launch order; a chip keeps offers staking that token on either side", () => {
  assert.deepEqual(filterChips(), ["all", ...listEnabledAssets().map((a) => a.symbol)]);
  assert.ok(filterChips().slice(1).every((s) => ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"].includes(s)));
  const items = [theirs(420), theirs(421, { asset: NEAR })];
  assert.deepEqual(ids(exploreCards(items, ME, NOW, CTX, "NEAR")), [421]);
  assert.deepEqual(ids(exploreCards(items, ME, NOW, CTX, "USDC")), [420]);
  assert.deepEqual(ids(exploreCards(items, ME, NOW, CTX, "all")), [421, 420]);
});

// ---------------------------------------------------------------- In progress
test("In progress: only other people's accepted, unfinished bets (mine and the ones I referee are under My Bets), as read-only 'public' cards", () => {
  const items = [
    theirs(500, { status: "Taken", taker: "bob.near" }),
    theirs(501, { status: "Taken", taker: ME }),
    theirs(502, { status: "Taken", taker: "bob.near", referee: ME }),
    theirs(503, { status: "Open" }),
    item("won"),
    theirs(504, { status: "Taken", taker: "bob.near", maker: "ivy.near" }),
  ];
  const cards = inProgressCards(items, ME, NOW, CTX);
  assert.deepEqual(ids(cards), [504, 500]);
  assert.ok(cards.every((c) => c.variant === "public" && c.view.primary === null));
  assert.deepEqual(ids(inProgressCards(items, null, NOW, CTX)), [504, 502, 501, 500], "logged out: everyone's");
});

test("In progress candidates: accepted statuses from the indexer, newest first, deduped, capped, hide list applied", () => {
  assert.deepEqual([...IN_PROGRESS_STATUSES], ["Taken", "Resolving", "Proposed", "Challenged", "Evidence", "Rejudge", "Finalized"]);
  const h = [{ bet_id: 1, status: "Open" }, { bet_id: 2, status: "Taken" }, { bet_id: 3, status: "Settled" }, { bet_id: 4, status: "Proposed" }, { bet_id: 6, status: "Finalized" }, { bet_id: 4, status: "Proposed" }];
  assert.deepEqual(inProgressCandidates(h), [6, 4, 2]);
  assert.deepEqual(inProgressCandidates(h, IN_PROGRESS_LIMIT, new Set([4])), [6, 2]);
  assert.equal(inProgressCandidates(Array.from({ length: 50 }, (_, i) => ({ bet_id: i, status: "Taken" }))).length, IN_PROGRESS_LIMIT);
});

// ---------------------------------------------------------------- names
test("homeAccounts: everyone a Home card can name (maker, taker, referee), once", () => {
  assert.deepEqual(homeAccounts([theirs(600, { status: "Taken", taker: "bob.near", referee: "kim.near" }), theirs(601)]).sort(), ["alice.near", "bob.near", "kim.near"]);
});

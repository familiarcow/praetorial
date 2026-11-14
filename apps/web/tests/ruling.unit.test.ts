// FE11 (S13): AI ruling card, quotes + sources, VOID wording, challenge offer (bond quote, rounds, no more appeals), finalize, challenge read-back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEvidence, rulingCard, challengeOffer, bondBalanceRefusal, finalizeOffer, finalizedLine, challengeRoundLabel, confirmChallenge } from "../lib/ruling";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
const NOW = Date.UTC(2037, 0, 3, 12, 0) ;
const terms = JSON.stringify({ claim: "x", sources_allowed: [{ id: "S_NWS", publisher: "NWS weather.gov CLI KNYC", url: "https://forecast.weather.gov/x" }, { id: "S_IEM", publisher: "IEM", url: "https://mesonet.example/y" }] });
const diag = (o: object) => ({ content_head: JSON.stringify(o), model: "m1" });
const raw = JSON.stringify({ judge: { run_diagnostics: [diag({ answer: "met", quote: "YESTERDAY MAXIMUM 72", source_id: "S_NWS", reason: "72 is above 70" }), { content_head: "{\"answer\": \"met\", \"quo", model: "m2" }] }, result: { outcome: "YES" } });
const bet = (o: any = {}) => ({
  envelope: { maker: "maker.testnet", maker_side: "YES", outcomes: ["YES", "NO"], referee: null, maker_asset: "nep141:usdc.testnet", taker_asset: "nep141:usdc.testnet", terms, settlement_period: 3_600_000_000_000, ...(o.env ?? {}) },
  status: "Proposed", taker: "taker.testnet", bonds: [], outcome: "YES", proposed_at: (NOW - 600_000) * 1_000_000, window_extension_ns: 0, exhibits: [], last_resolution_raw: raw, ...o.rest,
}) as any;
const quote = { amount: "4000000", asset: "nep141:usdc.testnet" };

test("parseEvidence: quotes with their source name and url; a truncated judge reply is skipped, not shown", () => {
  const ev = parseEvidence(raw, terms);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].quote, ev[0].sourceId, ev[0].sourceName, ev[0].url], ["YESTERDAY MAXIMUM 72", "S_NWS", "NWS weather.gov CLI KNYC", "https://forecast.weather.gov/x"]);
  assert.deepEqual(parseEvidence(null, terms), []);
  assert.deepEqual(parseEvidence("not json", terms), []);
});

test("parseEvidence: a source id missing from the terms still shows the id, never an invented name", () => {
  const ev = parseEvidence(JSON.stringify({ judge: { run_diagnostics: [diag({ answer: "met", quote: "abc def ghi", source_id: "S_ZZ" })] } }), terms);
  assert.equal(ev[0].sourceName, "S_ZZ");
  assert.equal(ev[0].url, null);
});

test("ruling card: YES/NO names the winner side and the deadline for challenging", () => {
  const c: any = rulingCard(bet(), "taker.testnet", NOW);
  assert.equal(c.kind, "ruling");
  assert.equal(c.outcome, "YES");
  assert.match(c.headline, /Ruling: YES/);
  assert.match(c.finalLine, /^Final unless someone challenges before 2037-01-03 12:50 UTC\.$/);
  assert.equal(c.evidence.length, 1);
});

test("VOID ruling: copy never implies a winner or loser, for VOID and VOID:<reason>", () => {
  for (const o of ["VOID", "VOID:source_conflict"]) {
    const c: any = rulingCard(bet({ rest: { outcome: o } }), "taker.testnet", NOW);
    assert.equal(c.outcome, "VOID");
    assert.match(c.body, /The AI couldn't settle this fairly\. You'll both get your money back\./);
    assert.doesNotMatch(JSON.stringify(c), /win|won|lose|lost|loser|paid to/i);
  }
});

test("ruling card is absent before a ruling exists and for human-referee bets", () => {
  assert.equal(rulingCard(bet({ rest: { status: "Taken", outcome: null } }), null, NOW).kind, "none");
  assert.equal(rulingCard(bet({ env: { referee: { account: "r.testnet", mode: "Human" } } }), null, NOW).kind, "none");
});

test("round labels", () => {
  assert.equal(challengeRoundLabel(1), "Round 1: Review");
  assert.equal(challengeRoundLabel(2), "Round 2: Final appeal");
});

test("challenge offer: only the side that lost may challenge a YES/NO ruling; the bond line comes from the quote", () => {
  const taker: any = challengeOffer(bet(), "taker.testnet", quote, NOW);
  assert.equal(taker.kind, "available");
  assert.equal(taker.round, 1);
  assert.equal(taker.bondLine, "Challenging costs a bond of 4 USDC. You get it back if you win the challenge.");
  assert.equal(challengeOffer(bet(), "maker.testnet", quote, NOW).kind, "hidden"); // maker's side YES won
  assert.equal(challengeOffer(bet(), "stranger.testnet", quote, NOW).kind, "hidden");
  assert.equal(challengeOffer(bet(), null, quote, NOW).kind, "hidden");
});

test("challenge offer: in a VOID either side may challenge", () => {
  const b = bet({ rest: { outcome: "VOID" } });
  assert.equal(challengeOffer(b, "maker.testnet", quote, NOW).kind, "available");
  assert.equal(challengeOffer(b, "taker.testnet", quote, NOW).kind, "available");
});

test("challenge offer: round 2 is the final appeal; after it, no more appeals; closed window; human referee has none", () => {
  const one = { holder: "taker.testnet", amount: "1", round: 1, pre_challenge_outcome: "YES", asset: "a" };
  // LFIX1: round 2 follows round 1's re-judge, which lands as a new ruling (submit_outcome -> Proposed, bonds kept). The fixture was
  // "Evidence", a state the contract only reaches BEFORE that re-judge (exhibits/objections), where a bond is CON-5 (spikes/sm1).
  const r2: any = challengeOffer(bet({ rest: { bonds: [one], outcome: "NO", status: "Proposed" } }), "maker.testnet", quote, NOW);
  assert.equal(r2.kind, "available");
  assert.equal(r2.round, 2);
  assert.equal(r2.roundLabel, "Round 2: Final appeal");
  const done: any = challengeOffer(bet({ rest: { bonds: [one, { ...one, round: 2 }], status: "Proposed" } }), "taker.testnet", null, NOW);
  assert.equal(done.kind, "no-more-appeals");
  assert.equal(done.message, "No more appeals.");
  const closed: any = challengeOffer(bet({ rest: { proposed_at: (NOW - 7_200_000) * 1_000_000 } }), "taker.testnet", quote, NOW);
  assert.equal(closed.kind, "closed");
  assert.equal(closed.message, "Challenge window closed");
  assert.equal(challengeOffer(bet({ env: { referee: { account: "r.testnet", mode: "Human" } } }), "taker.testnet", quote, NOW).kind, "hidden");
  assert.equal(challengeOffer(bet({ rest: { status: "Challenged" } }), "taker.testnet", quote, NOW).kind, "already-open");
});

test("the status rule matches the contract: challengeable only in Proposed/Evidence, positional rounds, no bond on a referee bet", () => {
  assert.match(rs, /matches!\(bet\.status, BetStatus::Proposed \| BetStatus::Evidence\)/);
  assert.match(rs, /round: this_round/);
  assert.match(rs, /if bet\.envelope\.referee\.is_some\(\)/);
});

test("bond refusal: balance below the quoted bond is refused with the dollar amount; enough or unknown balance passes", () => {
  assert.equal(bondBalanceRefusal(quote, "3999999"), "Not enough balance for the bond (4 USDC)");
  assert.equal(bondBalanceRefusal(quote, "4000000"), null);
  assert.equal(bondBalanceRefusal(quote, null), null);
});

test("finalize is offered only once the window has closed on a standing ruling", () => {
  assert.equal(finalizeOffer(bet(), NOW).show, false);
  assert.equal(finalizeOffer(bet({ rest: { proposed_at: (NOW - 7_200_000) * 1_000_000 } }), NOW).show, true);
  assert.equal(finalizeOffer(bet({ rest: { status: "Taken", proposed_at: null, outcome: null } }), NOW).show, false);
  assert.equal(finalizeOffer(bet({ rest: { status: "Settled", proposed_at: (NOW - 7_200_000) * 1_000_000 } }), NOW).show, false);
});

test("finalized line names the winner, or says both are refunded on VOID", () => {
  assert.equal(finalizedLine(bet({ rest: { status: "Finalized" } })), "The bet is settled. maker.testnet is being paid.");
  assert.equal(finalizedLine(bet({ rest: { status: "Finalized", outcome: "NO" } })), "The bet is settled. taker.testnet is being paid.");
  assert.equal(finalizedLine(bet({ rest: { status: "Finalized", outcome: "VOID" } })), "The bet is settled. Both sides are being refunded.");
});

test("confirmChallenge: success only when get_bet shows one more bond round", async () => {
  const sleep = async () => {};
  let n = 0;
  const ok = await confirmChallenge({ betId: 7, bondsBefore: 0, deps: { getBet: async () => bet({ rest: { bonds: n++ < 1 ? [] : [{}] } }), sleep }, attempts: 4, delayMs: 1 });
  assert.equal(ok.kind, "challenged");
  const no = await confirmChallenge({ betId: 7, bondsBefore: 0, deps: { getBet: async () => bet(), sleep }, attempts: 2, delayMs: 1 });
  assert.equal(no.kind, "pending");
  const late = await confirmChallenge({ betId: 7, bondsBefore: 0, deps: { getBet: async () => bet({ rest: { status: "Finalized" } }), sleep }, attempts: 2, delayMs: 1 });
  assert.equal(late.kind, "refused");
});

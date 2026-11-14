// FE14 (S16): which ids My Bets loads (mine, offers made to me, bets I referee). H1: the grouping and "Needs you" moved to
// lib/homeSections.ts myHome (betView, the bet page's own actions): tests/h1Home.unit.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { refereeCandidates, targetedAtMe, EMPTY, refereeIds, refereeIdsExact, INCOMPLETE_NOTE, REFEREE_SCAN_LIMIT } from "../lib/myBets";

const ME = "me.testnet";

test("targetedAtMe picks only offers addressed to my account", () => {
  const offers = [
    { bet_id: 1, taker_allow: "Any" }, { bet_id: 2, taker_allow: JSON.stringify({ Account: ME }) },
    { bet_id: 3, taker_allow: JSON.stringify({ Account: "x.testnet" }) }, { bet_id: 4, taker_allow: JSON.stringify({ InvitePubkey: "aa" }) }, { bet_id: 5, taker_allow: "nonsense" },
  ] as any[];
  assert.deepEqual(targetedAtMe(offers, ME), [2]);
  assert.deepEqual(targetedAtMe(offers, null), []);
});

test("referee scan: no contract view lists bets by referee, so candidates are Taken/ruled bets of other people, newest first, capped", () => {
  const h = (bet_id: number, status: string, maker = "m.testnet", taker: string | null = "t.testnet") => ({ bet_id, maker, taker, status, outcome: null });
  const hist = [h(1, "Open", "m.testnet", null), h(2, "Taken"), h(3, "Cancelled", "m.testnet", null), h(4, "Settled"), h(5, "Expired", "m.testnet", null), h(6, "Taken", ME), h(7, "Voided")];
  assert.deepEqual(refereeCandidates(hist, ME, 10), [7, 4, 2]);
  const many = Array.from({ length: REFEREE_SCAN_LIMIT + 20 }, (_, i) => h(i + 1, "Taken"));
  assert.equal(refereeCandidates(many, ME).length, REFEREE_SCAN_LIMIT);
  assert.equal(refereeCandidates(many, ME)[0], REFEREE_SCAN_LIMIT + 20);
});

test("empty-state copy is the S16 text", () => {
  assert.equal(EMPTY.all, "You haven't made a bet yet.");
  assert.equal(EMPTY.referee, "Nobody has asked you to decide a bet yet.");
  assert.equal(EMPTY.error, "We can't load your bets. Retry.");
});

// FE14b (D-FE14a): the exact referee list comes from the indexer's /history?referee=<me>; the FE14 scan is only the fallback and is never silent.
const hh = (bet_id: number, status = "Taken", maker = "m.testnet", taker: string | null = "t.testnet") => ({ bet_id, maker, taker, status, outcome: null });

test("referee ids (exact): every bet the indexer lists, newest first, NOT capped at the scan limit (an old bet beyond the newest 50 is kept)", () => {
  const many = Array.from({ length: REFEREE_SCAN_LIMIT + 30 }, (_, i) => hh(i + 1));
  const ids = refereeIdsExact(many);
  assert.equal(ids.length, REFEREE_SCAN_LIMIT + 30);
  assert.equal(ids[0], REFEREE_SCAN_LIMIT + 30);
  assert.equal(ids[ids.length - 1], 1);
  assert.deepEqual(refereeIdsExact([hh(3), hh(3), hh(1, "Open", "m.testnet", null)]), [3, 1]); // de-duplicated; open untaken human bets are included (IDXREF1)
});

test("refereeIds: exact filter when the indexer answers; complete", async () => {
  let scanned = false;
  const r = await refereeIds(ME, { exact: async (who) => { assert.equal(who, ME); return [hh(9), hh(2)]; }, scan: async () => { scanned = true; return []; } });
  assert.deepEqual(r, { ids: [9, 2], incomplete: false });
  assert.equal(scanned, false);
});

test("refereeIds: indexer call fails -> falls back to the FE14 scan and says the list may be incomplete (never silently partial)", async () => {
  const scan = [hh(1), hh(2), hh(3, "Open", "m.testnet", null), hh(4, "Taken", ME)];
  const r = await refereeIds(ME, { exact: async () => { throw new Error("down"); }, scan: async () => scan });
  assert.deepEqual(r, { ids: [2, 1], incomplete: true });
  await assert.rejects(refereeIds(ME, { exact: async () => { throw new Error("down"); }, scan: async () => { throw new Error("also down"); } }));
});

test("incomplete note is plain English", () => {
  assert.match(INCOMPLETE_NOTE, /may be incomplete/);
});

// FE15 (S17): Duplicate this bet. Pure logic: the old bet's terms -> a fresh create-form draft. Nothing from the old bet's id, evidence, attestation or
// run numbers may travel; dates now in the past are flagged; a named taker is cleared; the preflight + open_utc stamp are re-done by the normal flow.
import test from "node:test";
import assert from "node:assert/strict";
import { duplicateDraft, DUPLICATE_MESSAGES, SETTLEMENT_FALLBACK } from "../lib/duplicateBet";
import { buildTypedSheet, canonicalTerms } from "../lib/templates";
import { fieldsFromForm, formFromFields } from "../lib/guidedFields";
import { sheetFromCustomForm, blankCustomForm } from "../lib/customBuilder";
import { assetId } from "../lib/assets";
import { myHome } from "../lib/homeSections";
import { betView } from "../lib/betView";

const NEAR = assetId("NEAR")!;
const USDC = assetId("USDC")!;
const ME = "me.testnet";
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0); // 2026-11-09
const DAY = 86_400_000;
const Y24 = 10n ** 24n;
const OLD_ID = 7777123;
const MARK = "EVIDENCE-SECRET-TEXT";

const touchSheet = (deadline: string) => buildTypedSheet("btc_touch", fieldsFromForm("btc_touch", { direction: "at_or_above", x_usd: "76000", deadline_utc: deadline }, Date.UTC(2026, 9, 1)));

function bet(o: { terms?: string | null; maker?: string; taker?: string | null; allow?: any; makerStake?: bigint; takerStake?: bigint; asset?: string; referee?: string | null; tip?: boolean; settleSecs?: number; resolveMs?: number; createdNs?: number; fundingNs?: number; options?: any[] } = {}): any {
  return {
    envelope: {
      bet_id: OLD_ID, version: 1, maker: o.maker ?? ME, taker_allow: o.allow ?? "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), outcomes: ["YES", "NO"], maker_side: "YES",
      maker_asset: o.asset ?? NEAR, taker_asset: o.asset ?? NEAR, stake_maker: String(o.makerStake ?? 10n * Y24), stake_taker: String(o.takerStake ?? 15n * Y24), taker_options: o.options ?? [], fee_bps: 100,
      keep_terms: true, terms: o.terms === undefined ? canonicalTerms(touchSheet("2027-12-07T12:00:00Z")) : o.terms, run_price: "987654321", max_paid_runs: 3, tier: 1, arbiter: null, arbiter_fee: "0",
      funding_deadline: o.fundingNs ?? (NOW + 7 * DAY) * 1e6, early_settle_outcome: null, finality_delay: 0, settlement_period: (o.settleSecs ?? 6 * 3600) * 1e9,
      resolve_deadline: (o.resolveMs ?? Date.UTC(2028, 11, 7)) * 1e6, consent_party_controlled: false,
      referee: o.referee ? { account: o.referee, mode: "Human" } : null, tip_maker: !!o.tip,
    },
    status: "Settled", taker: o.taker === undefined ? "other.testnet" : o.taker, created_at: o.createdNs ?? Date.UTC(2026, 9, 1) * 1e6, taken_at: 1, proposed_at: 5, outcome: "YES", reserve_remaining: "0",
    bonds: [{ who: "x", amount: "5" }], exhibits: [{ who: ME, text: MARK }], challenged_by: "other.testnet", window_extension_ns: 0, last_resolution_raw: `{"run":4,"note":"${MARK}"}`, fee_min_maker: "1", fee_min_taker: "1",
  };
}
const ok = (b: any, me: string | null = ME, nowMs = NOW) => { const r = duplicateDraft(b, { me, nowMs }); assert.equal(r.ok, true, JSON.stringify(r)); return (r as any).copy; };

test("a typed bet: type, guided fields, stake, odds, settlement window and offer expiry are copied; the form opens on the fill step", () => {
  const c = ok(bet());
  assert.equal(c.draft.step, "fill");
  assert.equal(c.draft.fill.typeId, "btc_touch");
  assert.deepEqual(c.draft.fill.guided, formFromFields("btc_touch", touchSheet("2027-12-07T12:00:00Z").fields as any));
  assert.equal(c.draft.more.stakeSymbol, "NEAR");
  assert.equal(c.draft.more.stakeText, "10");
  assert.equal(c.draft.more.theirText, "15"); // BET1b: "They put in" is copied as an amount
  assert.equal(c.draft.more.odds, 1.5);
  assert.equal(c.draft.more.settlementPeriod, "6h");
  assert.equal(c.draft.more.offerExpiry, "30d"); // created 2026-10-01, closes 2026-11-16 -> nearest listed option, 30d
  assert.equal(c.draft.referee.mode, "ai");
});

test("the named taker is cleared; an invite-by-link bet stays invite-by-link", () => {
  const named = ok(bet({ allow: { Account: "friend.testnet" } }));
  assert.equal(named.draft.more.takerAccount, "");
  assert.equal(named.draft.more.inviteByLink, false);
  const link = ok(bet({ allow: { InvitePubkey: "aa".repeat(32) } }));
  assert.equal(link.draft.more.takerAccount, "");
  assert.equal(link.draft.more.inviteByLink, true);
  assert.equal(JSON.stringify(link).includes("aa".repeat(32)), false); // the old link's key is never carried
});

test("NOTHING from the old bet's id, evidence, attestation or run numbers is carried", () => {
  const c = ok(bet({ allow: { InvitePubkey: "aa".repeat(32) }, referee: "ref.testnet", tip: true }));
  const text = JSON.stringify(c);
  for (const needle of [String(OLD_ID), MARK, "ab".repeat(32), "cd".repeat(32), "987654321", "other.testnet", "open_utc"]) assert.equal(text.includes(needle), false, `leaked: ${needle}`);
  const keys = new Set<string>();
  (function walk(v: unknown) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } })(c);
  for (const k of ["bet_id", "exhibits", "bonds", "attestation", "checked_at", "terms_hash", "models_snapshot_hash", "run_price", "max_paid_runs", "last_resolution_raw", "open_utc", "challenged_by", "outcome", "status", "created_at"]) assert.equal(keys.has(k), false, `key carried: ${k}`);
});

test("the banner names the old bet's date; a bet with no date gets the plain version", () => {
  assert.equal(ok(bet()).banner, "Copied from your bet of 2026-10-01 UTC. Check the dates before you continue.");
  assert.equal(ok(bet({ createdNs: 0 })).banner, "Copied from your earlier bet. Check the dates before you continue.");
});

test("dates now in the past are flagged (and kept); future dates are not", () => {
  const past = ok(bet({ terms: canonicalTerms(touchSheet("2026-11-01T12:00:00Z")) }));
  assert.deepEqual(past.pastKeys, ["deadline_utc"]);
  assert.equal(past.draft.fill.guided.deadline_utc, "2026-11-01T12:00");
  assert.equal(past.pastNote, "These dates have passed. Pick new ones.");
  const future = ok(bet());
  assert.deepEqual(future.pastKeys, []);
  assert.equal(future.pastNote, null);
  // a game day that is today has not passed; yesterday has
  const game = (d: string) => canonicalTerms(buildTypedSheet("game_winner", fieldsFromForm("game_winner", { league: "MLB", event_id: "849799", scheduled_date: d, pick_team_id: "158", pick_name: "Milwaukee Brewers" }, NOW)));
  assert.deepEqual(ok(bet({ terms: game("2026-11-09") })).pastKeys, []);
  assert.deepEqual(ok(bet({ terms: game("2026-11-08") })).pastKeys, ["scheduled_date"]);
});

test("a custom bet copies the claim, questions, sources, rules; past window times are flagged", () => {
  const f = blankCustomForm();
  f.claim = "Apple ships a foldable iPhone in 2026."; f.elements = ["Is a foldable iPhone on sale?"]; f.windowStart = "2026-01-01T00:00"; f.windowEnd = "2026-10-01T00:00"; f.evidenceCutoff = "2026-10-01T00:00";
  f.sources = [{ publisher: "Reuters", url: "https://reuters.com/a", partyControlled: false }, { publisher: "Apple", url: "https://apple.com/", partyControlled: false }];
  const c = ok(bet({ terms: canonicalTerms(sheetFromCustomForm(f)) }));
  assert.equal(c.draft.fill.typeId, "custom");
  assert.equal(c.draft.fill.custom.claim, f.claim);
  assert.deepEqual(c.draft.fill.custom.elements, f.elements);
  assert.deepEqual(c.draft.fill.custom.sources.map((s: any) => s.publisher), ["Reuters", "Apple"]);
  assert.deepEqual([...c.pastKeys].sort(), ["evidenceCutoff", "windowEnd", "windowStart"]);
});

test("a person-decides bet copies the referee (editable) and the tip; a past referee deadline is flagged and reset to the default", () => {
  const c = ok(bet({ referee: "ref.testnet", tip: true, resolveMs: Date.UTC(2026, 10, 1) }));
  assert.deepEqual(c.draft.referee, { mode: "human", referee: "ref.testnet" });
  assert.equal(c.draft.more.tipMaker, true);
  assert.equal(c.draft.more.resolveDate, null);
  assert.deepEqual(c.pastKeys, ["resolveDate"]);
  const later = ok(bet({ referee: "ref.testnet", resolveMs: Date.UTC(2028, 11, 7) }));
  assert.equal(later.draft.more.resolveDate, "2028-12-07");
  assert.equal(later.draft.more.tipMaker, false);
  assert.deepEqual(later.pastKeys, []);
  assert.equal(ok(bet()).draft.more.resolveDate, null); // AI bet: no referee deadline
});

test("a taker who duplicates uses their own stake, and the odds are the other side over theirs", () => {
  const c = ok(bet({ maker: "m.testnet", taker: ME, makerStake: 20n * Y24, takerStake: 10n * Y24 }));
  assert.equal(c.draft.more.stakeText, "10");
  assert.equal(c.draft.more.theirText, "20");
  assert.equal(c.draft.more.odds, 2);
  const even = ok(bet({ makerStake: 10n * Y24, takerStake: 10n * Y24 }));
  assert.equal(even.draft.more.theirText, null); // even stays even (follows "You put in")
});

test("a bet in a token the form cannot stake here is copied without the amount, with a plain note", () => {
  const BTC_MAINNET = "nep141:btc.omft.near"; // no testnet id: not offered on this (testnet) build
  const c = ok(bet({ asset: BTC_MAINNET, makerStake: 100_000n, takerStake: 100_000n }));
  assert.equal(c.draft.more.stakeSymbol, "NEAR");
  assert.equal(c.draft.more.stakeText, "10"); // the form's default; the amount is not carried across tokens
  assert.equal(c.draft.more.theirText, null);
  assert.deepEqual(c.notes, ["The old bet was in BTC, which you can't stake here. Enter your stake."]);
  // an old cross-asset bet (different tokens per side) is not copied as amounts either (D-SCOPE5)
  const cross = bet({ asset: NEAR });
  cross.envelope.taker_asset = USDC;
  assert.deepEqual(ok(cross).notes, ["The old bet was in NEAR and USDC; both sides now use one token. Enter your stake."]);
});

test("unknown settlement window falls back to the default; old cross-asset taker options are not copied (D-SCOPE5)", () => {
  assert.equal(ok(bet({ settleSecs: 5000 })).draft.more.settlementPeriod, SETTLEMENT_FALLBACK);
  const c = ok(bet({ options: [{ asset: USDC, amount: "10000000" }] }));
  assert.equal("crossAssetChecked" in c.draft.more, false);
  assert.equal(JSON.stringify(c.draft.more).includes("USDC"), false);
});

test("errors: no bet, a bet that is not mine, no stored terms, an unknown bet type", () => {
  assert.deepEqual(duplicateDraft(null, { me: ME, nowMs: NOW }), { ok: false, message: DUPLICATE_MESSAGES.cannotCopy });
  assert.equal(DUPLICATE_MESSAGES.cannotCopy, "We can't copy that bet.");
  assert.deepEqual(duplicateDraft(bet({ terms: null }), { me: ME, nowMs: NOW }), { ok: false, message: "We can't copy that bet." });
  assert.deepEqual(duplicateDraft(bet({ terms: "not json" }), { me: ME, nowMs: NOW }), { ok: false, message: "We can't copy that bet." });
  assert.deepEqual(duplicateDraft(bet({ terms: JSON.stringify({ template: { id: "tennis_set", version: 1 }, fields: {} }) }), { me: ME, nowMs: NOW }), { ok: false, message: "This bet type is no longer available. Start from custom." });
  assert.deepEqual(duplicateDraft(bet({ maker: "m.testnet", taker: "t.testnet" }), { me: ME, nowMs: NOW }), { ok: false, message: "We can't copy that bet." });
  assert.deepEqual(duplicateDraft(bet(), { me: null, nowMs: NOW }), { ok: false, message: "We can't copy that bet." });
});

// H1 (familiarcow UX-37 #4): Duplicate is no longer on Home cards; it is in the bet page's More actions (betView secondary) for bets I am a
// party to, never for an offer made to me or a bet I only referee.
test("Duplicate: in the bet page's More actions for my bets only, and never a Home card button", () => {
  const mine = bet();
  mine.envelope.funding_deadline = (NOW + DAY) * 1e6;
  (mine as any).status = "Open"; (mine as any).taker = null;
  const toMe = { ...bet({ maker: "friend.testnet", taker: null, allow: { Account: ME } }), status: "Open" } as any;
  toMe.envelope.funding_deadline = (NOW + DAY) * 1e6;
  for (const b of [mine, toMe]) Object.assign(b, { bonds: [], exhibits: [], challenged_by: null, proposed_at: null, outcome: null, taken_at: null });
  const more = (b: any) => betView(b, ME, NOW).secondary.map((a) => a.id);
  assert.ok(more(mine).includes("duplicate"));
  assert.ok(!more(toMe).includes("duplicate"));
  const home = myHome([{ id: 1, bet: mine }, { id: 2, bet: toMe }], ME, NOW);
  const buttons = home.groups.flatMap((g) => g.cards).map((c) => c.view.primary?.id ?? null);
  assert.deepEqual(buttons.sort(), [null, "take"]);
});
test("BET1b: a USDC stake (either side) is copied with its token, your amount and theirs; no note", () => {
  const maker = ok(bet({ asset: USDC, makerStake: 25_000_000n, takerStake: 50_000_000n }));
  assert.deepEqual([maker.draft.more.stakeSymbol, maker.draft.more.stakeText, maker.draft.more.theirText, maker.draft.more.odds], ["USDC", "25", "50", 2]);
  const taker = ok(bet({ maker: "m.testnet", taker: ME, asset: USDC, makerStake: 25_000_000n, takerStake: 50_000_000n }));
  assert.deepEqual([taker.draft.more.stakeSymbol, taker.draft.more.stakeText, taker.draft.more.theirText, taker.draft.more.odds], ["USDC", "50", "25", 0.5]);
  for (const c of [maker, taker]) {
    assert.deepEqual(c.notes, []);
    assert.equal(c.draft.fill.typeId, "btc_touch");
  }
});

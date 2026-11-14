// FE3 (spec S2/S3): bet-type card picker + fill-in step logic. Lints are the existing ones (lintTemplate, builderGate/customLint); this
// module only wires them to the steps, so every message asserted here is the existing lint's own text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BET_TYPE_CARDS, PICKER_TILES, PRICE_KINDS, pickerGroupFor, claimLineFor, deadlineLabelFor, fillProblems, betSentence, customFieldVisible, customSheetFor, localTimeLabel, blankFill, type FillState } from "../lib/betTypePicker";
import { LAUNCH_TEMPLATES } from "../lib/templates";
import { blankCustomForm, type CustomForm } from "../lib/customBuilder";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-08T12:00:00Z");

const goodCustom = (): CustomForm => ({
  ...blankCustomForm(),
  claim: "Apple makes a foldable iPhone available to buy in the US during 2027.",
  elements: ["Did Apple make a foldable-screen iPhone available to purchase in the United States between 2027-01-01 and 2027-12-31 UTC?"],
  sources: [{ publisher: "apple.com newsroom", url: "", partyControlled: false }, { publisher: "Reuters", url: "https://www.reuters.com/", partyControlled: false }],
  windowStart: "2027-01-01T00:00", windowEnd: "2027-12-31T23:59", evidenceCutoff: "2028-01-07T00:00",
  fallbackRule: "Fallback: if a named source is unavailable, the other may confirm.",
  earlyRule: "Early YES resolution is allowed once the event has happened.",
});
const GOOD: Record<string, FillState> = {
  btc_close_at_t: { ...blankFill("btc_close_at_t"), guided: { t_utc: "2026-12-01T15:00", op: ">=", x_usd: "75900" } },
  btc_touch: { ...blankFill("btc_touch"), guided: { direction: "at_or_above", x_usd: "76000", deadline_utc: "2026-12-07T12:00" } },
  game_winner: { ...blankFill("game_winner"), guided: { league: "MLB", event_id: "849799", scheduled_date: "2026-12-28", pick_team_id: "158", pick_name: "Milwaukee Brewers" } },
  nws_daily_high: { ...blankFill("nws_daily_high"), guided: { station: "KNYC", date: "2026-12-08", op: ">=", x_f: "72" } },
  custom: { ...blankFill("custom"), custom: goodCustom() },
};

test("six cards in spec order (TPL1: + Which outperforms?) with plain-English titles, one example each, custom card copy", () => {
  assert.deepEqual(BET_TYPE_CARDS.map((c) => c.id), ["btc_close_at_t", "btc_touch", "outperform", "game_winner", "nws_daily_high", "custom"]);
  assert.deepEqual(BET_TYPE_CARDS.map((c) => c.title), ["Price at a set time", "Hits a price", "Which outperforms?", "Who wins a game", "Daily high temperature", "Anything else \u2014 any web page"]);
  for (const c of BET_TYPE_CARDS) assert.ok(c.example.length > 10, c.id);
  assert.equal(BET_TYPE_CARDS[5].blurb, "Name any page. The AI reads it and decides.");
  // every launch template has a card (no type is unreachable from the picker)
  for (const t of LAUNCH_TEMPLATES) assert.ok(BET_TYPE_CARDS.some((c) => c.id === t), t);
});

test("valid input for each of the 5 types has no problems", () => {
  for (const [id, s] of Object.entries(GOOD)) assert.deepEqual(fillProblems(s, NOW), [], id);
});

test("a blank step is blocked for every type (Next stays disabled)", () => {
  for (const id of ["btc_close_at_t", "btc_touch", "game_winner", "nws_daily_high", "custom"] as const) assert.ok(fillProblems(blankFill(id), NOW).length > 0, id);
});

test("lint failures carry the existing lint's own named message (unchanged)", () => {
  const bad = { ...GOOD.btc_close_at_t, guided: { ...GOOD.btc_close_at_t.guided, x_usd: "75900.5" } };
  assert.ok(fillProblems(bad, NOW).some((p) => p.includes("TPL_X_USD_NOT_WHOLE")));
  const vague = goodCustom(); vague.claim = "Apple ships it next week.";
  assert.ok(fillProblems({ ...GOOD.custom, custom: vague }, NOW).some((p) => p.includes("CUSTOM_RELATIVE_DATE")));
  const pc = goodCustom(); pc.claim = "Hotter weather than yesterday in New York.";
  assert.ok(fillProblems({ ...GOOD.custom, custom: pc }, NOW).some((p) => p.includes("AMBIGUOUS_NO_STATION")));
});

// SRCREF1c / D-PM3 option C: the frozen contract needs a source-check attestation for every bet, so a person-decided
// custom bet needs the same >=2 readable sources as an AI bet. Only the evidence cutoff / close are hidden (nobody collects evidence).
test("SRCREF1c human mode: sources and fallback stay visible and required (same lint as AI mode); evidence cutoff/close hidden", () => {
  for (const f of ["sources", "fallbackRule", "claim", "windowStart", "windowEnd", "earlyRule"] as const) assert.equal(customFieldVisible(f, true), true, f);
  for (const f of ["evidenceCutoff", "windowClose"] as const) { assert.equal(customFieldVisible(f, true), false, f); assert.equal(customFieldVisible(f, false), true, f); }
  const f = goodCustom(); f.evidenceCutoff = "";
  assert.deepEqual(fillProblems({ ...GOOD.custom, custom: f, human: true }, NOW), []);
  const none = { ...goodCustom(), sources: [{ publisher: "", url: "", partyControlled: false }, { publisher: "", url: "", partyControlled: false }] };
  const ai = fillProblems({ ...GOOD.custom, custom: none }, NOW);
  const hu = fillProblems({ ...GOOD.custom, custom: none, human: true }, NOW);
  assert.ok(hu.length > 0 && hu.some((p) => /independent|missing field: sources|source name/.test(p)), "referee bet without sources is refused");
  assert.deepEqual(hu, ai, "same lint for both modes");
  const one = { ...goodCustom(), sources: [goodCustom().sources[0]] };
  assert.ok(fillProblems({ ...GOOD.custom, custom: one, human: true }, NOW).some((p) => /independent/.test(p)), "one source is not enough");
  assert.equal((customSheetFor(goodCustom(), true) as any).sources_allowed.length, 2, "sources are sent in human mode");
  assert.equal(fillProblems({ ...GOOD.custom, custom: { ...goodCustom(), claim: "" }, human: true }, NOW).length > 0, true, "claim is still required");
});

test("live sentence names the claim and the other side", () => {
  assert.equal(betSentence(GOOD.btc_close_at_t), "You are betting that the Bitcoin price at 2026-12-01 15:00 UTC is at or above $75,900. The other person bets it won't happen.");
  assert.match(betSentence(GOOD.btc_touch), /^You are betting that Bitcoin touches \$76,000 \(at or above\) before 2026-12-07 12:00 UTC\./);
  assert.match(betSentence(GOOD.game_winner), /Milwaukee Brewers win the MLB game on 2026-12-28/);
  assert.match(betSentence(GOOD.nws_daily_high), /daily high in New York City \(Central Park\) on 2026-12-08 is at or above 72\u00b0F/);
  assert.match(betSentence(GOOD.custom), /^You are betting that Apple makes a foldable iPhone/);
  assert.equal(betSentence(blankFill("custom")), "");
});

test("local time label sits beside the UTC time", () => {
  assert.equal(localTimeLabel("2026-12-01T15:00", "America/New_York"), "10:00 AM EST on Dec 1 in your time zone");
  assert.equal(localTimeLabel("", "America/New_York"), null);
  assert.equal(localTimeLabel("nonsense", "America/New_York"), null);
});

test("UI wiring: picker cards + step fields; dev presets and their test ids are gone", () => {
  const co = readFileSync(join(here, "../src/components/CreateOffer.tsx"), "utf8");
  const ts = readFileSync(join(here, "../src/components/BetTypeStep.tsx"), "utf8");
  // BET1a: the "any page" fields moved into BetDetails.tsx (mounted by FillStep)
  const fs = readFileSync(join(here, "../src/components/FillStep.tsx"), "utf8") + readFileSync(join(here, "../src/components/BetDetails.tsx"), "utf8");
  for (const dead of ["jason-preset", "custom-claim", "btc-venue-template", "Jason preset", "BTC price template", "JASON_TERM_SHEET", "claim-text", "sources-editor"]) assert.ok(!co.includes(dead), `CreateOffer must not contain ${dead}`);
  assert.ok(ts.includes("bet-type-card-") && ts.includes("BET_TYPE_CARDS"));
  assert.ok(fs.includes("GUIDED_FIELDS") && fs.includes("customFieldVisible") && fs.includes("fill-next") && fs.includes("fill-error"));
  assert.ok(co.includes("fieldsFromForm") || co.includes("fillProblems"));
});

test("review-card claim line and deadline come from the filled bet (no placeholder terms)", () => {
  assert.equal(claimLineFor(GOOD.btc_touch), "You are betting that Bitcoin touches $76,000 (at or above) before 2026-12-07 12:00 UTC.");
  assert.equal(deadlineLabelFor(GOOD.btc_close_at_t), "2026-12-01 15:00 UTC");
  assert.equal(deadlineLabelFor(GOOD.game_winner), "2026-12-28");
  assert.equal(deadlineLabelFor(GOOD.nws_daily_high), "2026-12-08");
  assert.equal(deadlineLabelFor(GOOD.custom), "2027-12-31 23:59 UTC");
  assert.equal(deadlineLabelFor(blankFill("btc_touch")), "");
});

// TPL1 (PM 14:05, familiarcow): the picker shows ONE "Asset prices" tile; it opens a sub-choice of the three price types in plain words.
test("main picker: Asset prices, Who wins a game, Daily high temperature, Anything else; Asset prices opens the 3 price types", () => {
  assert.deepEqual(PICKER_TILES.map((c) => c.id), ["prices", "game_winner", "nws_daily_high", "custom"]);
  assert.equal(PICKER_TILES[0].title, "Asset prices");
  assert.match(PICKER_TILES[0].blurb, /Bitcoin, Ethereum, Zcash/);
  for (const c of PICKER_TILES.slice(1)) assert.deepEqual(c, BET_TYPE_CARDS.find((x) => x.id === c.id));
  assert.deepEqual(PRICE_KINDS, ["btc_close_at_t", "btc_touch", "outperform"]);
  assert.deepEqual(PRICE_KINDS.map((k) => BET_TYPE_CARDS.find((c) => c.id === k)!.title), ["Price at a set time", "Hits a price", "Which outperforms?"]);
  // every bet kind is reachable: a main tile, or a price type under Asset prices
  for (const c of BET_TYPE_CARDS) assert.ok(PICKER_TILES.some((t) => t.id === c.id) || PRICE_KINDS.includes(c.id), c.id);
  // a price draft (also a copied old Bitcoin bet) goes Back to the sub-choice; anything else to the main tiles
  for (const k of PRICE_KINDS) assert.equal(pickerGroupFor(k), "prices");
  for (const k of ["game_winner", "nws_daily_high", "custom"] as const) assert.equal(pickerGroupFor(k), null);
});

// BET1a (UX-33 section 1): each card has a small icon, bundled locally as inline SVG (no network fetch, no image file URL).
test("every bet-type card has its own locally bundled icon", () => {
  const icons = BET_TYPE_CARDS.map((c) => c.icon);
  assert.equal(new Set(icons).size, 6, "one distinct icon per card"); // TPL1: + Which outperforms?
  const src = readFileSync(join(here, "../src/components/BetTypeIcon.tsx"), "utf8");
  for (const i of icons) assert.ok(src.includes(`${i}:`), `icon ${i} is drawn in BetTypeIcon.tsx`);
  assert.ok(!/https?:\/\//.test(src.replace("http://www.w3.org/2000/svg", "")), "no remote icon URLs");
  const ts = readFileSync(join(here, "../src/components/BetTypeStep.tsx"), "utf8");
  assert.ok(ts.includes("BetTypeIcon"));
});

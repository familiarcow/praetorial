// TPL1 (PM NOTE, familiarcow approved): "Which outperforms?" -- two coins (BTC allowed), a start and an end UTC minute, a margin in
// percentage points (default 0.5; a gap under the margin is VOID with refunds). An AI-judged custom sheet built from the exchanges
// that list both coins; it must pass the resolver-parity custom lint, the price-reading check and the web builder gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_ASSETS, type MarketAsset } from "../lib/marketAssets";
import { outperformSheet, outperformProblems, sharedVenues, marginPts, outperformVenuesText, DEFAULT_MARGIN_PTS } from "../lib/outperformSheet";
import { deciderLine } from "../lib/assetPriceSheet";
import { lintCustom, customOpenProblems, priceReadingProblems } from "../lib/customLint";
import { builderGate } from "../lib/builderGate";
import { templateId } from "../lib/templates";
import { blankFill, fillProblems, typedSheetFor, betSentence, claimLineFor, deadlineLabelFor, BET_TYPE_CARDS, guidedFieldsFor, type FillState } from "../lib/betTypePicker";
import { customSourceHosts } from "../lib/templateSources";
import { customDeadlineSecs } from "../lib/customBuilder";
import { plainProblem } from "../lib/plainErrors";
import { pastFillKeys } from "../lib/duplicateBet";

const NOW = Date.parse("2026-11-12T16:00:00Z");
const asset = (s: string) => FALLBACK_ASSETS.find((a) => a.symbol === s)!;
const G = { start_utc: "2026-11-20T15:00", end_utc: "2026-11-27T15:00", margin_pts: "0.5" };
const secs = (iso: string) => Date.parse(iso) / 1000;

for (const sym of ["ZEC", "ETH"]) {
  test(`${sym} vs BTC: a custom sheet that passes the custom lint, the price-reading check and the builder gate`, () => {
    const a = asset(sym), b = asset("BTC");
    const s: any = outperformSheet(a, b, G);
    assert.equal(templateId(s).id, "custom");
    assert.deepEqual(lintCustom(s), []);
    assert.deepEqual(customOpenProblems(s), []);
    assert.deepEqual(priceReadingProblems(s), []);
    assert.deepEqual(builderGate(s).problems, []);
    assert.deepEqual(outperformProblems(a, b, G, NOW), []);
    assert.equal(s.claim, `From 2026-11-20T15:00:00Z to 2026-11-27T15:00:00Z, the ${sym}-USD price change beats the BTC-USD price change by at least 0.5 percentage points, using the median close of the 1-minute candles on Coinbase, Bitstamp and Kraken.`);
    assert.equal(s.elements.length, 1);
    assert.equal(s.elements[0].q, `From 2026-11-20T15:00:00Z to 2026-11-27T15:00:00Z, did the ${sym}-USD price change beat the BTC-USD price change by at least 0.5 percentage points (median 1-minute close on Coinbase, Bitstamp and Kraken)?`);
    assert.deepEqual(s.time, { window_start: "2026-11-20T14:59:00Z", window_end: "2026-11-27T15:00:00Z", evidence_cutoff: "2026-12-04T15:00:00Z" });
    assert.equal(customDeadlineSecs(s), secs("2026-11-27T15:00:00Z"));
    // sources: both coins, start AND end candles on the venues that name the candle time; Coinbase = its latest candles
    const p = a.pairs, q = b.pairs;
    const st = secs("2026-11-20T15:00:00Z"), en = secs("2026-11-27T15:00:00Z");
    assert.deepEqual(s.sources_allowed.map((x: any) => x.url), [
      `https://api.exchange.coinbase.com/products/${p.coinbase!.api}/candles?granularity=60`,
      `https://www.bitstamp.net/api/v2/ohlc/${p.bitstamp!.api}/?step=60&limit=5&start=${st - 60}`,
      `https://www.bitstamp.net/api/v2/ohlc/${p.bitstamp!.api}/?step=60&limit=5&start=${en - 60}`,
      `https://api.kraken.com/0/public/OHLC?pair=${p.kraken!.api}&interval=1&since=${st - 120}`,
      `https://api.kraken.com/0/public/OHLC?pair=${p.kraken!.api}&interval=1&since=${en - 120}`,
      `https://api.exchange.coinbase.com/products/${q.coinbase!.api}/candles?granularity=60`,
      `https://www.bitstamp.net/api/v2/ohlc/${q.bitstamp!.api}/?step=60&limit=5&start=${st - 60}`,
      `https://www.bitstamp.net/api/v2/ohlc/${q.bitstamp!.api}/?step=60&limit=5&start=${en - 60}`,
      `https://api.kraken.com/0/public/OHLC?pair=${q.kraken!.api}&interval=1&since=${st - 120}`,
      `https://api.kraken.com/0/public/OHLC?pair=${q.kraken!.api}&interval=1&since=${en - 120}`,
    ]);
    assert.equal(new Set(s.sources_allowed.map((x: any) => x.id)).size, 10, "source ids are unique");
    for (const x of s.sources_allowed) assert.equal(s.ticker_pins[x.publisher], x.publisher.split(" ")[1], x.publisher);
    assert.deepEqual(customSourceHosts(s), ["api.exchange.coinbase.com", "www.bitstamp.net", "api.kraken.com"]);
    const defs = s.custom_definitions.join(" ");
    assert.match(defs, /median CLOSE of its 1-minute USD candle/);
    assert.match(defs, /never the high or low \(wick\)/);
    assert.match(defs, /divided by price at 2026-11-20T15:00:00Z, times 100, in percentage points/);
    assert.match(defs, new RegExp(`YES if the ${sym}-USD change minus the BTC-USD change is at least 0\\.5 percentage points\\. NO if the BTC-USD change minus the ${sym}-USD change is at least 0\\.5 percentage points\\. Otherwise the gap is under the 0\\.5-point margin and the outcome is VOID with full refunds\\.`));
    assert.match(defs, new RegExp(`Only the ${sym}-USD pair and the BTC-USD pair on the named venues are eligible; no aggregators or other assets\\.`));
    // the review card: decided by the AI judge, each venue pair named once
    assert.equal(deciderLine(s), `Decided by the AI judge reading Coinbase ${p.coinbase!.label}, Bitstamp ${p.bitstamp!.label}, Kraken ${p.kraken!.label}, Coinbase BTC-USD, Bitstamp btcusd and Kraken XBT/USD`);
  });
}

test("the sheet never says % or percent in the claim or question (the resolver lint refuses a percent move with no reference)", () => {
  const s: any = outperformSheet(asset("ZEC"), asset("BTC"), G);
  for (const t of [s.claim, s.elements[0].q]) assert.doesNotMatch(t, /%|\bpercent\b|\bmoves?\b/i);
});

test("only the exchanges that list BOTH coins are used; fewer than 2 shared is refused in plain words", () => {
  const onlyCbKr: MarketAsset = { symbol: "TWO", name: "Two", pairs: { coinbase: { api: "TWO-USD", label: "TWO-USD" }, kraken: { api: "TWOUSD", label: "TWO/USD" } } };
  const onlyBsKr: MarketAsset = { symbol: "THR", name: "Three", pairs: { bitstamp: { api: "thrusd", label: "thrusd" }, kraken: { api: "THRUSD", label: "THR/USD" } } };
  assert.deepEqual(sharedVenues(onlyCbKr, asset("BTC")), ["coinbase", "kraken"]);
  const s: any = outperformSheet(onlyCbKr, asset("BTC"), G);
  assert.equal(s.sources_allowed.length, 6); // 2 coins x (Coinbase 1 + Kraken start/end 2)
  assert.match(s.claim, /on Coinbase and Kraken\.$/);
  assert.deepEqual(builderGate(s).problems, []);
  assert.equal(outperformVenuesText(onlyCbKr, asset("BTC")), "Checked on Coinbase and Kraken (the exchanges that list both coins)");
  assert.deepEqual(sharedVenues(onlyCbKr, onlyBsKr), ["kraken"]);
  const p = outperformProblems(onlyCbKr, onlyBsKr, G, NOW);
  assert.equal(p.length, 1);
  assert.match(p[0], /^PRICE_TOO_FEW_VENUES:/);
  assert.equal(plainProblem(p[0]).text, "This coin is not listed on enough exchanges to check its price. Pick another coin.");
});

test("the margin: blank = 0.5; a positive number of points up to 100 with at most 2 decimals; else a plain error", () => {
  assert.equal(DEFAULT_MARGIN_PTS, "0.5");
  assert.equal(marginPts(""), "0.5");
  assert.equal(marginPts(undefined), "0.5");
  assert.equal(marginPts("2"), "2");
  assert.equal(marginPts("1.50"), "1.5");
  assert.equal(marginPts("0.25"), "0.25");
  for (const bad of ["0", "-1", "abc", "1.234", "101", "5%"]) assert.equal(marginPts(bad), null, bad);
  const blank: any = outperformSheet(asset("ETH"), asset("BTC"), { ...G, margin_pts: "" });
  assert.match(blank.claim, /by at least 0\.5 percentage points/);
  assert.deepEqual(outperformProblems(asset("ETH"), asset("BTC"), { ...G, margin_pts: "" }, NOW), []);
  const two: any = outperformSheet(asset("ETH"), asset("BTC"), { ...G, margin_pts: "2" });
  assert.match(two.custom_definitions.join(" "), /under the 2-point margin and the outcome is VOID/);
  const p = outperformProblems(asset("ETH"), asset("BTC"), { ...G, margin_pts: "0" }, NOW);
  assert.equal(p.length, 1);
  assert.match(p[0], /^OUTPERFORM_MARGIN:/);
  assert.equal(plainProblem(p[0]).text, "Enter the margin in percentage points, more than 0 and at most 100, like 0.5.");
});

test("refusals: the same coin twice, the end not after the start, a start in the past -- each with a plain message", () => {
  const same = outperformProblems(asset("BTC"), asset("BTC"), G, NOW);
  assert.equal(same.length, 1);
  assert.match(same[0], /^OUTPERFORM_SAME_COIN:/);
  assert.equal(plainProblem(same[0]).text, "Pick two different coins.");
  const rev = outperformProblems(asset("ETH"), asset("BTC"), { ...G, start_utc: G.end_utc, end_utc: G.start_utc }, NOW);
  assert.ok(rev.some((x) => /^OUTPERFORM_END_NOT_AFTER_START:/.test(x)), rev.join("\n"));
  assert.equal(plainProblem(rev.find((x) => /^OUTPERFORM_END/.test(x))!).text, "The end time must be after the start time.");
  const past = outperformProblems(asset("ETH"), asset("BTC"), { ...G, start_utc: "2026-11-10T15:00" }, NOW);
  assert.equal(past.length, 1);
  assert.match(past[0], /^OUTPERFORM_START_PASSED:/);
  assert.equal(plainProblem(past[0]).text, "The start time has passed. Pick a start in the future.");
  const empty = outperformProblems(asset("ETH"), asset("BTC"), { margin_pts: "0.5" }, NOW);
  assert.ok(empty.length >= 1);
  for (const m of [...same, ...rev, ...past, ...empty]) assert.ok(!/^[A-Z_]+:/.test(plainProblem(m).text), `plain: ${m}`);
});

test("the card: a third price bet type, 'Which outperforms?', with its own icon", () => {
  const c = BET_TYPE_CARDS.find((x) => x.id === "outperform")!;
  assert.equal(c.title, "Which outperforms?");
  assert.match(c.blurb, /two coins/i);
  assert.deepEqual(BET_TYPE_CARDS.map((x) => x.id).slice(0, 3), ["btc_close_at_t", "btc_touch", "outperform"]);
});

test("the fill step: defaults Ethereum vs Bitcoin and 0.5 points; the sheet is the AI-judged custom sheet; sentence and review lines", () => {
  const f0 = blankFill("outperform");
  assert.equal(f0.asset!.symbol, "ETH");
  assert.equal(f0.assetB!.symbol, "BTC");
  assert.equal(f0.guided.margin_pts, "0.5");
  assert.deepEqual(guidedFieldsFor(f0).map((g) => g.key), ["start_utc", "end_utc", "margin_pts"]);
  assert.equal(betSentence(f0), "");
  const both = { ...f0, asset: asset("BTC"), guided: { ...f0.guided, start_utc: G.start_utc, end_utc: G.end_utc } };
  assert.equal(betSentence(both), "", "the same coin twice: no sentence (never 'Bitcoin beats Bitcoin')");
  const f: FillState = { ...f0, asset: asset("ZEC"), guided: { ...f0.guided, start_utc: G.start_utc, end_utc: G.end_utc } };
  assert.deepEqual(fillProblems(f, NOW), []);
  const s: any = typedSheetFor(f, NOW);
  assert.equal(templateId(s).id, "custom");
  assert.deepEqual(s, outperformSheet(asset("ZEC"), asset("BTC"), f.guided));
  assert.equal(betSentence(f), "You are betting that Zcash (ZEC) beats Bitcoin (BTC) by at least 0.5 percentage points of price change from 2026-11-20 15:00 UTC to 2026-11-27 15:00 UTC. If neither coin beats the other by 0.5 points, the bet is void and both stakes are refunded. The other person bets that Bitcoin (BTC) beats Zcash (ZEC) by at least 0.5 points.");
  assert.equal(claimLineFor(f), "You are betting that Zcash (ZEC) beats Bitcoin (BTC) by at least 0.5 percentage points of price change from 2026-11-20 15:00 UTC to 2026-11-27 15:00 UTC. If neither coin beats the other by 0.5 points, the bet is void and both stakes are refunded.");
  assert.equal(deadlineLabelFor(f), "2026-11-27 15:00 UTC");
  assert.deepEqual(pastFillKeys(f, NOW), []);
  assert.deepEqual(pastFillKeys(f, Date.parse("2026-11-21T00:00:00Z")), ["start_utc"]);
});

// TPL1 (D-PM3 #1): price bets on any listed asset. Bitcoin keeps the typed, code-decided templates; any other asset becomes a
// custom AI-judged sheet with the same claim shape (resolver/core/src/template.rs materialize btc_close_at_t / btc_touch), built
// from the exchanges that list the pair. The sheet must pass the resolver-parity custom lint and the web builder gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_ASSETS, STABLE_OR_FIAT, parseCoinbaseProducts, parseKrakenPairs, parseBitstampPairs, mergeAssets, loadMarketAssets,
  searchAssets, venuesOf, fetchAssetPrice, MARKET_LIST_URLS, tickerUrl, MARKET_CACHE_KEY, findMarketAsset, type MarketAsset,
} from "../lib/marketAssets";
import { assetPriceSheet, assetPriceProblems, deciderLine, ASSET_PRICE_RULE_ONLY_PAIR } from "../lib/assetPriceSheet";
import { lintCustom, customOpenProblems, priceReadingProblems } from "../lib/customLint";
import { builderGate } from "../lib/builderGate";
import { templateId, buildTypedSheet } from "../lib/templates";
import { blankFill, fillProblems, typedSheetFor, betSentence, BET_TYPE_CARDS, PICKER_TILES, type FillState } from "../lib/betTypePicker";
import { customSourceHosts } from "../lib/templateSources";
import { customDeadlineSecs } from "../lib/customBuilder";
import { plainProblem } from "../lib/plainErrors";

const NOW = Date.parse("2026-11-12T16:00:00Z");
const asset = (s: string) => FALLBACK_ASSETS.find((a) => a.symbol === s)!;
const CLOSE = { t_utc: "2026-11-20T15:00", op: ">=", x_usd: "950" };
const TOUCH = { direction: "at_or_above", x_usd: "1200", deadline_utc: "2026-11-27T12:00" };

// --- exchange product lists (public endpoints; shapes recorded 2026-11-12)
const CB = [
  { id: "ZEC-USD", base_currency: "ZEC", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "ETH-USD", base_currency: "ETH", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "ETH-EUR", base_currency: "ETH", quote_currency: "EUR", status: "online", trading_disabled: false },
  { id: "USDT-USD", base_currency: "USDT", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "OLD-USD", base_currency: "OLD", quote_currency: "USD", status: "delisted", trading_disabled: true },
  { id: "ONLYCB-USD", base_currency: "ONLYCB", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "TWO-USD", base_currency: "TWO", quote_currency: "USD", status: "online", trading_disabled: false },
];
const KR = { error: [], result: {
  XZECZUSD: { altname: "ZECUSD", wsname: "ZEC/USD", aclass_base: "currency", base: "XZEC", quote: "ZUSD", status: "online" },
  XETHZUSD: { altname: "ETHUSD", wsname: "ETH/USD", aclass_base: "currency", base: "XETH", quote: "ZUSD", status: "online" },
  XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", aclass_base: "currency", base: "XXBT", quote: "ZUSD", status: "online" },
  XDGUSD: { altname: "XDGUSD", wsname: "XDG/USD", aclass_base: "currency", base: "XXDG", quote: "ZUSD", status: "online" },
  AAPLxUSD: { altname: "AAPLxUSD", wsname: "AAPLx/USD", aclass_base: "tokenized_asset", base: "AAPLx", quote: "ZUSD", status: "online" },
  USDCUSD: { altname: "USDCUSD", wsname: "USDC/USD", aclass_base: "currency", base: "USDC", quote: "ZUSD", status: "online" },
  TWOUSD: { altname: "TWOUSD", wsname: "TWO/USD", aclass_base: "currency", base: "TWO", quote: "ZUSD", status: "online" },
} };
const BS = [
  { name: "ZEC/USD", url_symbol: "zecusd", trading: "Enabled", description: "Zcash / U.S. dollar" },
  { name: "BTC/USD", url_symbol: "btcusd", trading: "Enabled", description: "Bitcoin / U.S. dollar" },
  { name: "DOGE/USD", url_symbol: "dogeusd", trading: "Enabled", description: "Dogecoin / U.S. dollar" },
  { name: "EUR/USD", url_symbol: "eurusd", trading: "Enabled", description: "Euro / U.S. dollar" },
  { name: "BTC/EUR", url_symbol: "btceur", trading: "Enabled", description: "Bitcoin / Euro" },
  { name: "DEAD/USD", url_symbol: "deadusd", trading: "Disabled", description: "Dead / U.S. dollar" },
];

test("each exchange list is read as USD pairs only, listed + trading only (Kraken XBT -> BTC, XDG -> DOGE, no tokenized stocks)", () => {
  assert.deepEqual([...parseCoinbaseProducts(CB).keys()].sort(), ["ETH", "ONLYCB", "TWO", "USDT", "ZEC"]);
  assert.deepEqual(parseCoinbaseProducts(CB).get("ZEC"), { api: "ZEC-USD", label: "ZEC-USD" });
  const kr = parseKrakenPairs(KR);
  assert.deepEqual([...kr.keys()].sort(), ["BTC", "DOGE", "ETH", "TWO", "USDC", "ZEC"]);
  assert.deepEqual(kr.get("ZEC"), { api: "ZECUSD", label: "ZEC/USD" });
  assert.deepEqual(kr.get("BTC"), { api: "XBTUSD", label: "XBT/USD" });
  const bs = parseBitstampPairs(BS);
  assert.deepEqual([...bs.pairs.keys()].sort(), ["BTC", "DOGE", "EUR", "ZEC"]);
  assert.deepEqual(bs.pairs.get("ZEC"), { api: "zecusd", label: "zecusd" });
  assert.equal(bs.names.get("ZEC"), "Zcash");
  for (const bad of [null, {}, "x", { result: null }]) {
    assert.equal(parseCoinbaseProducts(bad).size, 0); assert.equal(parseKrakenPairs(bad).size, 0); assert.equal(parseBitstampPairs(bad).pairs.size, 0);
  }
});

test("the default list = assets on at least 2 of the curated exchanges; stablecoins and fiat are excluded", () => {
  const list = mergeAssets({ coinbase: parseCoinbaseProducts(CB), kraken: parseKrakenPairs(KR), bitstamp: parseBitstampPairs(BS).pairs }, parseBitstampPairs(BS).names);
  const syms = list.map((a) => a.symbol);
  assert.deepEqual(syms.slice(0, 2), ["BTC", "ETH"]); // well-known first
  for (const s of ["ZEC", "DOGE", "TWO"]) assert.ok(syms.includes(s), s);
  for (const s of ["ONLYCB", "USDT", "USDC", "EUR", "OLD", "DEAD", "AAPLX", "AAPLx"]) assert.ok(!syms.includes(s), s);
  const zec = list.find((a) => a.symbol === "ZEC")!;
  assert.deepEqual(venuesOf(zec), ["coinbase", "bitstamp", "kraken"]);
  assert.equal(zec.name, "Zcash");
  assert.equal(list.find((a) => a.symbol === "TWO")!.name, "TWO"); // no name known: the symbol, never blank
  for (const s of ["USDC", "USDT", "DAI", "PYUSD", "EUR", "GBP"]) assert.ok(STABLE_OR_FIAT.has(s), s);
});

test("built-in fallback: BTC, ETH, ZEC, NEAR, SOL, each on >= 2 exchanges with real pair names; no stablecoins", () => {
  assert.deepEqual(FALLBACK_ASSETS.map((a) => a.symbol), ["BTC", "ETH", "ZEC", "NEAR", "SOL"]);
  for (const a of FALLBACK_ASSETS) assert.ok(venuesOf(a).length >= 2, a.symbol);
  assert.deepEqual(asset("NEAR").pairs, { coinbase: { api: "NEAR-USD", label: "NEAR-USD" }, bitstamp: { api: "nearusd", label: "nearusd" }, kraken: { api: "NEARUSD", label: "NEAR/USD" } });
});

function fakeFetch(map: Record<string, unknown>, calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    if (!(url in map)) throw new Error("network down");
    const v = map[url];
    if (v instanceof Error) throw v;
    return { ok: true, status: 200, json: async () => v } as Response;
  };
}
function memStore() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; }

test("loadMarketAssets: live lists (Kraken through the /_proxy route, it sends no CORS), cached; the form never breaks", async () => {
  assert.equal(MARKET_LIST_URLS.kraken, "/_proxy/kraken/0/public/AssetPairs");
  assert.equal(MARKET_LIST_URLS.coinbase, "https://api.exchange.coinbase.com/products");
  assert.equal(MARKET_LIST_URLS.bitstamp, "https://www.bitstamp.net/api/v2/trading-pairs-info/");
  const store = memStore();
  const calls: string[] = [];
  const live = await loadMarketAssets({ fetch: fakeFetch({ [MARKET_LIST_URLS.coinbase]: CB, [MARKET_LIST_URLS.kraken]: KR, [MARKET_LIST_URLS.bitstamp]: BS }, calls), storage: store, nowMs: NOW });
  assert.equal(live.live, true);
  assert.ok(live.assets.some((a) => a.symbol === "TWO"));
  assert.equal(calls.length, 3);
  // cached: a second load within the hour makes no request
  const again = await loadMarketAssets({ fetch: fakeFetch({}, calls), storage: store, nowMs: NOW + 30 * 60_000 });
  assert.equal(calls.length, 3);
  assert.deepEqual(again.assets, live.assets);
  assert.ok(store.m.has(MARKET_CACHE_KEY));
  // every exchange down and no cache: the built-in list
  const down = await loadMarketAssets({ fetch: fakeFetch({}), storage: memStore(), nowMs: NOW });
  assert.equal(down.live, false);
  assert.deepEqual(down.assets, FALLBACK_ASSETS);
  // one exchange down: the others still count, and the fallback assets are always present
  const part = await loadMarketAssets({ fetch: fakeFetch({ [MARKET_LIST_URLS.coinbase]: CB, [MARKET_LIST_URLS.bitstamp]: BS }), storage: memStore(), nowMs: NOW });
  assert.ok(part.assets.some((a) => a.symbol === "ZEC"));
  for (const f of FALLBACK_ASSETS) assert.ok(part.assets.some((a) => a.symbol === f.symbol), f.symbol);
});

test("search matches symbol or name, case-insensitively, symbol matches first", () => {
  const list = [...FALLBACK_ASSETS];
  assert.deepEqual(searchAssets(list, "zec").map((a) => a.symbol), ["ZEC"]);
  assert.deepEqual(searchAssets(list, "zcash").map((a) => a.symbol), ["ZEC"]);
  assert.deepEqual(searchAssets(list, "ether").map((a) => a.symbol), ["ETH"]);
  assert.deepEqual(searchAssets(list, "").map((a) => a.symbol), list.map((a) => a.symbol));
  assert.equal(findMarketAsset(list, "near")?.symbol, "NEAR");
});

test("live price: median of the exchanges that answer, per asset; null when none do", async () => {
  const zec = asset("ZEC");
  assert.equal(tickerUrl("coinbase", zec.pairs.coinbase!), "https://api.coinbase.com/v2/prices/ZEC-USD/spot");
  assert.equal(tickerUrl("bitstamp", zec.pairs.bitstamp!), "https://www.bitstamp.net/api/v2/ticker/zecusd/");
  assert.equal(tickerUrl("kraken", zec.pairs.kraken!), "/_proxy/kraken/0/public/Ticker?pair=ZECUSD");
  const f = fakeFetch({
    "https://api.coinbase.com/v2/prices/ZEC-USD/spot": { data: { amount: "962.08" } },
    "https://www.bitstamp.net/api/v2/ticker/zecusd/": { last: "960.62" },
    "/_proxy/kraken/0/public/Ticker?pair=ZECUSD": { error: [], result: { XZECZUSD: { c: ["961.20", "1"] } } },
  });
  assert.equal(await fetchAssetPrice(zec, f), 961.2);
  const two = fakeFetch({ "https://api.coinbase.com/v2/prices/ZEC-USD/spot": { data: { amount: "10" } }, "https://www.bitstamp.net/api/v2/ticker/zecusd/": { last: "20" } });
  assert.equal(await fetchAssetPrice(zec, two), 15);
  assert.equal(await fetchAssetPrice(zec, fakeFetch({})), null);
});

// --- the custom sheet for a non-Bitcoin asset
for (const sym of ["ZEC", "ETH", "NEAR"]) {
  test(`${sym} close-at-a-time: a custom sheet with the resolver's claim shape; passes the custom lint and the builder gate`, () => {
    const a = asset(sym);
    const s: any = assetPriceSheet("btc_close_at_t", a, CLOSE, NOW);
    assert.equal(templateId(s).id, "custom");
    assert.deepEqual(lintCustom(s), []);
    assert.deepEqual(customOpenProblems(s), []);
    assert.deepEqual(priceReadingProblems(s), []);
    assert.deepEqual(builderGate(s).problems, []);
    assert.equal(s.claim, `The median of the CLOSE of the 1-minute ${sym}-USD candle ending 2026-11-20T15:00:00Z on Coinbase, Bitstamp and Kraken is at least (>=) 950 USD.`);
    assert.equal(s.elements.length, 1);
    assert.match(s.elements[0].q, new RegExp(`^Is the median close of the 1-minute ${sym}-USD candle ending 2026-11-20T15:00:00Z on Coinbase, Bitstamp and Kraken at least \\(>=\\) 950 USD\\?$`));
    assert.deepEqual(s.time, { window_start: "2026-11-20T14:59:00Z", window_end: "2026-11-20T15:00:00Z", evidence_cutoff: "2026-11-27T15:00:00Z" });
    assert.equal(s.window_close, "2026-11-27T15:00:00Z");
    assert.equal(s.rule, "ALL");
    assert.deepEqual(s.clauses, ["UTC_V1", "BEFORE_INCLUSIVE_V1", "NUMERIC_EXACT_V1", "ROUNDING_PRECISION_V1", "NO_DATA_FALLBACK_V1"]);
    // 3 public 1-minute candle sources, the same hosts as the resolver's BTC venues; every publisher pinned to its pair
    const p = a.pairs;
    assert.deepEqual(s.sources_allowed.map((x: any) => x.publisher), [`Coinbase ${p.coinbase!.label}`, `Bitstamp ${p.bitstamp!.label}`, `Kraken ${p.kraken!.label}`]);
    assert.deepEqual(s.sources_allowed.map((x: any) => x.url), [
      `https://api.exchange.coinbase.com/products/${p.coinbase!.api}/candles?granularity=60`,
      `https://www.bitstamp.net/api/v2/ohlc/${p.bitstamp!.api}/?step=60&limit=5&start=${Date.parse("2026-11-20T14:59:00Z") / 1000}`,
      `https://api.kraken.com/0/public/OHLC?pair=${p.kraken!.api}&interval=1&since=${Date.parse("2026-11-20T14:58:00Z") / 1000}`,
    ]);
    assert.deepEqual(s.ticker_pins, Object.fromEntries(s.sources_allowed.map((x: any) => [x.publisher, x.publisher.split(" ")[1]])));
    assert.deepEqual(customSourceHosts(s), ["api.exchange.coinbase.com", "www.bitstamp.net", "api.kraken.com"]);
    const defs = s.custom_definitions.join(" ");
    assert.match(defs, /median close/);
    assert.match(defs, /never the high \(wick\)/);
    assert.ok(s.custom_definitions.includes(ASSET_PRICE_RULE_ONLY_PAIR(`${sym}-USD`)));
    assert.match(ASSET_PRICE_RULE_ONLY_PAIR(`${sym}-USD`), /no aggregators/);
    assert.equal(customDeadlineSecs(s), Date.parse("2026-11-20T15:00:00Z") / 1000);
  });

  test(`${sym} touches a price: custom sheet, high/low wick rule, confirmed on at least two venues; passes the lints`, () => {
    const s: any = assetPriceSheet("btc_touch", asset(sym), TOUCH, NOW);
    assert.deepEqual(lintCustom(s), []);
    assert.deepEqual(builderGate(s).problems, []);
    assert.equal(s.claim, `${sym}-USD 1-minute candle high is at or above 1200 USD on at least two of Coinbase, Bitstamp, Kraken between 2026-11-12T16:00:00Z and 2026-11-27T12:00:00Z.`);
    assert.deepEqual(s.time, { window_start: "2026-11-12T16:00:00Z", window_end: "2026-11-27T12:00:00Z", evidence_cutoff: "2026-12-04T12:00:00Z" });
    assert.match(s.custom_definitions.join(" "), /HIGH \(the wick\), not the close/);
    assert.ok(s.sources_allowed.every((x: any) => !/start=|since=|end=/.test(x.url))); // the latest candles: reachable at open, archived while live
  });
}

test("a pair on only two exchanges gets two sources (a mean of two) and still passes; fewer than two is refused", () => {
  const two: MarketAsset = { symbol: "TWO", name: "Two", pairs: { coinbase: { api: "TWO-USD", label: "TWO-USD" }, kraken: { api: "TWOUSD", label: "TWO/USD" } } };
  const s: any = assetPriceSheet("btc_close_at_t", two, CLOSE, NOW);
  assert.equal(s.sources_allowed.length, 2);
  assert.match(s.claim, /on Coinbase and Kraken is at least/);
  assert.deepEqual(builderGate(s).problems, []);
  const t: any = assetPriceSheet("btc_touch", two, TOUCH, NOW);
  assert.match(t.claim, /on both Coinbase and Kraken between/);
  assert.deepEqual(builderGate(t).problems, []);
  const one: MarketAsset = { symbol: "ONE", name: "One", pairs: { coinbase: { api: "ONE-USD", label: "ONE-USD" } } };
  const p = assetPriceProblems("btc_close_at_t", one, CLOSE, NOW);
  assert.equal(p.length, 1);
  assert.match(p[0], /^PRICE_TOO_FEW_VENUES:/);
  assert.ok(plainProblem(p[0]).mapped);
});

test("a non-Bitcoin price can have cents (DOGE at $0.25); a non-number or a zero price is refused with a plain message", () => {
  const z = asset("ZEC");
  assert.deepEqual(assetPriceProblems("btc_close_at_t", z, { ...CLOSE, x_usd: "0.25" }, NOW), []);
  assert.match((assetPriceSheet("btc_close_at_t", z, { ...CLOSE, x_usd: "0.25" }, NOW) as any).claim, /at least \(>=\) 0\.25 USD/);
  for (const bad of ["abc", "0", "-3", "1e5", "1,000"]) {
    const p = assetPriceProblems("btc_close_at_t", z, { ...CLOSE, x_usd: bad }, NOW);
    assert.match(p[0] ?? "", /^PRICE_LEVEL_NOT_POSITIVE:/, bad);
    assert.ok(plainProblem(p[0]).mapped);
  }
  // the time / comparison checks are the typed lint's own (same named errors as Bitcoin)
  assert.match(assetPriceProblems("btc_close_at_t", z, { ...CLOSE, op: "" }, NOW).join(" "), /TPL_MISSING_FIELD: btc_close_at_t\.op/);
  assert.match(assetPriceProblems("btc_touch", z, { ...TOUCH, deadline_utc: "" }, NOW).join(" "), /TPL_MISSING_FIELD: btc_touch\.deadline_utc/);
});

test("the fill step: Bitcoin (the default) stays the typed template; another asset becomes the custom sheet", () => {
  const btc: FillState = { ...blankFill("btc_close_at_t"), guided: CLOSE };
  assert.equal(templateId(typedSheetFor(btc, NOW)).id, "btc_close_at_t");
  assert.equal(templateId(typedSheetFor({ ...btc, asset: asset("BTC") }, NOW)).id, "btc_close_at_t");
  const zec: FillState = { ...btc, asset: asset("ZEC") };
  assert.equal(templateId(typedSheetFor(zec, NOW)).id, "custom");
  assert.deepEqual(fillProblems(zec, NOW), []);
  assert.deepEqual(fillProblems({ ...zec, guided: { ...CLOSE, x_usd: "962.5" } }, NOW), []); // cents OK for an alt
  assert.match(fillProblems({ ...btc, guided: { ...CLOSE, x_usd: "962.5" } }, NOW)[0], /TPL_X_USD_NOT_WHOLE/); // Bitcoin unchanged
  assert.equal(betSentence(zec), "You are betting that the Zcash (ZEC) price at 2026-11-20 15:00 UTC is at or above $950. The other person bets it won't happen.");
  assert.match(betSentence({ ...blankFill("btc_touch"), guided: TOUCH, asset: asset("ETH") }), /^You are betting that Ethereum \(ETH\) touches \$1,200 \(at or above\) before 2026-11-27 12:00 UTC\./);
  assert.equal(betSentence({ ...zec, guided: { ...CLOSE, x_usd: "0.25" } }), "You are betting that the Zcash (ZEC) price at 2026-11-20 15:00 UTC is at or above $0.25. The other person bets it won't happen.");
});

test("who decides: Bitcoin is decided by code; any other asset by the AI judge reading the named venues", () => {
  assert.equal(deciderLine(buildTypedSheet("btc_close_at_t", { t_utc: "2026-11-20T15:00:00Z", op: ">=", x_usd: 1, open_utc: "2026-11-12T16:00:00Z" })),
    "Decided by code from Coinbase, Bitstamp and Kraken 1-minute prices");
  assert.equal(deciderLine(assetPriceSheet("btc_close_at_t", asset("ZEC"), CLOSE, NOW)), "Decided by the AI judge reading Coinbase ZEC-USD, Bitstamp zecusd and Kraken ZEC/USD");
  assert.equal(deciderLine({ claim: "x" }), null); // any other bet: the existing line
  assert.equal(deciderLine(buildTypedSheet("nws_daily_high", { station: "KNYC" })), null);
});

test("the price cards say any listed coin, not only Bitcoin", () => {
  for (const id of ["btc_close_at_t", "btc_touch"]) {
    const c = BET_TYPE_CARDS.find((x) => x.id === id)!;
    assert.doesNotMatch(c.title, /Bitcoin/); // PM 14:05: plain words ("Price at a set time", "Hits a price")
    assert.match(c.blurb, /Bitcoin, Ethereum, Zcash/);
  }
  assert.match(PICKER_TILES.find((t) => t.id === "prices")!.blurb, /Bitcoin, Ethereum, Zcash or any listed coin/);
});

test("the form's labels name the chosen coin; only Bitcoin asks for whole dollars", async () => {
  const { guidedFieldsFor } = await import("../lib/betTypePicker");
  const lbl = (f: FillState, k: string) => guidedFieldsFor(f).find((g) => g.key === k)!.label;
  const btc = blankFill("btc_close_at_t");
  assert.equal(lbl(btc, "t_utc"), "Check the Bitcoin price at (UTC)");
  assert.equal(lbl(btc, "x_usd"), "Price level (whole US dollars)");
  const zec = { ...btc, asset: asset("ZEC") };
  assert.equal(lbl(zec, "t_utc"), "Check the Zcash price at (UTC)");
  assert.equal(lbl(zec, "x_usd"), "Price level (US dollars)");
  assert.equal(lbl({ ...blankFill("btc_touch"), asset: asset("ETH") }, "direction"), "Ethereum touches");
  assert.equal(lbl(blankFill("btc_touch"), "direction"), "Bitcoin touches");
  assert.equal(guidedFieldsFor(blankFill("nws_daily_high")).find((g) => g.key === "station")!.label, "City");
});

test("the fill step's decider and venues lines match the sheet's", async () => {
  const { assetDeciderText, assetVenuesText } = await import("../lib/assetPriceSheet");
  for (const s of ["ZEC", "ETH", "NEAR"]) assert.equal(assetDeciderText(asset(s)), deciderLine(assetPriceSheet("btc_touch", asset(s), TOUCH, NOW)));
  assert.equal(assetDeciderText(undefined), "Decided by code from Coinbase, Bitstamp and Kraken 1-minute prices");
  assert.equal(assetDeciderText(asset("BTC")), assetDeciderText(undefined));
  assert.equal(assetVenuesText(asset("ZEC")), "Checked on Coinbase ZEC-USD, Bitstamp zecusd and Kraken ZEC/USD");
});

test("a copied non-Bitcoin price bet with a past time is flagged like a Bitcoin one", async () => {
  const { pastFillKeys } = await import("../lib/duplicateBet");
  const past = { ...blankFill("btc_close_at_t"), guided: { ...CLOSE, t_utc: "2026-11-01T15:00" }, asset: asset("ZEC") };
  assert.deepEqual(pastFillKeys(past, NOW), ["t_utc"]);
  assert.deepEqual(pastFillKeys({ ...past, guided: CLOSE }, NOW), []);
});

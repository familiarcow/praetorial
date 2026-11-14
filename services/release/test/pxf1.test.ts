// PXF1: deploy-day price fetcher. All tests use recorded fixtures (shapes captured from the live public
// endpoints on 2026-11-09); NO network. Fail closed: any problem refuses, no partial output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coinbase, kraken, coingecko, fetchPrices, mergePrices, renderPriceTable, PXF1_ASSETS, type Http, type HttpResp, type Adapter } from "../src/prices.js";
import { generate, ReleaseError, type ReleaseInput } from "../src/gen.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(here, "..", "example");
const FETCH_MS = Date.UTC(2026, 10, 9, 14, 6, 23); // matches the Date header below
const DATE = "Mon, 09 Nov 2026 14:06:23 GMT";
const MIN = 60_000;

// ---- recorded fixtures ----
const CB: Record<string, string> = {
  BTC: '{"data":{"amount":"74482.845","base":"BTC","currency":"USD"}}',
  ETH: '{"data":{"amount":"2117.305","base":"ETH","currency":"USD"}}',
  NEAR: '{"data":{"amount":"3.5385","base":"NEAR","currency":"USD"}}',
  ZEC: '{"data":{"amount":"1213.14","base":"ZEC","currency":"USD"}}',
};
const kr = (key: string, c: string) => `{"error":[],"result":{"${key}":{"a":["${c}","1","1.000"],"b":["${c}","1","1.000"],"c":["${c}","0.0798"],"v":["1","2"],"p":["1","2"],"t":[1,2],"l":["1","2"],"h":["1","2"],"o":"1"}}}`;
const KR: Record<string, string> = {
  BTC: kr("XXBTZUSD", "74488.40000"), ETH: kr("XETHZUSD", "2117.37000"), NEAR: kr("NEARUSD", "3.53940"), ZEC: kr("XZECZUSD", "1213.00000"),
};
const CG_ID: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", NEAR: "near", ZEC: "zcash" };
const CG_VAL: Record<string, string> = { BTC: "74560.17042144127", ETH: "2119.995707208267", NEAR: "3.5414421570437855", ZEC: "1214.7497421072624" };
const cg = (sym: string) => `{"${CG_ID[sym]}":{"usd":${CG_VAL[sym]},"last_updated_at":${Math.floor(FETCH_MS / 1000) - 5}}}`;

const ok = (body: string, date: string | null = DATE): HttpResp => ({ status: 200, body, date });
/** A fake http that routes by URL; `over` can replace a response for a symbol/provider. */
function fakeHttp(over: (url: string) => HttpResp | undefined = () => undefined): Http {
  return async (url: string) => {
    const o = over(url);
    if (o) return o;
    const cb = /coinbase\.com\/v2\/prices\/([A-Z]+)-USD\/spot/.exec(url);
    if (cb) return ok(CB[cb[1]]);
    const k = /kraken\.com\/0\/public\/Ticker\?pair=([A-Z]+)/.exec(url);
    if (k) return ok(KR[{ XBTUSD: "BTC", ETHUSD: "ETH", NEARUSD: "NEAR", ZECUSD: "ZEC" }[k[1]]!]);
    const g = /coingecko\.com\/api\/v3\/simple\/price\?ids=([a-z]+)/.exec(url);
    if (g) return ok(cg(Object.keys(CG_ID).find((s) => CG_ID[s] === g[1])!), null);
    throw new Error(`unexpected url ${url}`);
  };
}

// ---- adapters parse their fixtures ----
test("PXF1: assets list is BTC, ETH, NEAR, ZEC", () => {
  assert.deepEqual([...PXF1_ASSETS], ["BTC", "ETH", "NEAR", "ZEC"]);
});

test("PXF1: coinbase adapter -> plain decimal string + ts_ms (Date header)", async () => {
  const q = await coinbase.fetch(fakeHttp(), "BTC");
  assert.deepEqual(q, { provider: "coinbase", pair: "BTC-USD", price: "74482.845", ts_ms: FETCH_MS });
});

test("PXF1: kraken adapter parses the aliased result key (XBTUSD -> XXBTZUSD)", async () => {
  const q = await kraken.fetch(fakeHttp(), "BTC");
  assert.equal(q.provider, "kraken");
  assert.equal(q.pair, "XBTUSD");
  assert.equal(q.price, "74488.40000");
  assert.equal(q.ts_ms, FETCH_MS);
  assert.equal((await kraken.fetch(fakeHttp(), "NEAR")).price, "3.53940");
  assert.equal((await kraken.fetch(fakeHttp(), "ZEC")).pair, "ZECUSD");
});

test("PXF1: coingecko adapter -> plain decimal (no exponent), ts from last_updated_at", async () => {
  const q = await coingecko.fetch(fakeHttp(), "ETH");
  assert.equal(q.provider, "coingecko");
  assert.equal(q.pair, "ethereum/usd");
  assert.equal(q.price, "2119.995707208267");
  assert.equal(q.ts_ms, (Math.floor(FETCH_MS / 1000) - 5) * 1000);
  const tiny = await coingecko.fetch(fakeHttp((u) => (u.includes("coingecko") ? ok('{"near":{"usd":1e-7,"last_updated_at":1794233164}}') : undefined)), "NEAR");
  assert.match(tiny.price, /^[0-9]+\.[0-9]+$/);
});

// ---- fetchPrices: two providers ----
test("PXF1: fetchPrices returns a row per asset with two different providers and diff %", async () => {
  const rows = await fetchPrices({ http: fakeHttp(), providers: [coinbase, kraken], now_ms: FETCH_MS });
  assert.deepEqual(rows.map((r) => r.asset), ["BTC", "ETH", "NEAR", "ZEC"]);
  const btc = rows[0];
  assert.equal(btc.a.provider, "coinbase");
  assert.equal(btc.b.provider, "kraken");
  assert.ok(btc.diff_pct > 0 && btc.diff_pct < 0.1, String(btc.diff_pct));
  const t = renderPriceTable(rows);
  for (const w of ["BTC", "74482.845", "74488.40000", "coinbase", "kraken"]) assert.ok(t.includes(w), w);
});

test("PXF1: coinbase + coingecko is also a valid pair", async () => {
  const rows = await fetchPrices({ http: fakeHttp(), providers: [coinbase, coingecko], now_ms: FETCH_MS });
  assert.equal(rows[0].b.provider, "coingecko");
});

test("PXF1: the same provider twice is refused", async () => {
  await assert.rejects(fetchPrices({ http: fakeHttp(), providers: [coinbase, coinbase], now_ms: FETCH_MS }), /two different providers/i);
  await assert.rejects(fetchPrices({ http: fakeHttp(), providers: [coinbase], now_ms: FETCH_MS }), /two different providers/i);
});

test("PXF1: >2% disagreement refused, naming the asset and both prices", async () => {
  const http = fakeHttp((u) => (u.includes("Ticker?pair=ETHUSD") ? ok(kr("XETHZUSD", "2200.00000")) : undefined)); // ~3.9% above 2117.305
  await assert.rejects(fetchPrices({ http, providers: [coinbase, kraken], now_ms: FETCH_MS }), (e: Error) => /ETH/.test(e.message) && /2117\.305/.test(e.message) && /2200\.00000/.test(e.message) && /2%/.test(e.message));
});

test("PXF1: exactly 2% is accepted, just above is refused", async () => {
  const at = fakeHttp((u) => (u.includes("Ticker?pair=BTCUSD") || u.includes("Ticker?pair=XBTUSD") ? ok(kr("XXBTZUSD", "102.0")) : u.includes("prices/BTC-USD") ? ok('{"data":{"amount":"100.0","base":"BTC","currency":"USD"}}') : undefined));
  const rows = await fetchPrices({ http: at, providers: [coinbase, kraken], assets: ["BTC"], now_ms: FETCH_MS });
  assert.equal(rows[0].diff_pct, 2);
  const over = fakeHttp((u) => (u.includes("Ticker?pair=XBTUSD") ? ok(kr("XXBTZUSD", "102.01")) : u.includes("prices/BTC-USD") ? ok('{"data":{"amount":"100.0","base":"BTC","currency":"USD"}}') : undefined));
  await assert.rejects(fetchPrices({ http: over, providers: [coinbase, kraken], assets: ["BTC"], now_ms: FETCH_MS }), /BTC/);
});

// ---- fail closed ----
const refuses = (name: string, over: (u: string) => HttpResp | undefined, re: RegExp, providers: Adapter[] = [coinbase, kraken]) =>
  test(`PXF1 refuses: ${name}`, async () => {
    await assert.rejects(fetchPrices({ http: fakeHttp(over), providers, now_ms: FETCH_MS }), re);
  });
refuses("coinbase HTTP error", (u) => (u.includes("prices/ZEC-USD") ? { status: 503, body: "oops", date: DATE } : undefined), /coinbase.*ZEC.*503|ZEC.*coinbase.*503/);
refuses("kraken HTTP error", (u) => (u.includes("Ticker") && u.includes("NEARUSD") ? { status: 429, body: "", date: DATE } : undefined), /kraken.*429/);
refuses("kraken API error array", (u) => (u.includes("Ticker?pair=ETHUSD") ? ok('{"error":["EQuery:Unknown asset pair"]}') : undefined), /kraken.*ETH/);
refuses("coinbase non-USD quote", (u) => (u.includes("prices/BTC-USD") ? ok('{"data":{"amount":"74482.845","base":"BTC","currency":"EUR"}}') : undefined), /BTC.*non-USD|non-USD.*BTC/i);
refuses("coinbase wrong base asset", (u) => (u.includes("prices/BTC-USD") ? ok('{"data":{"amount":"74482.845","base":"ETH","currency":"USD"}}') : undefined), /BTC/);
refuses("kraken non-USD pair key", (u) => (u.includes("Ticker?pair=XBTUSD") ? ok(kr("XXBTZEUR", "74000.0")) : undefined), /non-USD/i);
refuses("coingecko missing usd quote", (u) => (u.includes("ids=zcash") ? ok('{"zcash":{"eur":1100.1,"last_updated_at":1794233164}}', null) : undefined), /coingecko.*ZEC/, [coinbase, coingecko]);
refuses("missing asset in coingecko reply", (u) => (u.includes("ids=near") ? ok("{}", null) : undefined), /coingecko.*NEAR/, [coinbase, coingecko]);
for (const bad of ["NaN", "-1", "0", "0.0", "", "abc", "1e5", "Infinity"]) {
  refuses(`coinbase amount ${JSON.stringify(bad)}`, (u) => (u.includes("prices/ETH-USD") ? ok(`{"data":{"amount":"${bad}","base":"ETH","currency":"USD"}}`) : undefined), /ETH/);
}
refuses("coingecko negative number", (u) => (u.includes("ids=ethereum") ? ok('{"ethereum":{"usd":-5,"last_updated_at":1794233164}}', null) : undefined), /ETH/, [coinbase, coingecko]);
refuses("coingecko zero number", (u) => (u.includes("ids=ethereum") ? ok('{"ethereum":{"usd":0,"last_updated_at":1794233164}}', null) : undefined), /ETH/, [coinbase, coingecko]);
refuses("coingecko NaN-ish (null)", (u) => (u.includes("ids=ethereum") ? ok('{"ethereum":{"usd":null,"last_updated_at":1794233164}}', null) : undefined), /ETH/, [coinbase, coingecko]);
refuses("coinbase absent timestamp (no Date header)", (u) => (u.includes("prices/BTC-USD") ? ok(CB.BTC, null) : undefined), /BTC.*timestamp|timestamp.*BTC/i);
refuses("unparseable Date header", (u) => (u.includes("prices/BTC-USD") ? ok(CB.BTC, "garbage") : undefined), /timestamp/i);
refuses("kraken absent timestamp", (u) => (u.includes("Ticker?pair=XBTUSD") ? ok(KR.BTC, null) : undefined), /timestamp/i);
refuses("coingecko absent last_updated_at", (u) => (u.includes("ids=bitcoin") ? ok('{"bitcoin":{"usd":74000.5}}', null) : undefined), /timestamp/i, [coinbase, coingecko]);
refuses("non-JSON body", (u) => (u.includes("prices/BTC-USD") ? ok("<html>") : undefined), /coinbase.*BTC/);

test("PXF1: a failing asset yields no partial output (rejects, returns nothing)", async () => {
  let got: unknown = "untouched";
  try { got = await fetchPrices({ http: fakeHttp((u) => (u.includes("prices/ZEC-USD") ? { status: 500, body: "", date: DATE } : undefined)), providers: [coinbase, kraken], now_ms: FETCH_MS }); } catch { /* expected */ }
  assert.equal(got, "untouched");
});

// ---- merge into the release input ----
const exampleInput = (): ReleaseInput => JSON.parse(readFileSync(join(EXAMPLE, "input.indicative.json"), "utf8"));

test("PXF1: merged output passes generate() unchanged with now_ms = fetch time; stables get no price fields", async () => {
  const rows = await fetchPrices({ http: fakeHttp(), providers: [coinbase, kraken], now_ms: FETCH_MS });
  const merged = mergePrices(exampleInput(), rows);
  for (const a of merged.assets) {
    if (a.kind === "stable") for (const k of ["price_usd", "price_ts_ms", "second_price_usd", "second_price_ts_ms", "price_source", "second_price_source"]) assert.ok(!(k in a), `${a.token_id} has ${k}`);
  }
  const wnear = merged.assets.find((a) => a.token_id === "nep141:wrap.near")!;
  assert.equal(wnear.price_usd, "3.5385");
  assert.equal(wnear.second_price_usd, "3.53940");
  assert.equal(merged.near_price.price_usd, "3.5385");
  assert.equal(merged.near_price.second_price_ts_ms, FETCH_MS);
  assert.equal(merged.assets.find((a) => a.token_id === "nep141:btc.omft.near")!.price_usd, "74482.845");
  const r = generate(merged, { now_ms: FETCH_MS, network: "mainnet" });
  assert.equal(r.args.asset_limits.length, 6);
  // the fetcher does not bypass gen's staleness check
  assert.throws(() => generate(merged, { now_ms: FETCH_MS + 31 * MIN, network: "mainnet" }), (e: unknown) => e instanceof ReleaseError && /older than 30 min/.test(e.message));
  // ...and 29 min later is still fine
  generate(merged, { now_ms: FETCH_MS + 29 * MIN, network: "mainnet" });
});

test("PXF1: merge does not mutate its input and refuses a volatile asset it cannot price", async () => {
  const rows = await fetchPrices({ http: fakeHttp(), providers: [coinbase, kraken], now_ms: FETCH_MS });
  const inp = exampleInput();
  const snap = JSON.stringify(inp);
  mergePrices(inp, rows);
  assert.equal(JSON.stringify(inp), snap);
  const odd = exampleInput();
  odd.assets.push({ token_id: "nep141:doge.omft.near", decimals: 8, kind: "volatile" });
  assert.throws(() => mergePrices(odd, rows), /doge\.omft\.near/);
  assert.throws(() => mergePrices(exampleInput(), rows.filter((r) => r.asset !== "ZEC")), /ZEC/);
});

// ---- CLI ----
test("PXF1: CLI `prices` is wired (refuses an unknown provider without touching the network)", () => {
  const d = mkdtempSync(join(tmpdir(), "pxf1-"));
  const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "..", "src", "cli.ts"), "prices", "--input", join(EXAMPLE, "input.indicative.json"), "--out", join(d, "o.json"), "--providers", "coinbase,coinbase"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /two different providers/i);
});

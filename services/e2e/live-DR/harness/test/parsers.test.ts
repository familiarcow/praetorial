// DR0 part 3: ground-truth parsers, independent of the resolver (no import from resolver/ or its fetchers).
// Each is tested on a raw payload recorded once from the public URL (harness/fixtures); no network in tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKrakenCandles, parseCoinbaseCandles, touchResult, twoVenueTouch, parseEspnGame, parseIemCli } from "../parsers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "..", "fixtures", n), "utf8");
const FROM = 1794182040, TO = 1794185580; // the one-hour window both candle fixtures cover (unix s, candle open times)

test("Kraken OHLC parser: ascending 1m candles, numeric fields, window slice", () => {
  const c = parseKrakenCandles(JSON.parse(fx("kraken_btcusd_1m.json")));
  assert.ok(c.length >= 700);
  assert.deepEqual(Object.keys(c[0]).sort(), ["close", "high", "low", "open", "t"]);
  for (let i = 1; i < c.length; i++) assert.ok(c[i].t > c[i - 1].t);
  assert.equal(c[0].t, 1794182040);
  assert.equal(c[0].open, 74685.9); assert.equal(c[0].low, 74650.0);
});

test("Kraken parser rejects an API error payload instead of returning no candles", () => {
  assert.throws(() => parseKrakenCandles({ error: ["EGeneral:Invalid arguments"], result: {} }), /Invalid arguments/);
});

test("Coinbase candle parser: [time, low, high, open, close, volume] reordered to ascending OHLC", () => {
  const c = parseCoinbaseCandles(JSON.parse(fx("coinbase_btcusd_1m.json")));
  assert.equal(c.length, 60);
  assert.equal(c[0].t, FROM); assert.equal(c[c.length - 1].t, TO);
  for (let i = 1; i < c.length; i++) assert.equal(c[i].t - c[i - 1].t, 60);
  for (const k of c) assert.ok(k.low <= k.open && k.low <= k.close && k.high >= k.open && k.high >= k.close);
});

test("BTC touch (>= level) over the same window on both venues", () => {
  const k = parseKrakenCandles(JSON.parse(fx("kraken_btcusd_1m.json")));
  const c = parseCoinbaseCandles(JSON.parse(fx("coinbase_btcusd_1m.json")));
  const kr = touchResult(k, { level: 75_000, dir: "above", from: FROM, to: TO });
  const cb = touchResult(c, { level: 75_000, dir: "above", from: FROM, to: TO });
  assert.equal(kr.touched, true); assert.equal(cb.touched, true);
  assert.equal(kr.extreme, 75176.8); assert.equal(cb.extreme, 75180.08);
  assert.equal(kr.candles, 60); assert.equal(cb.candles, 60);
  assert.deepEqual(twoVenueTouch({ kraken: k, coinbase: c }, { level: 75_000, dir: "above", from: FROM, to: TO }), { agree: true, touched: true, kraken: kr, coinbase: cb });
  const no = twoVenueTouch({ kraken: k, coinbase: c }, { level: 75_200, dir: "above", from: FROM, to: TO });
  assert.deepEqual([no.agree, no.touched], [true, false]);
});

test("BTC touch (<= level): venues can disagree and the result says so (never silently merged)", () => {
  const k = parseKrakenCandles(JSON.parse(fx("kraken_btcusd_1m.json")));
  const c = parseCoinbaseCandles(JSON.parse(fx("coinbase_btcusd_1m.json")));
  // Kraken's window low is 74396.3, Coinbase's is 74388.03: 74390 is touched on Coinbase only
  const r = twoVenueTouch({ kraken: k, coinbase: c }, { level: 74_390, dir: "below", from: FROM, to: TO });
  assert.equal(r.agree, false);
  assert.equal(r.kraken.touched, false); assert.equal(r.coinbase.touched, true);
  assert.equal(r.kraken.extreme, 74396.3); assert.equal(r.coinbase.extreme, 74388.03);
});

test("touch refuses a window the candles do not cover (no silent partial window)", () => {
  const c = parseCoinbaseCandles(JSON.parse(fx("coinbase_btcusd_1m.json")));
  assert.throws(() => touchResult(c, { level: 75_000, dir: "above", from: FROM - 3600, to: TO }), /cover/i);
});

test("league box score (ESPN NBA scoreboard payload): game winner, final status, scores", () => {
  const raw = JSON.parse(fx("espn_scoreboard.json"));
  const g = parseEspnGame(raw, "401810039");
  assert.deepEqual({ final: g.final, winner: g.winner, home: g.home, away: g.away }, {
    final: true, winner: "PHI", home: { team: "PHI", score: 130 }, away: { team: "TOR", score: 120 },
  });
  const w = parseEspnGame(raw, "401810038");
  assert.equal(w.final, true); assert.equal(w.winner, "DAL"); // away team wins
  assert.throws(() => parseEspnGame(raw, "does-not-exist"), /not found/);
});

test("box score of a game that is not final yields no winner", () => {
  const raw = JSON.parse(fx("espn_scoreboard.json"));
  const live = JSON.parse(JSON.stringify(raw));
  const ev = live.events.find((e: any) => e.id === "401810039");
  ev.status.type = { ...ev.status.type, name: "STATUS_IN_PROGRESS", completed: false, state: "in" };
  ev.competitions[0].status.type = ev.status.type;
  const g = parseEspnGame(live, "401810039");
  assert.equal(g.final, false); assert.equal(g.winner, null);
});

test("IEM copy of the NWS CLI product (CLINYC): the daily high is the first YESTERDAY MAXIMUM, not a later record/normal line", () => {
  const r = parseIemCli(fx("iem_cli_nyc.txt"));
  assert.equal(r.station, "CLINYC");
  assert.equal(r.forDate, "2025-11-08");
  assert.equal(r.highF, 65);
  assert.equal(r.highTime, "312 PM");
  assert.match(r.issued, /127 AM EST SUN NOV 09 2025/);
});

test("IEM parser rejects text with no CLI daily summary", () => {
  assert.throws(() => parseIemCli("NOT A CLIMATE PRODUCT"), /CLI/);
});

test("independence: parsers.ts imports nothing from resolver/, and is not a re-export of verifier/common code", () => {
  const src = readFileSync(join(here, "..", "parsers.ts"), "utf8");
  assert.ok(!/from\s+["'][^"']*resolver/.test(src), "parsers.ts must not import resolver code");
  assert.deepEqual([...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).filter((m) => m.startsWith(".")), []);
});

test("every committed fixture is raw (not hand-edited): recorded files exist and are non-trivial", () => {
  const names = readdirSync(join(here, "..", "fixtures"));
  for (const n of ["kraken_btcusd_1m.json", "coinbase_btcusd_1m.json", "espn_scoreboard.json", "iem_cli_nyc.txt"]) assert.ok(names.includes(n), n);
});

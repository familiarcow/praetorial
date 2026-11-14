// DR0 part 3: ground-truth parsers for the rehearsal checks. Deliberately INDEPENDENT of the resolver (no imports at all):
// a bug in the resolver's own fetch/parse code must not be able to hide behind the same bug here.
export interface Candle { t: number; open: number; high: number; low: number; close: number }

/** Kraken public OHLC (GET /0/public/OHLC): result.<pair> = [[time, o, h, l, c, vwap, volume, count], ...] (strings). */
export function parseKrakenCandles(body: any): Candle[] {
  if (Array.isArray(body?.error) && body.error.length) throw new Error(`Kraken error: ${body.error.join("; ")}`);
  const pair = Object.keys(body?.result ?? {}).find((k) => k !== "last");
  if (!pair || !Array.isArray(body.result[pair])) throw new Error("Kraken payload has no candle array");
  const out = (body.result[pair] as any[]).map((r) => ({ t: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) }));
  return sorted(out);
}

/** Coinbase Exchange candles (GET /products/<id>/candles): [[time, low, high, open, close, volume], ...], newest first. */
export function parseCoinbaseCandles(body: any): Candle[] {
  if (!Array.isArray(body)) throw new Error(`Coinbase payload is not a candle array: ${JSON.stringify(body).slice(0, 120)}`);
  return sorted(body.map((r: number[]) => ({ t: Number(r[0]), low: Number(r[1]), high: Number(r[2]), open: Number(r[3]), close: Number(r[4]) })));
}

function sorted(c: Candle[]): Candle[] {
  for (const k of c) if (![k.t, k.open, k.high, k.low, k.close].every(Number.isFinite)) throw new Error("non-numeric candle field");
  return c.sort((a, b) => a.t - b.t);
}

export interface TouchSpec { level: number; dir: "above" | "below"; from: number; to: number }
export interface TouchResult { touched: boolean; extreme: number; candles: number; firstTouchT: number | null }

/** Did price touch `level` in the candles opening in [from, to]? Uses candle highs (above) / lows (below). The window must be fully covered. */
export function touchResult(candles: Candle[], s: TouchSpec): TouchResult {
  const w = candles.filter((c) => c.t >= s.from && c.t <= s.to);
  const first = candles[0]?.t, last = candles[candles.length - 1]?.t;
  if (!w.length || first > s.from || last < s.to) throw new Error(`candles do not cover the window ${s.from}..${s.to} (have ${first}..${last})`);
  if (w.length !== (s.to - s.from) / 60 + 1) throw new Error(`candle gap inside the window: ${w.length} candles for ${(s.to - s.from) / 60 + 1} minutes`);
  const hit = w.find((c) => (s.dir === "above" ? c.high >= s.level : c.low <= s.level));
  const extreme = s.dir === "above" ? Math.max(...w.map((c) => c.high)) : Math.min(...w.map((c) => c.low));
  return { touched: !!hit, extreme, candles: w.length, firstTouchT: hit ? hit.t : null };
}

/** Same window on both venues. `agree` is false when they differ; the caller must treat that as an unresolved/diverging case. */
export function twoVenueTouch(v: { kraken: Candle[]; coinbase: Candle[] }, s: TouchSpec) {
  const kraken = touchResult(v.kraken, s), coinbase = touchResult(v.coinbase, s);
  return { agree: kraken.touched === coinbase.touched, touched: kraken.touched && coinbase.touched, kraken, coinbase };
}

export interface Game { id: string; final: boolean; home: { team: string; score: number }; away: { team: string; score: number }; winner: string | null }

/** ESPN site API league payload (scoreboard/summary event). Winner only when the game is final and the scores differ. */
export function parseEspnGame(body: any, eventId: string): Game {
  const ev = (body?.events ?? []).find((e: any) => String(e.id) === String(eventId));
  if (!ev) throw new Error(`event ${eventId} not found in payload`);
  const comp = ev.competitions?.[0];
  const side = (ha: string) => {
    const c = (comp?.competitors ?? []).find((x: any) => x.homeAway === ha);
    if (!c) throw new Error(`event ${eventId}: no ${ha} competitor`);
    return { team: String(c.team.abbreviation), score: Number(c.score) };
  };
  const home = side("home"), away = side("away");
  const final = ev.status?.type?.completed === true && ev.status?.type?.name === "STATUS_FINAL";
  const winner = final && home.score !== away.score ? (home.score > away.score ? home.team : away.team) : null;
  return { id: String(ev.id), final, home, away, winner };
}

export interface CliDaily { station: string; forDate: string; highF: number; highTime: string; issued: string }
const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

/** IEM's copy of an NWS CLI text product. The daily high is the first MAXIMUM row under TEMPERATURE (F) / YESTERDAY (observed value, local time). */
export function parseIemCli(text: string): CliDaily {
  const pil = text.match(/^\s*(CLI[A-Z]{3})\s*$/m);
  const sum = text.match(/CLIMATE SUMMARY FOR ([A-Z]+) (\d{1,2}) (\d{4})/);
  if (!pil || !sum) throw new Error("not an NWS CLI daily climate product");
  const mi = MONTHS.indexOf(sum[1]);
  if (mi < 0) throw new Error(`unknown month ${sum[1]}`);
  const afterTemp = text.slice(text.indexOf("TEMPERATURE (F)", sum.index));
  const row = afterTemp.match(/\n\s*(?:YESTERDAY|TODAY)\s*\n\s*MAXIMUM\s+(-?\d+)\s+(\d{1,4} [AP]M)/);
  if (!row) throw new Error("CLI product: no MAXIMUM row under TEMPERATURE");
  const issued = text.match(/\n(\d{3,4} [AP]M [A-Z]{3} [A-Z]{3} [A-Z]{3} \d{1,2} \d{4})\n/);
  const pad = (n: number | string) => String(n).padStart(2, "0");
  return { station: pil[1], forDate: `${sum[3]}-${pad(mi + 1)}-${pad(sum[2])}`, highF: Number(row[1]), highTime: row[2], issued: issued?.[1] ?? "" };
}

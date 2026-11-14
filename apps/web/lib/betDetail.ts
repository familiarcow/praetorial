// B1 (familiarcow 2026-11-11: "expand detail sections so we can see all the details of the bet? The sources, the prompts, etc."):
// everything that decides a bet, as plain data for the Details card (src/kit/details.tsx). One pure function, betDetail(bet, ctx),
// read from the bet record the contract returns (get_bet / the indexer's copy) and nothing else:
//   terms     every field of envelope.terms in plain labels + the raw JSON and terms hash
//   sources   every allowed source: publisher, URL, role / priority, what it is used for
//   judge     the AI judge's exact instructions for this bet, rebuilt from the resolver's own text (lib/judgePrompt.ts), the models,
//             the models snapshot hash, the resolver wasm hash, tier
//   ruling    every judgement round (all_results), the full parse of last_resolution_raw (each model's answer, quote, source, reason),
//             the challenges (who, bond, round)
//   exhibits  every exhibit filed: who, when, hash
//   money     stakes, fee, storage, tips exact; every deadline as local + UTC
//   accounts  the raw account ids (the ONLY place they appear), each next to its @username
// Fields the browser cannot get are listed in spikes/b1/REPORT.md "Detail gaps", never invented.
import type { Bet } from "./escrowAdapter";
import { formatMoney, money, type Money } from "./money";
import { exactTime } from "./dates";
import { auditMessages, elementMessages, PLACEHOLDER, CLAUSES, type ElementPrompt } from "./judgePrompt";
import { ROUND_WINDOW_NS } from "./escrowAdapter";
import { identityOf } from "./appState";

// ---------------------------------------------------------------- people
export interface DetailPerson { account: string; username: string | null }
/** "@kim", or "Unnamed account" for an account with no username (SM2 identityOf: never a raw id, not even shortened). */
export function personName(account: string, username: string | null | undefined): string {
  return identityOf({ account, username }).label;
}

// ---------------------------------------------------------------- times
export interface When { ms: number; local: string; utc: string; iso: string }
const NS_PER_MS = 1e6;
export function whenFromMs(ms: number, opts: { timeZone?: string } = {}): When {
  const e = exactTime(ms, opts);
  return { ms, local: e.local, utc: e.utc, iso: e.iso };
}
const whenNs = (ns: unknown, o: { timeZone?: string }): When | null => {
  const n = Number(ns);
  return ns == null || !Number.isFinite(n) || n <= 0 ? null : whenFromMs(Math.floor(n / NS_PER_MS), o);
};
const whenIso = (iso: unknown, o: { timeZone?: string }): When | null => {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? whenFromMs(ms, o) : null;
};
/** "1 day", "24 h", "90 min" for a ns duration. */
export function durationText(ns: number): string {
  const min = Math.round(ns / 60e9);
  if (min % 1440 === 0) return `${min / 1440} ${min === 1440 ? "day" : "days"}`;
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}

// ---------------------------------------------------------------- terms: the resolver's template renderer, in TS
// Mirrors resolver/core/src/template.rs materialize(): a typed sheet {template, fields} -> the claim, question, sources, rules
// and time window the judge and the code readers actually use. Custom / untyped sheets are returned as stored.
const isoOf = (secs: number): string => new Date(secs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const parseIso = (s: unknown): number | null => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s) ? Date.parse(s) / 1000 : null);
const parseDate = (s: unknown): number | null => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) / 86400_000 : null);
const opWords = (op: string): string => (op === ">" ? "above (>)" : op === ">=" ? "at least (>=)" : op === "<" ? "below (<)" : "at most (<=)");
const NWS_OFFSET: Record<string, number> = { KNYC: -5, KLAX: -8, KORD: -6, KMIA: -5, KDFW: -6, KDEN: -7, KPHX: -7, KSEA: -8, KATL: -5, KBOS: -5, KIAH: -6, KMSP: -6, KDCA: -5, KPHL: -5, KSFO: -8, KLAS: -8, KAUS: -6, KDTW: -5, KMDW: -6, KSAN: -8 };
const EVIDENCE_TAIL_SECS = 7 * 86400;
const CLAUSES_V1 = ["UTC_V1", "BEFORE_INCLUSIVE_V1", "NUMERIC_EXACT_V1", "ROUNDING_PRECISION_V1", "NO_DATA_FALLBACK_V1"];
const num = (v: unknown): string => JSON.stringify(v);
function venueSources(ws: number, we: number) {
  const n = Math.min(1000, Math.max(1, Math.trunc((we - ws) / 60)));
  return [
    { id: "S_CB", publisher: "Coinbase BTC-USD", url: `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${isoOf(ws)}&end=${isoOf(we - 1)}` },
    { id: "S_BS", publisher: "Bitstamp btcusd", url: `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=${n}&start=${ws}&end=${we - 1}` },
    { id: "S_KR", publisher: "Kraken XBT/USD", url: `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=${ws - 1}` },
  ];
}
export const TEMPLATE_NAMES: Record<string, string> = {
  btc_close_at_t: "Bitcoin price at a set time", btc_touch: "Bitcoin touches a price", game_winner: "Who wins a game",
  nws_daily_high: "Daily high temperature", custom: "Custom bet",
};
/** The materialized sheet, or null when the template can't be rendered (unknown id / bad fields: the resolver refuses those too). */
export function materialize(ts: any): any | null {
  const id = ts?.template?.id;
  if (!id || id === "custom") return ts;
  const f = ts.fields ?? {};
  const s = (k: string): string => (typeof f[k] === "string" ? f[k] : "");
  let claim: string, q: string, ws: number, we: number, sources: any[], defs: string[], pins: any = null;
  const fallback = "Fallback: if one named source is unavailable the remaining sources must confirm; if too few can be checked the outcome is VOID with full refunds after the recovery window.";
  if (id === "btc_close_at_t") {
    const t = parseIso(s("t_utc")); if (t == null) return null;
    claim = `The median of the CLOSE of the 1-minute BTC-USD candle ending ${s("t_utc")} on Coinbase, Bitstamp and Kraken is ${opWords(s("op"))} ${num(f.x_usd)} USD.`;
    q = `Is the median close of the 1-minute BTC-USD candle ending ${s("t_utc")} on Coinbase, Bitstamp and Kraken ${opWords(s("op"))} ${num(f.x_usd)} USD?`;
    ws = t - 60; we = t; sources = venueSources(ws, we);
    defs = [
      "The CLOSE of the 1-minute candle is what is checked, never the high (wick). With three venues the median close decides; with two the mean, and VOID if they straddle the level; fewer than two is VOID.",
      "Early resolution: never before the candle has closed; the settle request is T + 5 minutes.",
      "Only the BTC-USD pair on the three named venues is eligible; no aggregators or other assets.",
    ];
    pins = { "Coinbase BTC-USD": "BTC-USD", "Bitstamp btcusd": "btcusd", "Kraken XBT/USD": "XBT/USD" };
  } else if (id === "btc_touch") {
    const o = parseIso(s("open_utc")), d = parseIso(s("deadline_utc")); if (o == null || d == null) return null;
    const above = s("direction") === "at_or_above";
    const [side, cmp, ext] = above ? ["at or above", ">=", "HIGH"] : ["at or below", "<=", "LOW"];
    claim = `BTC-USD 1-minute candle ${above ? "high" : "low"} is ${side} ${num(f.x_usd)} USD on at least two of Coinbase, Bitstamp, Kraken between ${s("open_utc")} and ${s("deadline_utc")}.`;
    q = `Is a 1-minute BTC-USD candle ${above ? "high" : "low"} ${cmp} ${num(f.x_usd)} on at least two of Coinbase, Bitstamp and Kraken between ${s("open_utc")} and ${s("deadline_utc")}?`;
    ws = o; we = d; sources = venueSources(ws, we);
    defs = [
      `A 1-minute candle ${ext} (the wick), not the close, crossing the stated USD level counts as a touch; the touch requires confirmation on at least two of the three named venues.`,
      "Early YES resolution is allowed at the first qualifying confirmed candle, never before; if no touch occurred in the window the outcome is NO.",
      "Only the BTC-USD pair on the three named venues is eligible; no aggregators or other assets.",
    ];
    pins = { "Coinbase BTC-USD": "BTC-USD", "Bitstamp btcusd": "btcusd", "Kraken XBT/USD": "XBT/USD" };
  } else if (id === "game_winner") {
    const league = s("league"), date = s("scheduled_date"), d0 = parseDate(date);
    if (d0 == null) return null;
    const single = league === "NFL" || league === "NBA";
    const name = typeof f.pick?.name === "string" ? f.pick.name : "", tid = typeof f.pick?.team_id === "string" ? f.pick.team_id : "";
    claim = `${name} (team id ${tid}) win ${league} game ${s("event_id")} scheduled on ${date}, by the final score including overtime.${single ? " This is a single source bet: ESPN is the only source." : ""}`;
    q = `Did ${name} (team id ${tid}) win ${league} game ${s("event_id")} scheduled on ${date} according to the final score, overtime included?`;
    ws = d0 * 86400; we = ws + 36 * 3600;
    const c = date.replace(/-/g, "");
    const espn = (sport: string, lg: string) => ({ id: "S_ESPN", publisher: single ? "ESPN (single source)" : "ESPN", url: `https://site.api.espn.com/apis/site/v2/sports/${sport}/${lg}/scoreboard?dates=${c}` });
    sources = league === "MLB" ? [{ id: "S_LEAGUE", publisher: "MLB Stats API", url: `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}` }, espn("baseball", "mlb")]
      : league === "NHL" ? [{ id: "S_LEAGUE", publisher: "NHL api-web", url: `https://api-web.nhle.com/v1/score/${date}` }, espn("hockey", "nhl")]
      : league === "NFL" ? [espn("football", "nfl")] : [espn("basketball", "nba")];
    defs = [
      "Only a final result counts, overtime, shootout and extra innings included; a tie, postponement or cancellation is not a win for either side.",
      "Early resolution: only once the source shows the game as final; never before.",
    ];
  } else if (id === "nws_daily_high") {
    const st = s("station"), date = s("date"), d0 = parseDate(date);
    if (d0 == null || !st) return null;
    claim = `The NWS Daily Climate Report (CLI) maximum temperature for ${st} on ${date} (the local standard time climate day) is ${opWords(s("op"))} ${num(f.x_f)} degrees F.`;
    q = `Is the NWS CLI maximum temperature for ${st} on ${date} (local standard time climate day) ${opWords(s("op"))} ${num(f.x_f)} degrees F?`;
    ws = d0 * 86400 - (NWS_OFFSET[st] ?? 0) * 3600; we = ws + 86400;
    sources = [
      { id: "S_NWS", publisher: "NWS CLI (api.weather.gov)", url: `https://api.weather.gov/products/types/CLI/locations/${st.slice(1)}` },
      { id: "S_IEM", publisher: "IEM CLI (mesonet.agron.iastate.edu)", url: `https://mesonet.agron.iastate.edu/json/cli.py?station=${st}&year=${date.slice(0, 4)}` },
    ];
    defs = [
      "Early resolution: only once the CLI report for the climate day is published; never before. Both the NWS CLI and the IEM copy must give the same maximum; a missing (MM) or differing maximum is VOID.",
      "The climate day is local standard time all year (no daylight saving adjustment), not the UTC day.",
    ];
  } else return null;
  defs.unshift(fallback);
  const classes: Record<string, string> = {};
  for (const sc of sources) classes[sc.publisher] = "primary";
  const cutoff = we + EVIDENCE_TAIL_SECS;
  const m: any = {
    template: ts.template, fields: ts.fields, claim, elements: [{ id: "e1", q }], rule: "ALL", clauses: CLAUSES_V1,
    time: { window_start: isoOf(ws), window_end: isoOf(we), evidence_cutoff: isoOf(cutoff) }, sources_allowed: sources,
    source_classes: classes, custom_definitions: defs, window_close: isoOf(cutoff), sources: true,
  };
  if (pins) m.ticker_pins = pins;
  if (ts.referee !== undefined) m.referee = ts.referee;
  return m;
}

/** The question in plain words: claimText (older sheets), the custom claim, or the template's rendered claim. Null = terms not kept. */
export function questionText(terms: string | null | undefined): string | null {
  if (!terms) return null;
  let t: any;
  try { t = JSON.parse(terms); } catch { return null; }
  for (const k of ["claimText", "claim"]) if (typeof t?.[k] === "string" && t[k].trim()) return t[k].trim();
  const m = t?.template ? materialize(t) : null;
  return typeof m?.claim === "string" ? m.claim : null;
}

// ---------------------------------------------------------------- the view
export interface Field { key: string; label: string; text?: string; list?: string[]; mono?: boolean; when?: When | null; url?: string }
export interface TermsDetail {
  kept: boolean;
  /** "custom" or the template id. */
  kind: string;
  kindLabel: string;
  question: string | null;
  questions: { id: string; q: string }[];
  ruleText: string | null;
  /** Standard rules (clauses) with their full text, then the bet's own extra rules. */
  clauses: { id: string; text: string | null }[];
  extraRules: string[];
  /** Every top-level key of the stored terms, in plain labels (BetTerms renders one row each, data-field=key). */
  fields: Field[];
  rawJson: string | null;
  termsHash: string;
  /** For templates: the resolver builds the question, sources and rules from these signed fields (not stored in the terms). */
  derived: boolean;
}
export interface SourceDetail { id: string; publisher: string; url: string | null; host: string | null; priority: number; role: string; usedFor: string; extra: Field[] }
export interface JudgeDetail {
  mode: "ai" | "code-audit" | "referee" | "unknown";
  summary: string;
  /** The AI judge's messages, one per question. */
  prompts: ElementPrompt[];
  audit: { system: string; user: string } | null;
  /** What in the prompt is a placeholder (not reproducible in the browser). */
  caveats: string[];
  models: string[];
  modelsSource: "ruling" | "release" | "none";
  chain: { a: string; b: string; active: boolean }[];
  modelsSnapshotHash: string;
  resolverWasmHash: string | null;
  tier: number | null;
  maxPaidRuns: number | null;
  runsUsed: number | null;
  referee: DetailPerson | null;
}
export interface ModelRun {
  model: string; answer: string | null; quote: string | null; sourceId: string | null; sourceName: string | null; url: string | null;
  also: { sourceId: string; sourceName: string; url: string | null; quote: string }[]; reason: string | null; audit: string | null;
  verify: string | null; verifyReason: string | null; signatureVerified: boolean | null; ms: number | null; text: string | null;
}
export interface RoundDetail {
  runNo: number; outcome: string; current: boolean; at: When | null; elementResultsHash: string | null; checkedUntil: string | null;
  elements: { id: string; q: string | null; verdict: string }[]; runs: ModelRun[]; notes: string[]; backend: string | null;
  signed: boolean | null; signingKey: string | null; termsHash: string | null;
}
export interface ChallengeDetail { who: DetailPerson; bond: Money; bondExact: string; round: number; before: string | null }
export interface RulingDetail {
  rounds: RoundDetail[];
  challenges: ChallengeDetail[];
  /** The resolver returned an error instead of a ruling (e.g. "judge_api_key_missing"). */
  error: string | null;
  /** A stored ruling with no result in it that is not an error either (unknown shape, or not JSON): shown raw, never called an error. */
  unreadable: boolean;
  raw: string | null;
  finalOutcome: string | null;
}
export interface ExhibitDetail { index: number; who: DetailPerson; at: When | null; hash: string; content: null }
export interface MoneyRow { key: string; label: string; exact: string; note?: string }
export interface DeadlineRow { key: string; label: string; when: When | null; note?: string; text?: string }
export interface AccountRow { key: string; role: string; person: DetailPerson }
export interface BetDetail {
  id: number;
  terms: TermsDetail;
  sources: SourceDetail[];
  judge: JudgeDetail;
  ruling: RulingDetail;
  exhibits: ExhibitDetail[];
  rebuttals: string[];
  money: MoneyRow[];
  deadlines: DeadlineRow[];
  accounts: AccountRow[];
  summary: Record<"terms" | "sources" | "judge" | "ruling" | "exhibits" | "money" | "accounts", string>;
}
export interface BetDetailCtx {
  names?: Record<string, string | null | undefined>;
  /** This app's release pins (lib/releaseConfig.ts): the resolver wasm hash and judge models the contract was set up with. */
  release?: { resolverWasmHash: string; models: string[] } | null;
  contractId?: string;
  /** Fixed time zone for tests. */
  timeZone?: string;
}

const LABELS: Record<string, string> = {
  claimText: "Claim", claim: "Claim", elements: "Questions", rule: "How the questions combine", clauses: "Standard rules",
  custom_definitions: "Extra rules", time: "Time window", window_close: "Recovery window ends", sources: "Uses named sources",
  sources_allowed: "Sources", source_classes: "Source roles", ticker_pins: "Ticker pins", referee: "Referee", template: "Bet type",
  fields: "Bet settings", deadlineUtcIso: "Deadline", version: "Version",
};
const FIELD_LABELS: Record<string, string> = {
  t_utc: "Time (UTC)", op: "Comparison", x_usd: "Price (USD)", direction: "Direction", open_utc: "From (UTC)", deadline_utc: "Until (UTC)",
  league: "League", event_id: "Game id", pick: "Team", scheduled_date: "Game date", station: "Weather station", date: "Date", x_f: "Temperature (°F)",
};
const TIME_ORDER = ["window_start", "window_end", "evidence_cutoff"];
const TIME_LABELS: Record<string, string> = { window_start: "Window opens", window_end: "Window closes", evidence_cutoff: "Evidence cutoff" };
const words = (k: string): string => (LABELS[k] ?? FIELD_LABELS[k] ?? k.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()));
const show = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));
const ruleText = (r: unknown): string | null => (r === "ALL" ? "Every question must be met" : r === "ANY" ? "At least one question must be met" : r == null ? null : show(r));
const hostOf = (url: string | null): string | null => { try { return url ? new URL(url).host : null; } catch { return null; } };

function termsDetail(bet: Bet, o: { timeZone?: string }): { terms: TermsDetail; sheet: any } {
  const e = bet.envelope;
  const empty: TermsDetail = { kept: false, kind: "unknown", kindLabel: "Not kept on chain", question: null, questions: [], ruleText: null, clauses: [], extraRules: [], fields: [], rawJson: null, termsHash: e.terms_hash, derived: false };
  if (!e.terms) return { terms: empty, sheet: null };
  let raw: any;
  try { raw = JSON.parse(e.terms); } catch { return { terms: { ...empty, kept: true, kindLabel: "Unreadable", rawJson: e.terms }, sheet: null }; }
  const tid: string = raw?.template?.id ?? "custom";
  const sheet = materialize(raw) ?? raw;
  const fields: Field[] = [];
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k === "elements" && Array.isArray(v)) fields.push({ key: k, label: words(k), list: v.map((x: any) => `${x?.id ?? "?"}: ${x?.q ?? show(x)}`) });
    else if (k === "clauses" && Array.isArray(v)) fields.push({ key: k, label: words(k), list: v.map((c: any) => `${c}: ${CLAUSES[c] ?? "(rule text not known to this app)"}`) });
    else if (k === "custom_definitions" && Array.isArray(v)) fields.push({ key: k, label: words(k), list: v.map(show) });
    else if (k === "rule") fields.push({ key: k, label: words(k), text: `${ruleText(v)} (${show(v)})` });
    else if (k === "time" && v && typeof v === "object") fields.push({ key: k, label: words(k), list: Object.entries(v).sort(([x], [y]) => TIME_ORDER.indexOf(x) - TIME_ORDER.indexOf(y)).map(([tk, tv]) => { const w = whenIso(tv, o); return `${TIME_LABELS[tk] ?? words(tk)}: ${w ? `${w.local} · ${w.utc}` : show(tv)}`; }) });
    else if (k === "sources_allowed" && Array.isArray(v)) fields.push({ key: k, label: words(k), list: v.map((s: any) => `${s?.publisher ?? s?.id}${s?.url ? ` (${s.url})` : ""}`) });
    else if (k === "sources") fields.push({ key: k, label: words(k), text: v === true ? "Yes" : v === false ? "No" : show(v) });
    else if (k === "template") fields.push({ key: k, label: words(k), text: `${TEMPLATE_NAMES[tid] ?? tid} (${tid} v${raw?.template?.version ?? "?"})` });
    else if (k === "fields" && v && typeof v === "object") fields.push({ key: k, label: words(k), list: Object.entries(v).map(([fk, fv]) => `${FIELD_LABELS[fk] ?? words(fk)}: ${fk === "pick" && fv && typeof fv === "object" ? `${(fv as any).name} (team id ${(fv as any).team_id})` : show(fv)}`) });
    else if (k === "window_close") { const w = whenIso(v, o); fields.push({ key: k, label: words(k), text: w ? `${w.local} · ${w.utc}` : show(v), when: w }); }
    else if (v && typeof v === "object") fields.push({ key: k, label: words(k), list: Object.entries(v).map(([a, b]) => `${a}: ${show(b)}`) });
    else fields.push({ key: k, label: words(k), text: show(v) });
  }
  const clauses: { id: string; text: string | null }[] = (Array.isArray(sheet?.clauses) ? sheet.clauses : []).map((c: string) => ({ id: c, text: CLAUSES[c] ?? null }));
  return {
    sheet,
    terms: {
      kept: true, kind: tid, kindLabel: TEMPLATE_NAMES[tid] ?? tid, question: questionText(e.terms),
      questions: Array.isArray(sheet?.elements) ? sheet.elements.map((x: any) => ({ id: String(x?.id ?? ""), q: String(x?.q ?? "") })) : [],
      ruleText: ruleText(sheet?.rule), clauses, extraRules: Array.isArray(sheet?.custom_definitions) ? sheet.custom_definitions.map(show) : [],
      fields, rawJson: JSON.stringify(raw, null, 2), termsHash: e.terms_hash, derived: tid !== "custom",
    },
  };
}

function usedFor(kind: string, s: any, sheet: any): string {
  if (kind === "btc_close_at_t") return "1-minute BTC-USD candle close at the set time; the median of the venues decides.";
  if (kind === "btc_touch") return "1-minute BTC-USD candles in the window; a touch needs two of the three venues.";
  if (kind === "game_winner") return s.id === "S_LEAGUE" ? "The official league result (final score)." : "The final score.";
  if (kind === "nws_daily_high") return "The daily maximum temperature; both reports must agree.";
  const qs: string[] = Array.isArray(sheet?.elements) ? sheet.elements.map((x: any) => x?.q).filter(Boolean) : [];
  return qs.length === 1 ? `Evidence for: ${qs[0]}` : qs.length ? `Evidence for the ${qs.length} questions.` : "Evidence for the claim.";
}
const SOURCE_KEYS = new Set(["id", "publisher", "url"]);
function sourcesDetail(kind: string, sheet: any): SourceDetail[] {
  const list: any[] = Array.isArray(sheet?.sources_allowed) ? sheet.sources_allowed : [];
  const classes = sheet?.source_classes ?? {};
  const pins = sheet?.ticker_pins ?? {};
  return list.map((s, i) => {
    const publisher = typeof s?.publisher === "string" ? s.publisher : String(s?.id ?? `Source ${i + 1}`);
    const url = typeof s?.url === "string" ? s.url : null;
    const cls = classes[publisher];
    const role = [cls ? `${String(cls).replace(/^./, (c: string) => c.toUpperCase())} source` : `Source ${i + 1} of ${list.length}`, pins[publisher] ? `pair ${pins[publisher]}` : null].filter(Boolean).join(" · ");
    const extra = Object.entries(s ?? {}).filter(([k]) => !SOURCE_KEYS.has(k)).map(([k, v]) => ({ key: k, label: words(k), text: show(v) }));
    return { id: String(s?.id ?? ""), publisher, url, host: hostOf(url), priority: i + 1, role, usedFor: usedFor(kind, s, sheet), extra };
  });
}

function parseRaw(raw: string | null | undefined): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { unparsed: raw }; }
}

function modelRun(d: any, sources: SourceDetail[]): ModelRun {
  const text: string | null = typeof d?.content === "string" ? d.content : typeof d?.content_head === "string" ? d.content_head : null;
  let a: any = null;
  try { a = text ? JSON.parse(text) : null; } catch { a = null; }
  const src = (id: unknown) => sources.find((s) => s.id === id) ?? null;
  const main = src(a?.source_id);
  return {
    model: String(d?.model ?? "unknown model"),
    answer: typeof a?.answer === "string" ? a.answer : null,
    quote: typeof a?.quote === "string" && a.quote ? a.quote : null,
    sourceId: typeof a?.source_id === "string" && a.source_id ? a.source_id : null,
    sourceName: main?.publisher ?? (typeof a?.source_id === "string" && a.source_id ? a.source_id : null),
    url: main?.url ?? null,
    also: Array.isArray(a?.also) ? a.also.filter((x: any) => typeof x?.quote === "string").map((x: any) => ({ sourceId: String(x.source_id ?? ""), sourceName: src(x.source_id)?.publisher ?? String(x.source_id ?? ""), url: src(x.source_id)?.url ?? null, quote: x.quote })) : [],
    reason: typeof a?.reason === "string" ? a.reason : null,
    audit: typeof a?.audit === "string" ? a.audit : null,
    verify: typeof d?.verify_result === "string" ? d.verify_result : null,
    verifyReason: typeof d?.verify_reason === "string" ? d.verify_reason : null,
    signatureVerified: typeof d?.signature_verified === "boolean" ? d.signature_verified : null,
    ms: typeof d?.total_ms === "number" ? d.total_ms : null,
    text: a ? null : text,
  };
}

function rulingDetail(bet: Bet, sources: SourceDetail[], terms: TermsDetail, P: (a: string) => DetailPerson, o: { timeZone?: string }): RulingDetail {
  const b: any = bet;
  const root = parseRaw(bet.last_resolution_raw);
  const result = root?.result && typeof root.result === "object" ? root.result : null;
  const all: any[] = Array.isArray(b.all_results) ? b.all_results : [];
  const runs = new Map<number, RoundDetail>();
  const blank = (runNo: number, outcome: string): RoundDetail => ({ runNo, outcome, current: false, at: null, elementResultsHash: null, checkedUntil: null, elements: [], runs: [], notes: [], backend: null, signed: null, signingKey: null, termsHash: null });
  for (const r of all) {
    const n = Number(r?.run_no);
    if (!Number.isFinite(n)) continue;
    runs.set(n, { ...blank(n, String(r?.outcome ?? "?")), elementResultsHash: r?.element_results_hash ?? null, checkedUntil: r?.checked_until != null ? String(r.checked_until) : null });
  }
  if (result) {
    const n = Number(result.run_no);
    const round = runs.get(n) ?? blank(n, String(result.outcome ?? "?"));
    const j = root.judge ?? {};
    const qById = new Map(terms.questions.map((x) => [x.id, x.q]));
    Object.assign(round, {
      current: true,
      at: whenNs(bet.proposed_at, o),
      outcome: String(result.outcome ?? round.outcome),
      elementResultsHash: result.element_results_hash ?? round.elementResultsHash,
      checkedUntil: result.checked_until != null ? String(result.checked_until) : round.checkedUntil,
      elements: Array.isArray(j.elements) ? j.elements.map((x: any) => ({ id: String(x?.id ?? ""), q: qById.get(String(x?.id ?? "")) ?? null, verdict: String(x?.verdict ?? "?") })) : [],
      runs: Array.isArray(j.run_diagnostics) ? j.run_diagnostics.map((d: any) => modelRun(d, sources)) : [],
      notes: Array.isArray(root.notes) ? root.notes.map(show) : [],
      backend: typeof j.judge_backend === "string" ? j.judge_backend : null,
      signed: typeof root.signing?.signature_hex === "string",
      signingKey: typeof root.signing?.pubkey_hex === "string" ? root.signing.pubkey_hex : null,
      termsHash: typeof result.terms_hash === "string" ? result.terms_hash : null,
    });
    runs.set(n, round);
  }
  const challenges: ChallengeDetail[] = (bet.bonds ?? []).map((x) => {
    const m = money(x.amount, x.asset);
    return { who: P(x.holder), bond: m, bondExact: formatMoney(m).exact, round: x.round, before: x.pre_challenge_outcome ?? null };
  });
  const error = root && !result && typeof root.error === "string" ? root.error : null;
  const unreadable = !!root && !result && error === null;
  return {
    rounds: [...runs.values()].sort((a, c) => a.runNo - c.runNo), challenges, error, unreadable,
    raw: bet.last_resolution_raw ? (root?.unparsed ? bet.last_resolution_raw : JSON.stringify(root, null, 2)) : null,
    finalOutcome: bet.outcome ?? null,
  };
}

/** "deepseek-ai/DeepSeek-V4.1-Flash-1017" -> "DeepSeek V4.1 Flash". */
export function modelName(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail.replace(/-\d{4}$/, "").replace(/(\d)-(\d)/g, "$1.$2").replace(/[-_]+/g, " ").replace(/\b(glm|gpt)\b/gi, (m) => m.toUpperCase()).replace(/(^|\s)([a-z])/g, (_, sp, c) => sp + c.toUpperCase());
}

function judgeDetail(bet: Bet, t: TermsDetail, sheet: any, sources: SourceDetail[], P: (a: string) => DetailPerson, ctx: BetDetailCtx): JudgeDetail {
  const e = bet.envelope;
  const root = parseRaw(bet.last_resolution_raw);
  const j = root?.judge ?? null;
  const chainRaw: any[] = Array.isArray(j?.judge_chain) ? j.judge_chain : [];
  const idx = typeof j?.judge_pair_index === "number" ? j.judge_pair_index : typeof (bet as any).judge_pair_index === "number" ? (bet as any).judge_pair_index : 0;
  const chain = chainRaw.map((p, i) => ({ a: String(p?.model_a ?? ""), b: String(p?.model_b ?? ""), active: i === idx }));
  const fromRuling: string[] = Array.isArray(j?.models_requested) && j.models_requested.length ? j.models_requested.map(String) : chain[idx] ? [chain[idx].a, chain[idx].b] : [];
  const models = fromRuling.length ? fromRuling : ctx.release?.models ?? [];
  const base = {
    models, modelsSource: (fromRuling.length ? "ruling" : ctx.release?.models?.length ? "release" : "none") as JudgeDetail["modelsSource"], chain,
    modelsSnapshotHash: e.models_snapshot_hash, resolverWasmHash: ctx.release?.resolverWasmHash ?? null,
    tier: typeof e.tier === "number" ? e.tier : null, maxPaidRuns: typeof (e as any).max_paid_runs === "number" ? (e as any).max_paid_runs : null,
    runsUsed: typeof (bet as any).runs_used === "number" ? (bet as any).runs_used : null,
  };
  if (e.referee) {
    const who = P(e.referee.account);
    return { ...base, mode: "referee", summary: `${personName(who.account, who.username)} decides (no AI)`, prompts: [], audit: null, caveats: [], referee: who };
  }
  if (!t.kept || !sheet) {
    return { ...base, mode: "unknown", summary: "Terms not kept on chain: the prompt can't be rebuilt", prompts: [], audit: null, caveats: ["This bet's terms are not stored on chain, so its prompt can't be shown."], referee: null };
  }
  const ps = sources.map((s) => ({ id: s.id, publisher: s.publisher, url: s.url }));
  const modelsLine = models.length ? models.map(modelName).join(" + ") : "Models not known yet";
  if (t.derived) {
    const proposed = bet.outcome === "YES" || bet.outcome === "NO" ? bet.outcome : null;
    return {
      ...base, mode: "code-audit", summary: `Code reads the sources · ${models[0] ? modelName(models[0]) : "the AI"} audits`,
      prompts: [], audit: auditMessages(sheet.claim ?? "", sheet.elements?.[0]?.q ?? "", proposed),
      caveats: [
        "For this bet type the resolver's code reads the sources and computes YES or NO. The AI only audits that result: it may agree, or flag it (which makes the bet VOID). It can never pick the other side.",
        "The values the code read from the sources are filled in at resolution time and are not stored on chain.",
      ],
      referee: null,
    };
  }
  return {
    ...base, mode: "ai", summary: `${modelsLine}${base.tier != null ? ` · tier ${base.tier}` : ""}`,
    prompts: t.questions.map((q) => elementMessages(sheet, q, ps)), audit: null,
    caveats: [
      "This is the exact text the resolver sends, built from this bet's signed terms. The parts in [brackets] are filled in when the result is requested and are not stored on chain: each source's page text, its publish date and sha256, and the resolution time.",
      "Each question is asked separately, to two models; a decisive answer needs quotes that verify from two different web domains.",
    ],
    referee: null,
  };
}

/** Everything that decides a bet, in plain data. */
export function betDetail(bet: Bet, ctx: BetDetailCtx = {}): BetDetail {
  const o = { timeZone: ctx.timeZone };
  const e = bet.envelope;
  const b: any = bet;
  const names = ctx.names ?? {};
  const P = (a: string): DetailPerson => ({ account: a, username: names[a] ?? null });
  const { terms, sheet } = termsDetail(bet, o);
  const sources = sourcesDetail(terms.kind, sheet);
  const judge = judgeDetail(bet, terms, sheet, sources, P, ctx);
  const ruling = rulingDetail(bet, sources, terms, P, o);
  const exhibits: ExhibitDetail[] = (bet.exhibits ?? []).map((x, i) => ({ index: i + 1, who: P(x.submitted_by), at: whenNs(x.submitted_at, o), hash: x.hash, content: null }));
  const rebuttals: string[] = Array.isArray(b.rebuttals) ? b.rebuttals.map(show) : [];

  // ---- money (exact)
  const ex = (units: unknown, asset: string) => formatMoney(money(String(units ?? "0"), asset)).exact;
  const takerSide = e.outcomes.find((x) => x !== e.maker_side) ?? "";
  const moneyRows: MoneyRow[] = [
    { key: "stake_maker", label: `Maker stake (${e.maker_side})`, exact: ex(e.stake_maker, e.maker_asset) },
    { key: "stake_taker", label: `Taker stake (${takerSide})`, exact: ex(e.stake_taker, e.taker_asset) },
    { key: "fee", label: "Fee", exact: `${e.fee_bps / 100}% of each stake`, note: "Charged only when someone wins. No fee on a refund." },
  ];
  if (b.fee_min_maker != null) moneyRows.push({ key: "fee_min_maker", label: "Minimum fee, maker side", exact: ex(b.fee_min_maker, e.maker_asset) });
  if (b.fee_min_taker != null) moneyRows.push({ key: "fee_min_taker", label: "Minimum fee, taker side", exact: ex(b.fee_min_taker, e.taker_asset) });
  if (b.storage_maker != null) moneyRows.push({ key: "storage_maker", label: "Network storage, maker", exact: ex(b.storage_maker, e.maker_asset), note: "Paid once when the bet opened." });
  if (b.storage_taker != null) moneyRows.push({ key: "storage_taker", label: "Network storage, taker", exact: ex(b.storage_taker, e.taker_asset), note: "Paid once when the bet was taken." });
  if (b.tip_maker && b.tip_maker !== "0") moneyRows.push({ key: "tip_maker", label: "Referee tip, maker side", exact: ex(b.tip_maker, e.maker_asset) });
  if (b.tip_taker && b.tip_taker !== "0") moneyRows.push({ key: "tip_taker", label: "Referee tip, taker side", exact: ex(b.tip_taker, e.taker_asset) });
  for (const x of bet.bonds ?? []) moneyRows.push({ key: `bond_${x.round}`, label: `Challenge bond, round ${x.round}`, exact: ex(x.amount, x.asset) });

  // ---- deadlines (local + UTC)
  const windowNs = Math.min(Number(e.settlement_period), ROUND_WINDOW_NS);
  const dl: DeadlineRow[] = [
    { key: "created_at", label: "Made", when: whenNs(bet.created_at, o) },
    { key: "funding_deadline", label: bet.taker ? "Event time (offer closed)" : "Offer closes", when: whenNs(e.funding_deadline, o) },
  ];
  if (bet.taken_at) dl.push({ key: "taken_at", label: "Taken", when: whenNs(bet.taken_at, o) });
  if (bet.proposed_at) {
    dl.push({ key: "proposed_at", label: "Ruling made", when: whenNs(bet.proposed_at, o) });
    // LFIX1 (SM1 LIFE-7): a referee's ruling is final at once (referee_rule -> Finalized); it never had a challenge window.
    if (!e.referee) dl.push({ key: "challenge_window_end", label: "Challenge window ends", when: whenNs(Number(bet.proposed_at) + windowNs + Number(bet.window_extension_ns ?? 0), o), note: bet.window_extension_ns ? "Extended." : undefined });
  }
  dl.push({ key: "resolve_deadline", label: "Last day to decide", when: whenNs(e.resolve_deadline, o), note: "If nobody decides by then, both stakes are returned." });
  dl.push({ key: "settlement_period", label: "Challenge window length", when: null, text: durationText(windowNs) });
  if (terms.kept && sheet?.time) {
    for (const k of ["window_start", "window_end", "evidence_cutoff"]) if (sheet.time[k]) dl.push({ key: `terms_${k}`, label: `${TIME_LABELS[k]} (terms)`, when: whenIso(sheet.time[k], o) });
  }

  // ---- accounts (the only place raw ids appear)
  const accounts: AccountRow[] = [{ key: "maker", role: "Maker", person: P(e.maker) }];
  if (bet.taker) accounts.push({ key: "taker", role: "Taker", person: P(bet.taker) });
  if (e.referee) accounts.push({ key: "referee", role: "Referee", person: P(e.referee.account) });
  for (const x of bet.bonds ?? []) if (!accounts.some((a) => a.person.account === x.holder)) accounts.push({ key: `bond-${x.round}`, role: `Challenger (round ${x.round})`, person: P(x.holder) });
  for (const x of bet.exhibits ?? []) if (!accounts.some((a) => a.person.account === x.submitted_by)) accounts.push({ key: `exhibit-${x.submitted_by}`, role: "Filed evidence", person: P(x.submitted_by) });

  // ---- one-line summaries
  const nq = terms.questions.length;
  const lastRound = ruling.rounds.at(-1);
  const summary = {
    terms: !terms.kept ? "Not kept on chain" : `${terms.kindLabel} · ${nq} ${nq === 1 ? "question" : "questions"}${terms.clauses.length + terms.extraRules.length ? ` · ${terms.clauses.length + terms.extraRules.length} rules` : ""}`,
    sources: sources.length ? `${sources.length} ${sources.length === 1 ? "source" : "sources"} · ${sources.map((s) => s.publisher).join(", ")}` : "No sources listed",
    judge: judge.summary,
    ruling: ruling.error ? "The resolver returned an error" : ruling.unreadable && !lastRound ? "Stored ruling can't be read · raw text inside" : lastRound ? `${ruling.rounds.length === 1 ? "1 check" : `${ruling.rounds.length} checks`} · latest ${lastRound.outcome}${ruling.challenges.length ? ` · ${ruling.challenges.length} challenge${ruling.challenges.length === 1 ? "" : "s"}` : ""}` : bet.outcome ? `Ruled ${bet.outcome}` : "No ruling yet",
    exhibits: exhibits.length ? `${exhibits.length} filed` : "None filed",
    money: `${formatMoney(money(e.stake_maker, e.maker_asset)).text} vs ${formatMoney(money(e.stake_taker, e.taker_asset)).text} · fee ${e.fee_bps / 100}%`,
    accounts: accounts.map((a) => a.role.toLowerCase().replace(/ \(.*/, "")).filter((v, i, arr) => arr.indexOf(v) === i).join(", "),
  };
  return { id: e.bet_id, terms, sources, judge, ruling, exhibits, rebuttals, money: moneyRows, deadlines: dl, accounts, summary };
}

export { PLACEHOLDER };

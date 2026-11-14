// WT1b (d): port of the resolver's custom-sheet lint (resolver/core/src/lib.rs `lint` custom branch +
// template.rs relative_date_problems / price_reading_problems). Same named errors, same order; pinned by
// tests/customLint.unit.test.ts against the resolver fixtures (lint.json, template_cases.json).
// Not ported verbatim-by-line: Rust `is_other_*` => \p{Cf}/\p{Cc}/\p{Co}; NFKC via String.normalize.
import { addHints } from "./lintHints";
type J = any;

const isObj = (v: J) => v !== null && typeof v === "object" && !Array.isArray(v);
function truthy(v: J): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v).length > 0;
}

const WS = /\s+/g;
export const CLAUSE_IDS = new Set([
  "AVAILABLE_V1", "ANNOUNCED_V1", "OFFICIAL_SOURCE_V1", "SAYS_DIRECT_V1", "UTC_V1", "BEFORE_INCLUSIVE_V1", "PARTIAL_NONE_V1",
  "CANCELLED_V1", "FIRST_REPORT_V1", "CORRECTED_V1", "FINAL_SCORE_V1", "RENAME_V1", "MULTIPLE_EVENTS_V1", "RETRACTION_V1",
  "NUMERIC_EXACT_V1", "SOURCE_SUBSTITUTION_V1", "REVISION_WINDOW_V1", "CONTESTED_PRIMARY_V1", "POSTPONED_V1", "TIE_V1",
  "ABANDONED_EVENT_V1", "MEDIA_CONSENSUS_CALL_V1", "ROUNDING_PRECISION_V1", "NO_DATA_FALLBACK_V1", "FORMAT_CHANGE_V1",
]);
const IMPERATIVE = new RegExp(
  "\\b(ignore (all|previous|any)|disregard (all|previous|any)|override (the|this)|system prompt|" +
  "you must (answer|output|respond|treat)|answer (yes|no|met) (regardless|no matter)|" +
  "output only|respond with only|treat any|" +
  "(resolver|judge)\\s*:|" +
  "(note to|dear|attention|to the)\\s+(the\\s+)?(ai|model|assistant|judge|resolver)\\b|" +
  "(ai|model|assistant|judge|resolver)\\s+(judge|assistant)\\b)", "i");
const VAGUE = /\b(the price of \w+|a major (exchange|source|venue)|an exchange\b|some exchange|a (reliable|reputable|leading) (exchange|source|venue))\b/i;
const INJECT = /\b(?:(?:ignore|disregard|forget|override)\s+(?:all|any|every|the|your|previous|prior|earlier|above)\b[^.]{0,40}?\b(?:instructions?|rules?|prompts?|terms?|definitions?|evidence|sources?|above|previous|prior)\b|system\s+(?:prompt|note|message|override|instruction|notice)|(?:note|message|instructions?|notice|attention|dear)s?\s+(?:to|for)\s+(?:the\s+)?(?:ai|llm|model|assistant|judge|resolver|fact[- ]?checker)\b|you\s+(?:must|should|shall|are\s+required\s+to|will)\s+(?:now\s+)?(?:answer|output|respond|reply|treat|return|mark|rule|conclude|decide)\b|(?:answer|respond|reply|output|return)\s+(?:with\s+|only\s+)*["']?(?:met|not_met)\b|(?:this|it)\s+(?:\w+\s+)?is\s+(?:the\s+|an?\s+)?(?:official|binding|authoritative|final)\s+(?:correction|ruling|determination|verdict|decision|amendment|resolution)\b|(?:supersedes|overrides|overrules|voids)\s+(?:all|any|every|the)\s+(?:earlier|previous|prior|other)\b|(?:resolver|judge|referee|arbiter|oracle)\s+(?:has|have)\s+(?:already\s+)?(?:determined|ruled|decided|concluded|confirmed|found)\b[^.]{0,60}?\b(?:element|question|claim|bet)\b)/i;
const ROLE_TURN = /(?:^|\n)\s*(?:system|assistant|user|human|developer)\s*:|<\|im_(?:start|end)\|>|\[\/?(?:INST|SYSTEM)\]/im;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function norm(s: string): string {
  return s.normalize("NFKC").replace(/\u2019|\u2018/g, "'").replace(/\u201c|\u201d/g, '"').replace(/\p{Cf}/gu, "").trim().replace(WS, " ").toLowerCase();
}
function sanitize(t: string): string {
  return t.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[^\n\t]/gu, (c) => (/[\p{Cf}\p{Cc}\p{Co}]/u.test(c) ? "" : c));
}
const CONF: Record<string, string> = { а: "a", α: "a", е: "e", о: "o", ο: "o", р: "p", ρ: "p", с: "c", х: "x", і: "i", ι: "i", у: "y", ѕ: "s", ј: "j", ν: "v" };
function lintNorm(s: string): string {
  return Array.from(sanitize(norm(s))).map((c) => CONF[c] ?? c).join("");
}

function sourceNameProblems(ts: J): string[] {
  const names: string[] = [];
  if (Array.isArray(ts.sources_allowed)) for (const s of ts.sources_allowed) if (isObj(s)) names.push(typeof s.publisher === "string" ? s.publisher : "");
  if (isObj(ts.source_classes)) names.push(...Object.keys(ts.source_classes));
  return names
    .filter((n) => Array.from(n).length > 80 || /["<>\n\r]/.test(n) || sanitize(n) !== n || IMPERATIVE.test(lintNorm(n)) || INJECT.test(lintNorm(n)) || ROLE_TURN.test(n))
    .map((n) => `source name ${pyRepr(Array.from(n).slice(0, 40).join(""))} is not allowed (long, markup/quote/control chars, or reads as an instruction)`);
}
function pyRepr(t: string): string {
  const q = t.includes("'") && !t.includes('"') ? '"' : "'";
  let b = t.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
  if (q === "'") b = b.replace(/'/g, "\\'");
  return q + b + q;
}

// ---- origins (item 17d2a)
function registrableDomain(url: string): string | null {
  const rest = url.split("://")[1];
  if (rest === undefined) return null;
  let auth = rest.split(/[/?#]/)[0];
  auth = auth.split("@").pop()!;
  let host = auth.startsWith("[") ? auth.split("]")[0].replace(/^\[+/, "") : auth.split(":")[0];
  host = host.replace(/\.+$/, "").toLowerCase();
  if (!host) return null;
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return host;
  const l = host.split(".");
  if (l.length <= 2) return host;
  const SLD = ["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go", "gob", "nom", "ltd", "plc"];
  const n = l.length;
  const take = l[n - 1].length === 2 && SLD.includes(l[n - 2]) ? 3 : 2;
  return l.slice(n - Math.min(take, n)).join(".");
}
function sourceOrigin(s: J): string {
  if (typeof s.origin === "string" && s.origin) return s.origin.trim().toLowerCase();
  const pub = typeof s.publisher === "string" ? s.publisher : "";
  return pub.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
}
function originGroups(sources: J[]): number[] {
  const ids = new Map<string, number>();
  const parent: number[] = [];
  const find = (x: number) => { let r = x; while (parent[r] !== r) r = parent[r]; let c = x; while (parent[c] !== r) { const n = parent[c]; parent[c] = r; c = n; } return r; };
  const node = (k: string) => { if (!ids.has(k)) { parent.push(parent.length); ids.set(k, parent.length - 1); } return ids.get(k)!; };
  const first: number[] = [];
  for (const s of sources) {
    const url = (typeof s.final_url === "string" && s.final_url) ? s.final_url : (typeof s.url === "string" ? s.url : undefined);
    const label = `o:${sourceOrigin(s)}`;
    const d = url !== undefined ? registrableDomain(url) : null;
    if (d !== null) {
      const m = node(`d:${d}`); const l = node(label);
      const a = find(m), b = find(l); parent[a] = b; first.push(m);
    } else first.push(node(label));
  }
  const roots: number[] = [];
  return first.map((n) => { const r = find(n); let i = roots.indexOf(r); if (i < 0) { roots.push(r); i = roots.length - 1; } return i; });
}

// ---- relative date (D-TPL1a)
const REL_DATE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|yesterday|tonight|next game|(next|this|last)\s+(week|weekend|month|season|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
const MON = "(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)";
export const ANCHOR = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\b${MON}\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?${MON}\\b`, "i");
function claimSegs(ts: J): string[] {
  const segs = [typeof ts.claim === "string" ? ts.claim : ""];
  if (Array.isArray(ts.elements)) segs.push(...ts.elements.map((e: J) => (typeof e?.q === "string" ? e.q : "")));
  return segs;
}
export function relativeDateProblems(ts: J): string[] {
  for (const t of claimSegs(ts)) {
    const m = REL_DATE.exec(t);
    if (m && !ANCHOR.test(t)) return [`CUSTOM_RELATIVE_DATE: the claim uses the relative date ${pyRepr(m[0])} with no explicit calendar date (e.g. 2026-11-06); state the date`];
  }
  return [];
}

// ---- price reading (D-L1MESSY2)
const PRICE_LEVEL = /\b(break|breaks|hit|hits|cross|crosses|reach|reaches|flip|flips|above|below|over|under|top|tops)\b/i;
const PRICE_READING = /\b(touch|touches|touched|high|highs|low|lows|wick|intraday|close|closes|closed|closing|settle|settles|settled|settlement)\b/i;
const PRICE_HOSTS = ["coinbase.com", "bitstamp.net", "kraken.com", "binance.com", "binance.us", "bitfinex.com", "gemini.com", "okx.com", "bybit.com", "coingecko.com", "coinmarketcap.com", "cryptocompare.com"];
function isPriceSheet(ts: J): boolean {
  if (isObj(ts.ticker_pins) && Object.keys(ts.ticker_pins).length) return true;
  return Array.isArray(ts.sources_allowed) && ts.sources_allowed.some((x: J) => {
    const u = String(x?.url ?? "").toLowerCase();
    const host = (u.split("//")[1] ?? "").split("/")[0];
    return PRICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  });
}
export function priceReadingProblems(ts: J): string[] {
  if (!isPriceSheet(ts)) return [];
  const verb = claimSegs(ts).map((t) => PRICE_LEVEL.exec(t)).find((m) => m);
  if (!verb) return [];
  const defs: string[] = Array.isArray(ts.custom_definitions) ? ts.custom_definitions.filter((x: J) => typeof x === "string") : [];
  if (typeof ts.terms === "string") defs.push(ts.terms);
  if (defs.some((d) => PRICE_READING.test(d))) return [];
  return [`PRICE_READING_UNDEFINED: the claim is a price-level claim (${pyRepr(verb[0])}) but the sheet does not say whether a touch or a close counts; add ONE custom_definition: (a) "touch: any 1-minute candle high/low at or beyond the level on <venues>" or (b) "close: a 1-minute candle close at or beyond the level"`];
}

function lintBettype(ts: J): string[] {
  const p: string[] = [];
  const bt = truthy(ts.bettype) ? ts.bettype : {};
  const kind = typeof bt.type === "string" ? bt.type : "";
  const pubs = (Array.isArray(ts.sources_allowed) ? ts.sources_allowed.map((s: J) => `${typeof s?.publisher === "string" ? s.publisher : ""} ${typeof s?.url === "string" ? s.url : ""}`).join(" ") : "").toLowerCase();
  const str = (v: J) => (v === undefined || v === null ? (v === null ? "null" : "") : typeof v === "string" ? v : JSON.stringify(v));
  if (kind.startsWith("polymarket") || pubs.includes("polymarket")) {
    const mp = truthy(ts.market_pin) ? ts.market_pin : {};
    if (!(/^0x[0-9a-fA-F]{64}$/.test(str(mp.condition_id)) && /^[0-9a-f]{64}$/.test(str(mp.description_sha256))))
      p.push("market_pin required for a polymarket-source term sheet: condition_id (0x + 64 hex) and description_sha256 (64 hex)");
  }
  if (kind === "github_release" || pubs.includes("github")) {
    const rp = truthy(ts.repo_pin) ? ts.repo_pin : {};
    if (!(Number.isInteger(rp.repo_id) && rp.repo_id > 0))
      p.push("repo_pin required for a repo-based term sheet: numeric repo_id (a name can be renamed/transferred to a hijacker)");
  }
  const paginated = truthy(bt.paginated);
  if ((kind === "social_post" && bt.platform !== "x") || paginated) {
    const covered = Array.isArray(ts.custom_definitions) && ts.custom_definitions.filter((d: J) => typeof d === "string").some((d: string) => d.toLowerCase().includes("coverage") && /cursor|oldest|window.start|reach/i.test(d));
    if (!covered && !truthy(ts.coverage))
      p.push("coverage rule required for an absence bet over a paginated source: say what proves the whole window was covered (feed reaches back past window_start), otherwise the bet is COULDNT_CHECK, never NO");
  }
  if (ts.unresolved_at_cutoff !== undefined && ts.unresolved_at_cutoff !== null && ts.unresolved_at_cutoff !== "VOID")
    p.push("unresolved_at_cutoff must be 'VOID' if set");
  return p;
}

/** The resolver `lint()` for a CUSTOM (untyped) sheet (every problem carries its LNT1 what-to-change hint). */
export function lintCustom(ts: J): string[] {
  return addHints(lintCustomUnhinted(ts));
}
function lintCustomUnhinted(ts: J): string[] {
  const p: string[] = [];
  p.push(...relativeDateProblems(ts));
  if (truthy(ts.models)) p.push("models: judge models are pinned by the resolver (D-JUDGE6)");
  for (const f of ["claim", "elements", "rule", "sources", "time", "clauses"]) if (!truthy(ts[f])) p.push(`missing field: ${f}`);
  if (Array.isArray(ts.elements)) ts.elements.forEach((e: J, i: number) => {
    const q = typeof e?.q === "string" ? e.q : "";
    if (IMPERATIVE.test(q) || IMPERATIVE.test(lintNorm(q))) p.push(`element ${i} addresses the judge / contains an instruction`);
    if (Array.from(q).length > 300) p.push(`element ${i} too long (narrow questions only)`);
  });
  if (Array.isArray(ts.custom_definitions)) for (const c0 of ts.custom_definitions) {
    const c = typeof c0 === "string" ? c0 : "";
    if (IMPERATIVE.test(c) || IMPERATIVE.test(lintNorm(c))) p.push(`custom definition contains an instruction: ${Array.from(c).slice(0, 60).join("")}`);
  }
  if (Array.isArray(ts.clauses)) for (const c0 of ts.clauses) { const c = typeof c0 === "string" ? c0 : ""; if (!CLAUSE_IDS.has(c)) p.push(`unknown clause ${c}`); }
  p.push(...sourceNameProblems(ts));
  const t = isObj(ts.time) ? ts.time : {};
  for (const k of ["window_start", "window_end", "evidence_cutoff"]) if (!TIME_RE.test(typeof t[k] === "string" ? t[k] : "")) p.push(`time.${k} must be UTC ISO8601`);
  let origs = 0;
  if (Array.isArray(ts.sources_allowed)) {
    const g = originGroups(ts.sources_allowed);
    origs = new Set(ts.sources_allowed.map((s: J, i: number) => (truthy(s?.party_controlled) ? -1 : g[i])).filter((x: number) => x >= 0)).size;
  }
  if (origs < 2) p.push("need >= 2 independent, non-party-controlled origins (publisher strings that share an origin count once)");
  if (ts.rule !== "ALL" && ts.rule !== "ANY") p.push("rule must be ALL or ANY");
  if (Array.isArray(ts.sources_allowed)) for (const s of ts.sources_allowed) {
    const pub = typeof s?.publisher === "string" ? s.publisher : "";
    if (VAGUE.test(pub)) p.push(`source ${pyRepr(pub)} is a vague/undefined venue, not a specific named exchange+pair`);
  }
  if (Array.isArray(ts.elements)) ts.elements.forEach((e: J, i: number) => { if (VAGUE.test(typeof e?.q === "string" ? e.q : "")) p.push(`element ${i} names a vague/undefined venue or pair instead of a specific checkable one`); });
  const defs = (Array.isArray(ts.custom_definitions) ? ts.custom_definitions.filter((c: J) => typeof c === "string").join(" ") : "").toLowerCase();
  const claim = (typeof ts.claim === "string" ? ts.claim : "").toLowerCase();
  if (!defs.includes("fallback") && !truthy(ts.fallback_any_n_of)) p.push("no fallback-source rule specified for when a named source is unavailable");
  if (!defs.includes("early") && ts.early_resolution === undefined) p.push("no early-settlement rule specified (does YES fire before the deadline, or only at it?)");
  if (/\$\s?[\d.,]|\$[a-z]|price|candle|hit(s)? or exceed/i.test(claim) && !/\bhigh\b.*\bclose\b|\bclose\b.*\bhigh\b|\bwick\b/i.test(defs))
    p.push("no wick-vs-close rule: claim references a price level but nothing says whether the candle HIGH (wick) or the CLOSE is what's checked");
  const PL = /\$\s?[\d.,]|\$[a-z]|price|candle/i;
  const priceLike = PL.test(claim) || (Array.isArray(ts.elements) && ts.elements.some((e: J) => PL.test(typeof e?.q === "string" ? e.q : "")));
  if (priceLike) {
    const pins = isObj(ts.ticker_pins) ? ts.ticker_pins : {};
    const unpinned = (Array.isArray(ts.sources_allowed) ? ts.sources_allowed.map((s: J) => s?.publisher).filter((x: J) => typeof x === "string") : []).filter((x: string) => !(x in pins));
    if (!Object.keys(pins).length || unpinned.length) {
      const shown = unpinned.length ? `[${unpinned.map(pyRepr).join(", ")}]` : "any source";
      p.push(`fork/ticker not pinned per venue (D-RESOLVE1): no ticker_pins entry for ${shown} -- every named source must pin its canonical ticker before a price/candle term sheet can be written`);
    }
  }
  p.push(...lintBettype(ts));
  return p;
}

/** Custom-sheet problems at open: lint + the D-L1MESSY2 price-reading check (open_problems_all).
 * SRCREF1c / D-PM3 option C: the frozen contract needs a source-check attestation for EVERY bet and it does not commit to
 * referee mode, so a person-decided bet needs the same >=2 readable sources. `opts` is kept for callers; it changes nothing. */
export function customOpenProblems(ts: J, _opts: { humanReferee?: boolean } = {}): string[] {
  return [...lintCustom(ts), ...priceReadingProblems(ts)];
}

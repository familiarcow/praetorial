// WT1d (1): guided builder for the `custom` launch type (D-LAUNCH1). A person fills claim / narrow questions /
// >=2 independent sources / time window / the two rules the resolver demands; this emits the resolver-format custom
// sheet. Nothing here validates: lib/customLint (resolver port) is the judge, so a bad entry surfaces as the
// resolver's own named error. `customFormFromSheet` is the exact inverse (round-trips fixture sheets exactly).
import { CLAUSE_IDS } from "./customLint";
import { fromUtcMinute, toUtcMinute } from "./guidedFields";
import { parseIso } from "./templates";

export const CLAUSE_OPTIONS: string[] = Array.from(CLAUSE_IDS);
export const DEFAULT_CLAUSES = ["UTC_V1", "PARTIAL_NONE_V1"];

/** id / tier / ticker are optional general fields: a stable source id, its evidence tier (primary tried first, data as fallback) and the canonical ticker the judge must read on that venue. */
export type SourceTier = "" | "primary" | "data" | "wire" | "outlet";
export const SOURCE_TIERS: SourceTier[] = ["primary", "data", "wire", "outlet"]; // judge-proto/evidence.py CLASS_RANK
export interface CustomSource { publisher: string; url: string; partyControlled: boolean; id?: string; tier?: SourceTier; ticker?: string }
export interface CustomNote { name: string; text: string }
export interface CustomForm {
  claim: string;
  elements: string[];
  rule: "ALL" | "ANY";
  sources: CustomSource[];
  windowStart: string;
  /** CFIX1: true while windowStart is the app's own "now" stamp (never typed by hand): it is re-stamped to now whenever the deadline
   *  is picked and again before the source check. UI state only, never written to the sheet. A copied/preset value has no flag: kept. */
  windowStartAuto?: boolean;
  windowEnd: string;
  evidenceCutoff: string;
  /** Optional: when the evidence window closes (UTC minute); emitted as top-level window_close. */
  windowClose?: string;
  clauses: string[];
  fallbackRule: string;
  earlyRule: string;
  /** Rules about what counts, written ahead of the fallback rule (order is kept). */
  leadingDefinitions?: string[];
  otherDefinitions: string[];
  /** Notes for readers; not read by the judge. Emitted as `_<name>` keys. */
  notes?: CustomNote[];
}

export function blankCustomForm(): CustomForm {
  return {
    claim: "", elements: [""], rule: "ALL",
    sources: [{ publisher: "", url: "", partyControlled: false }, { publisher: "", url: "", partyControlled: false }],
    windowStart: "", windowEnd: "", evidenceCutoff: "",
    clauses: [...DEFAULT_CLAUSES],
    fallbackRule: "Fallback: if a named source is unavailable, any other listed source may confirm.",
    earlyRule: "Early YES resolution is allowed once the event has happened.",
    otherDefinitions: [],
  };
}

export function sheetFromCustomForm(f: CustomForm): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) s[k] = v; };
  put("claim", f.claim);
  put("clauses", f.clauses);
  put("custom_definitions", [...(f.leadingDefinitions ?? []), f.fallbackRule, f.earlyRule, ...f.otherDefinitions].filter((d) => d.trim() !== ""));
  put("elements", f.elements.filter((q) => q.trim() !== "").map((q, i) => ({ id: `e${i + 1}`, q })));
  put("rule", f.rule);
  s.sources = true;
  let n = 0, m = 0;
  const live = f.sources.filter((x) => x.publisher.trim() !== "" || x.url.trim() !== "");
  put("sources_allowed", live.map((x) => {
    const auto = x.partyControlled ? (m++ === 0 ? "M" : `M${m}`) : `S${++n}`;
    const o: Record<string, unknown> = { id: x.id?.trim() ? x.id.trim() : auto, publisher: x.publisher };
    if (x.url.trim()) o.url = x.url.trim();
    if (x.partyControlled) o.party_controlled = true;
    return o;
  }));
  const classes: Record<string, string> = {}, pins: Record<string, string> = {};
  for (const x of live) { if (x.tier) classes[x.publisher] = x.tier; if (x.ticker?.trim()) pins[x.publisher] = x.ticker.trim(); }
  put("source_classes", Object.keys(classes).length ? classes : undefined);
  put("ticker_pins", Object.keys(pins).length ? pins : undefined);
  if (f.windowClose) s.window_close = toUtcMinute(f.windowClose);
  for (const nt of f.notes ?? []) if (nt.name.trim() && nt.text.trim()) s[`_${nt.name.trim()}`] = nt.text;
  const time: Record<string, string> = {};
  if (f.evidenceCutoff) time.evidence_cutoff = toUtcMinute(f.evidenceCutoff);
  if (f.windowEnd) time.window_end = toUtcMinute(f.windowEnd);
  if (f.windowStart) time.window_start = toUtcMinute(f.windowStart);
  if (Object.keys(time).length) s.time = time;
  return s;
}

export function customFormFromSheet(sheet: Record<string, any>): CustomForm {
  const defs: string[] = Array.isArray(sheet.custom_definitions) ? sheet.custom_definitions.filter((d: unknown) => typeof d === "string") : [];
  let fallbackRule = "", earlyRule = "";
  const leading: string[] = [], other: string[] = [];
  const fi = defs.findIndex((d) => d.toLowerCase().includes("fallback"));
  defs.forEach((d, i) => {
    const l = d.toLowerCase();
    if (i === fi) fallbackRule = d;
    else if (i > fi && !earlyRule && l.includes("early")) earlyRule = d;
    else if (i < fi) leading.push(d);
    else other.push(d);
  });
  if (fi < 0) { const ei = defs.findIndex((d) => d.toLowerCase().includes("early")); if (ei >= 0) { earlyRule = defs[ei]; other.length = 0; leading.length = 0; defs.forEach((d, i) => { if (i !== ei) other.push(d); }); } }
  const classes = sheet.source_classes && typeof sheet.source_classes === "object" ? sheet.source_classes : {};
  const pins = sheet.ticker_pins && typeof sheet.ticker_pins === "object" ? sheet.ticker_pins : {};
  const notes = Object.keys(sheet).filter((k) => k.startsWith("_")).map((k) => ({ name: k.slice(1), text: String(sheet[k]) }));
  const t = sheet.time ?? {};
  return {
    claim: typeof sheet.claim === "string" ? sheet.claim : "",
    elements: Array.isArray(sheet.elements) ? sheet.elements.map((e: any) => String(e?.q ?? "")) : [],
    rule: sheet.rule,
    sources: Array.isArray(sheet.sources_allowed) ? sheet.sources_allowed.map((x: any) => {
      const pub = String(x?.publisher ?? "");
      const src: CustomSource = { publisher: pub, url: String(x?.url ?? ""), partyControlled: !!x?.party_controlled };
      if (/^(S|M)\d*$/.test(String(x?.id ?? "")) === false && x?.id) src.id = String(x.id);
      if (classes[pub]) src.tier = classes[pub];
      if (pins[pub]) src.ticker = String(pins[pub]);
      return src;
    }) : [],
    windowStart: fromUtcMinute(String(t.window_start ?? "")),
    windowEnd: fromUtcMinute(String(t.window_end ?? "")),
    evidenceCutoff: fromUtcMinute(String(t.evidence_cutoff ?? "")),
    clauses: Array.isArray(sheet.clauses) ? sheet.clauses.map(String) : [],
    windowClose: fromUtcMinute(String(sheet.window_close ?? "")),
    leadingDefinitions: leading, fallbackRule, earlyRule, otherDefinitions: other, notes,
  };
}

/** The deadline the envelope derives from: the end of the event window (resolve_deadline = this + 7d, D-HORIZON1a). */
export function customDeadlineSecs(sheet: Record<string, any>): number | undefined {
  return parseIso(sheet?.time?.window_end) ?? undefined;
}

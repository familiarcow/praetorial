// FE3 (UX spec S2/S3): the bet-type card picker and the fill-in step, as pure logic. Nothing here is a new rule: every problem
// returned is the existing lint's own message (lintTemplate for the 4 typed bets, builderGate/customLint for any-page), so the
// resolver-parity tests keep covering them. Human mode (a person decides, D-REFUI3a) hides the source-related fields.
import { buildTypedSheet, lintTemplate, type TemplateId } from "./templates";
import { fieldsFromForm, GUIDED_FIELDS, type GuidedField, type GuidedForm, type LaunchId } from "./guidedFields";
import { blankCustomForm, sheetFromCustomForm, type CustomForm } from "./customBuilder";
import { builderGate } from "./builderGate";
import { windowOrderProblems, withDetailDefaults } from "./betDetails";
import { cityLabel } from "./nwsCities";
import { assetPriceSheet, assetPriceProblems, isBitcoin, priceLevel, type PriceKind } from "./assetPriceSheet";
import { FALLBACK_ASSETS, type MarketAsset } from "./marketAssets";
import { DEFAULT_MARGIN_PTS, marginPts, outperformProblems, outperformSheet } from "./outperformSheet";

/** BET1a: icon = a key into src/components/BetTypeIcon.tsx (inline SVG, bundled locally). */
export type BetTypeIconId = "clock" | "target" | "compare" | "trophy" | "thermometer" | "globe";
/** A card on the bet-type picker: a resolver template, or "outperform" (TPL1: two coins compared, always an AI-judged custom sheet). */
export type BetKind = TemplateId | "outperform";
export interface BetTypeCard { id: BetKind; title: string; blurb: string; example: string; icon: BetTypeIconId }

export const BET_TYPE_CARDS: BetTypeCard[] = [
  { id: "btc_close_at_t", icon: "clock", title: "Price at a set time", blurb: "Bet on where Bitcoin, Ethereum, Zcash or another listed coin is at an exact minute.", example: "Example: Bitcoin is at or above $75,900 at 15:00 UTC on Dec 1." },
  { id: "btc_touch", icon: "target", title: "Hits a price", blurb: "Bet that Bitcoin, Ethereum, Zcash or another listed coin reaches a level before a deadline.", example: "Example: Bitcoin touches $76,000 before Dec 7." },
  { id: "outperform", icon: "compare", title: "Which outperforms?", blurb: "Bet on which of two coins does better between two times.", example: "Example: Zcash beats Bitcoin by at least 0.5 percentage points from Dec 1 to Dec 8." },
  { id: "game_winner", icon: "trophy", title: "Who wins a game", blurb: "Bet on the winner of a pro game.", example: "Example: the Milwaukee Brewers win their MLB game on Dec 28." },
  { id: "nws_daily_high", icon: "thermometer", title: "Daily high temperature", blurb: "Bet on a city's official daily high.", example: "Example: the high in New York City on Dec 8 is at or above 72\u00b0F." },
  { id: "custom", icon: "globe", title: "Anything else \u2014 any web page", blurb: "Name any page. The AI reads it and decides.", example: "Example: Apple makes a foldable iPhone available to buy in the US during 2027." },
];

/** TPL1 (PM 14:05, familiarcow): the main picker shows ONE "Asset prices" tile; it opens a sub-choice of the price types (PRICE_KINDS). */
export const PRICE_KINDS: BetKind[] = ["btc_close_at_t", "btc_touch", "outperform"];
export interface PickerTile extends Omit<BetTypeCard, "id"> { id: BetKind | "prices" }
export const PICKER_TILES: PickerTile[] = [
  { id: "prices", icon: "compare", title: "Asset prices", blurb: "Bitcoin, Ethereum, Zcash or any listed coin: its price at a set time, a price it hits, or which of two does better.", example: "Example: Zcash is at or above $1,000 at 15:00 UTC on Dec 1." },
  ...BET_TYPE_CARDS.filter((c) => !PRICE_KINDS.includes(c.id)),
];
/** Which picker view a draft of this kind goes Back to: the price sub-choice, or the main tiles (null). */
export function pickerGroupFor(id: BetKind): "prices" | null { return PRICE_KINDS.includes(id) ? "prices" : null; }

/** TPL1: `asset` = what a price bet is about (unset or BTC = the typed, code-decided Bitcoin templates; any other coin = an AI-judged
 *  custom sheet, lib/assetPriceSheet). Never the stake token. */
export interface FillState { typeId: BetKind; guided: GuidedForm; custom: CustomForm; human: boolean; asset?: MarketAsset; assetB?: MarketAsset }
// "Which outperforms?": `asset` = the coin the maker says does better (A), `assetB` = the coin it is compared with (B).

const isPrice = (id: BetKind): id is PriceKind => id === "btc_close_at_t" || id === "btc_touch";
/** A price bet on a coin other than Bitcoin (decided by the AI judge from a custom sheet). */
export function isAltPriceFill(s: FillState): boolean { return isPrice(s.typeId) && !isBitcoin(s.asset); }

export function blankFill(typeId: BetKind): FillState {
  if (typeId === "outperform") {
    const sym = (s: string) => FALLBACK_ASSETS.find((a) => a.symbol === s)!;
    return { typeId, guided: { margin_pts: DEFAULT_MARGIN_PTS }, custom: blankCustomForm(), human: false, asset: sym("ETH"), assetB: sym("BTC") };
  }
  return { typeId, guided: {}, custom: blankCustomForm(), human: false };
}

export type CustomField = "claim" | "elements" | "rule" | "sources" | "windowStart" | "windowEnd" | "evidenceCutoff" | "windowClose" | "fallbackRule" | "earlyRule" | "clauses";
const SOURCE_FIELDS: CustomField[] = ["evidenceCutoff", "windowClose"];
/** Human mode hides only the evidence cutoff / close (nobody collects evidence). SRCREF1c: sources and the fallback rule stay, the contract still needs sources it can check. */
export function customFieldVisible(f: CustomField, human: boolean): boolean {
  return !(human && SOURCE_FIELDS.includes(f));
}

/** The sheet the lint sees. In human mode the evidence cutoff (nobody collects evidence) is set to the end of the window.
 * BET1a: blank More-options values get their defaults (lib/betDetails withDetailDefaults; pure, no clock read). */
// TPL3 (familiarcow: "remove the controlled by a bettor box"): the form has no such box, so every source is sent as not party-controlled
// (a copied old bet that had one marked included). The lint is unchanged: a sheet with fewer independent origins is still refused.
export function customSheetFor(f: CustomForm, human: boolean): Record<string, unknown> {
  const g = { ...f, sources: f.sources.map((s) => ({ ...s, partyControlled: false })) };
  return sheetFromCustomForm(withDetailDefaults(human ? { ...g, evidenceCutoff: g.windowEnd, windowClose: "" } : g));
}

export function typedSheetFor(s: FillState, nowMs: number): Record<string, unknown> {
  if (s.typeId === "outperform") return outperformSheet(s.asset!, s.assetB!, s.guided);
  if (isAltPriceFill(s)) return assetPriceSheet(s.typeId as PriceKind, s.asset!, s.guided, nowMs);
  return buildTypedSheet(s.typeId as LaunchId, fieldsFromForm(s.typeId as LaunchId, s.guided, nowMs));
}

export function fillProblems(s: FillState, nowMs: number): string[] {
  if (s.typeId === "custom") return [...builderGate(customSheetFor(s.custom, s.human), { humanReferee: s.human }).problems, ...windowOrderProblems(s.custom)];
  if (s.typeId === "outperform") return outperformProblems(s.asset, s.assetB, s.guided, nowMs);
  if (isAltPriceFill(s)) return assetPriceProblems(s.typeId as PriceKind, s.asset!, s.guided, nowMs);
  try { return lintTemplate(typedSheetFor(s, nowMs)); } catch (e) { return [`TPL_MALFORMED: ${String((e as any)?.message ?? e)}`]; }
}

const OP_WORDS: Record<string, string> = { ">=": "at or above", ">": "above", "<=": "at or below", "<": "below", at_or_above: "at or above", at_or_below: "at or below" };
const utc = (v: string) => `${v.replace("T", " ")} UTC`;
const usd = (v: string) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
const OTHER = " The other person bets it won't happen.";

/** One plain sentence under the form, e.g. "You are betting that ...". Empty until every field it names is filled in. */
export function betSentence(s: FillState): string {
  const g = s.guided;
  const has = (...k: string[]) => k.every((x) => (g[x] ?? "").trim() !== "");
  const alt = isAltPriceFill(s) ? `${s.asset!.name} (${s.asset!.symbol})` : null;
  if (alt && !priceLevel(g.x_usd)) return "";
  switch (s.typeId) {
    case "btc_close_at_t":
      return has("t_utc", "op", "x_usd") && OP_WORDS[g.op] ? `You are betting that the ${alt ?? "Bitcoin"} price at ${utc(g.t_utc)} is ${OP_WORDS[g.op]} ${usd(g.x_usd)}.${OTHER}` : "";
    case "btc_touch":
      return has("direction", "x_usd", "deadline_utc") && OP_WORDS[g.direction] ? `You are betting that ${alt ?? "Bitcoin"} touches ${usd(g.x_usd)} (${OP_WORDS[g.direction]}) before ${utc(g.deadline_utc)}.${OTHER}` : "";
    case "outperform": {
      const m = marginPts(g.margin_pts);
      if (!has("start_utc", "end_utc") || !m || !s.asset || !s.assetB || s.asset.symbol === s.assetB.symbol) return "";
      const [a, b] = [s.asset, s.assetB].map((x) => `${x.name} (${x.symbol})`);
      return `You are betting that ${a} beats ${b} by at least ${m} percentage points of price change from ${utc(g.start_utc)} to ${utc(g.end_utc)}. If neither coin beats the other by ${m} points, the bet is void and both stakes are refunded. The other person bets that ${b} beats ${a} by at least ${m} points.`;
    }
    case "game_winner": {
      if (!has("league", "scheduled_date", "pick_name")) return "";
      // TPL2: a game chosen in the picker also knows the opponent (display only; the sheet carries just the pick).
      const opp = (g.pick_side === "home" ? g.away_team_name : g.pick_side === "away" ? g.home_team_name : "")?.trim();
      return opp ? `You are betting that ${g.pick_name.trim()} beat ${opp} in the ${g.league} game on ${g.scheduled_date}.${OTHER}`
        : `You are betting that ${g.pick_name.trim()} win the ${g.league} game on ${g.scheduled_date}.${OTHER}`;
    }
    case "nws_daily_high":
      return has("station", "date", "op", "x_f") && OP_WORDS[g.op] ? `You are betting that the daily high in ${cityLabel(g.station)} on ${g.date} is ${OP_WORDS[g.op]} ${g.x_f.trim()}\u00b0F.${OTHER}` : "";
    case "custom": {
      const c = s.custom.claim.trim().replace(/[.\s]+$/, "");
      return c ? `You are betting that ${c}.${OTHER}` : "";
    }
  }
}

/** "10:00 AM EST on Dec 1 in your time zone" for a `YYYY-MM-DDTHH:MM` UTC value; null when the value is not a complete UTC minute. */
export function localTimeLabel(utcMinute: string, timeZone?: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(utcMinute)) return null;
  const d = new Date(`${utcMinute}:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const opts = timeZone ? { timeZone } : {};
  const time = new Intl.DateTimeFormat("en-US", { ...opts, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
  const day = new Intl.DateTimeFormat("en-US", { ...opts, month: "short", day: "numeric" }).format(d);
  return `${time} on ${day} in your time zone`;
}

/** The claim as one sentence for the review card (the "other side" line is dropped). */
export function claimLineFor(s: FillState): string {
  return betSentence(s).replace(/ The other person bets.*$/, "");
}

/** The decisive time/date for the review card: the minute, deadline, game day, weather day or end of the event window. */
export function deadlineLabelFor(s: FillState): string {
  const g = s.guided;
  switch (s.typeId) {
    case "btc_close_at_t": return g.t_utc ? utc(g.t_utc) : "";
    case "btc_touch": return g.deadline_utc ? utc(g.deadline_utc) : "";
    case "outperform": return g.end_utc ? utc(g.end_utc) : "";
    case "game_winner": return g.scheduled_date ?? "";
    case "nws_daily_high": return g.date ?? "";
    case "custom": return s.custom.windowEnd ? utc(s.custom.windowEnd) : "";
  }
}

/** TPL1: the guided fields for this fill with the chosen coin in the labels; a non-Bitcoin price may have cents. */
export function guidedFieldsFor(s: FillState): GuidedField[] {
  if (s.typeId === "outperform") return OUTPERFORM_FIELDS;
  const fields = GUIDED_FIELDS[s.typeId as LaunchId] ?? [];
  if (!isPrice(s.typeId)) return fields;
  const name = s.asset?.name ?? "Bitcoin";
  const alt = isAltPriceFill(s);
  return fields.map((g) => ({
    ...g,
    label: g.key === "x_usd" && alt ? "Price level (US dollars)" : g.label.replace("Bitcoin", name),
    help: g.help,
    placeholder: g.key === "x_usd" && alt ? "" : g.placeholder,
  }));
}

/** TPL1 "Which outperforms?": the two coins are pickers above these; times are UTC minutes, the margin is in percentage points. */
export const OUTPERFORM_FIELDS: GuidedField[] = [
  { key: "start_utc", label: "Start (UTC)", kind: "datetime" },
  { key: "end_utc", label: "End (UTC)", kind: "datetime" },
  { key: "margin_pts", label: "Margin (percentage points)", kind: "text", placeholder: DEFAULT_MARGIN_PTS,
    help: "The winner must beat the other coin's % change by at least this much. If the gap is smaller, the bet is void and both stakes are refunded." },
];

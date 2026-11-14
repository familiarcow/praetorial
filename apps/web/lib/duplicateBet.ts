// FE15 (S17): "Duplicate this bet". Pure: an old bet's stored terms (get_bet) -> a fresh create-form draft. Not a contract feature.
// COPIED: bet type and fields, claim, sources, rules, the stake token, my stake and the other side's stake (BET1b: any launch token offered
// here), who decides (referee, editable), tip choice, offer expiry, settlement window, "invite by link". Old cross-asset taker options are
// dropped (D-SCOPE5: one token per bet).
// NOT COPIED, ever: the bet id, any evidence/exhibit/bond, the old attestation or terms hash, run numbers, the old invite key, the named taker,
// the open_utc stamp. The normal flow then re-does the preflight, stamps open_utc, hashes the new terms and asks for a new funding signature.
import type { CreateDraft } from "../src/components/CreateOffer";
import type { Bet } from "./escrowAdapter";
import { TEMPLATE_IDS, eventTimes, parseIso, templateId, type TemplateId } from "./templates";
import { formFromFields, toUtcMinute, fromUtcMinute, type LaunchId } from "./guidedFields";
import { customFormFromSheet, customDeadlineSecs } from "./customBuilder";
import { blankFill, typedSheetFor, type FillState } from "./betTypePicker";
import { OFFER_EXPIRY_OPTIONS, SETTLEMENT_OPTIONS } from "./stakeDeadlines";
import { findAsset, symbolForAssetId } from "./assets";
import { stakeAssets, DEFAULT_STAKE_SYMBOL, DEFAULT_STAKE_TEXT } from "./stakeSection";
import { fromBaseUnits } from "./decimal";

export const DUPLICATE_MESSAGES = {
  cannotCopy: "We can't copy that bet.",
  noLongerAvailable: "This bet type is no longer available. Start from custom.",
  pastDates: "These dates have passed. Pick new ones.",
};
export const SETTLEMENT_FALLBACK = "24h";

export interface DuplicateCopy {
  draft: CreateDraft;
  /** "Copied from your bet of 2026-10-01 UTC. Check the dates before you continue." */
  banner: string;
  /** Form fields whose dates are now past (guided/custom field keys, plus "resolveDate"). */
  pastKeys: string[];
  pastNote: string | null;
  /** Plain notes about anything that could not be carried over (a different asset, a reset referee date). */
  notes: string[];
}
export type DuplicateResult = { ok: true; copy: DuplicateCopy } | { ok: false; message: string };

const CUSTOM_DATE_KEYS = ["windowStart", "windowEnd", "evidenceCutoff", "windowClose"] as const;
const typedDateKey: Record<LaunchId, string> = { btc_close_at_t: "t_utc", btc_touch: "deadline_utc", game_winner: "scheduled_date", nws_daily_high: "date" };

/** The date fields of this form that are now in the past. Live: editing a date to a future one clears its flag. */
export function pastFillKeys(fill: FillState, nowMs: number): string[] {
  const nowSecs = Math.floor(nowMs / 1000);
  if (fill.typeId === "custom") {
    return CUSTOM_DATE_KEYS.filter((k) => !(fill.human && (k === "evidenceCutoff" || k === "windowClose"))).filter((k) => {
      const v = fill.custom[k] ?? "";
      const t = v ? parseIso(toUtcMinute(v)) : null;
      return t != null && t <= nowSecs;
    }).sort();
  }
  if (fill.typeId === "outperform") { // TPL1: "Which outperforms?" has a start and an end time
    return (["start_utc", "end_utc"] as const).filter((k) => { const t = parseIso(toUtcMinute(fill.guided[k] ?? "")); return t != null && t <= nowSecs; });
  }
  try {
    const sheet = typedSheetFor(fill, nowMs);
    const end = templateId(sheet).id === "custom" ? customDeadlineSecs(sheet) ?? NaN : eventTimes(sheet).endSecs; // TPL1: a non-Bitcoin price bet
    return Number.isFinite(end) && end <= nowSecs ? [typedDateKey[fill.typeId as LaunchId]] : [];
  } catch { return []; }
}

const big = (v: unknown): bigint | null => { try { return BigInt(String(v)); } catch { return null; } };
const day = (ns: number) => new Date(ns / 1e6).toISOString().slice(0, 10);

function nearestExpiry(createdNs: number, fundingNs: number): string {
  const span = (fundingNs - createdNs) / 1e9;
  if (!Number.isFinite(span) || span <= 0) return "7d";
  return OFFER_EXPIRY_OPTIONS.reduce((best, o) => (Math.abs(o.secs - span) < Math.abs(best.secs - span) ? o : best)).id;
}

export function duplicateDraft(bet: Bet | null | undefined, ctx: { me: string | null; nowMs: number }): DuplicateResult {
  const fail = (message: string): DuplicateResult => ({ ok: false, message });
  if (!bet || !bet.envelope || !ctx.me) return fail(DUPLICATE_MESSAGES.cannotCopy);
  const e = bet.envelope;
  const role = ctx.me === e.maker ? "maker" : ctx.me === bet.taker ? "taker" : null;
  if (!role) return fail(DUPLICATE_MESSAGES.cannotCopy);
  let sheet: any;
  try { sheet = typeof e.terms === "string" ? JSON.parse(e.terms) : null; } catch { sheet = null; }
  if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) return fail(DUPLICATE_MESSAGES.cannotCopy);

  const human = !!e.referee?.account;
  let fill: FillState;
  if ("template" in sheet) {
    const id = sheet.template?.id;
    if (!TEMPLATE_IDS.includes(id) || id === "custom") return fail(DUPLICATE_MESSAGES.noLongerAvailable);
    fill = { ...blankFill(id as TemplateId), guided: formFromFields(id as LaunchId, sheet.fields ?? {}), human };
  } else {
    if (typeof sheet.claim !== "string" || !sheet.claim.trim()) return fail(DUPLICATE_MESSAGES.cannotCopy);
    fill = { ...blankFill("custom"), custom: customFormFromSheet(sheet), human };
  }

  const notes: string[] = [];
  const pastKeys = pastFillKeys(fill, ctx.nowMs);

  // Stakes (BET1b): the token, my side's stake and the other side's ("They put in"; null = even), and the odds they make (taker : maker).
  const mine = big(role === "maker" ? e.stake_maker : e.stake_taker);
  const theirs = big(role === "maker" ? e.stake_taker : e.stake_maker);
  const offered = stakeAssets().find((a) => a.assetId === e.maker_asset);
  let stakeSymbol = DEFAULT_STAKE_SYMBOL, stakeText = DEFAULT_STAKE_TEXT, theirText: string | null = null, odds = 1;
  if (e.maker_asset !== e.taker_asset) {
    notes.push(`The old bet was in ${symbolForAssetId(e.maker_asset)} and ${symbolForAssetId(e.taker_asset)}; both sides now use one token. Enter your stake.`);
  } else if (!offered) {
    notes.push(`The old bet was in ${symbolForAssetId(e.maker_asset)}, which you can't stake here. Enter your stake.`);
  } else if (mine && mine > 0n && theirs && theirs > 0n) {
    const decimals = findAsset(offered.symbol)!.decimals;
    stakeSymbol = offered.symbol;
    stakeText = fromBaseUnits(mine.toString(), decimals);
    theirText = theirs === mine ? null : fromBaseUnits(theirs.toString(), decimals);
    odds = Number((theirs * 1_000_000n) / mine) / 1e6;
  }

  const settlementSecs = Math.round(Number(e.settlement_period) / 1e9);
  const settlementPeriod = SETTLEMENT_OPTIONS.find((o) => o.secs === settlementSecs)?.id ?? SETTLEMENT_FALLBACK;

  // Taker: a named account is cleared; invite-by-link stays on (a new key is made after opening).
  const allow = e.taker_allow as any;
  const inviteByLink = !!allow && typeof allow === "object" && "InvitePubkey" in allow;

  // Referee deadline (person decides): carried only while still in the future.
  let resolveDate: string | null = null;
  if (human) {
    const resolveMs = Number(e.resolve_deadline) / 1e6;
    if (Number.isFinite(resolveMs) && resolveMs > ctx.nowMs) resolveDate = new Date(resolveMs).toISOString().slice(0, 10);
    else { pastKeys.push("resolveDate"); notes.push("The old referee deadline has passed; a new one was set. Check it."); }
  }

  const draft: CreateDraft = {
    step: "fill",
    fill,
    referee: human ? { mode: "human", referee: e.referee!.account } : { mode: "ai" },
    more: {
      stakeSymbol, stakeText, theirText, odds, settlementPeriod,
      offerExpiry: nearestExpiry(Number(bet.created_at), Number(e.funding_deadline)),
      resolveDate,
      takerAccount: "", inviteByLink, tipMaker: human && !!e.tip_maker,
    },
  };
  const created = Number(bet.created_at);
  const banner = created > 0 ? `Copied from your bet of ${day(created)} UTC. Check the dates before you continue.` : "Copied from your earlier bet. Check the dates before you continue.";
  return { ok: true, copy: { draft, banner, pastKeys, pastNote: pastKeys.length ? DUPLICATE_MESSAGES.pastDates : null, notes } };
}

// Structured term sheets. The Jason preset below mirrors the canonical
// judge-proto/jason/term_sheet.json 1:1 (claim, sources_allowed, the
// custom_definitions' fallback/VOID/early-YES rules, and the UTC
// deadline) -- see that file for the resolver-side machine-readable
// version. This module gives the app a typed, structured object (never
// a free-text string) plus a client-side validator for custom bets.

import { isCuratedVenue, customVenueFlagMessage } from "./venues";

export interface SourceSpec {
  venue: string; // e.g. "Coinbase", "Bitstamp", "Kraken"
  pair: string; // e.g. "BTC-USD", "btcusd", "XBT/USD"
  timezone: string; // always displayed; UTC is canonical, label may show local
}

export interface FallbackPolicy {
  /// Kraken (or another named venue) used if a primary source is
  /// unavailable at evidence-collection time.
  fallbackVenue: string | null;
  /// "any N of the approved list" -- on by default per the task brief.
  fallbackAnyNOf: number;
  approvedSources: string[]; // full eligible venue+pair list
}

export interface TermSheet {
  isPreset: boolean;
  claimText: string;
  sources: SourceSpec[];
  thresholdUsd: number | null;
  candleWindowMinutes: number; // 1-minute candle
  confirmWithinMinutes: number; // both sources within the same 5-minute window
  deadlineUtcIso: string;
  deadlineLabel: string; // human label, timezone-correct (PDT not PST for this date)
  earlyYesAllowed: boolean;
  fallback: FallbackPolicy;
  voidPolicy: string; // plain-English statement of when VOID fires
}

// Canonical Jason term sheet (judge-proto/jason/term_sheet.json).
export const JASON_TERM_SHEET: TermSheet = {
  isPreset: true,
  claimText:
    "Bitcoin's 1-minute candle high reaches or exceeds $126,210.50 on BOTH Coinbase (BTC-USD) and Bitstamp (btcusd) within the same 5-minute window, on or before 2028-10-28 19:00 UTC.",
  sources: [
    { venue: "Coinbase", pair: "BTC-USD", timezone: "UTC" },
    { venue: "Bitstamp", pair: "btcusd", timezone: "UTC" },
  ],
  thresholdUsd: 126210.5,
  candleWindowMinutes: 1,
  confirmWithinMinutes: 5,
  deadlineUtcIso: "2028-10-28T19:00:00Z",
  // 2028-10-28 is during US Daylight Time -- UTC-7, so 19:00 UTC is
  // 12:00 PM PDT, never "PST" (the old preset's bug this TODO fixes).
  deadlineLabel: "Oct 28, 2028, 12:00 PM PDT (19:00 UTC)",
  earlyYesAllowed: true,
  fallback: {
    fallbackVenue: "Kraken (XBT/USD)",
    fallbackAnyNOf: 2,
    approvedSources: ["Coinbase BTC-USD", "Bitstamp btcusd", "Kraken XBT/USD"],
  },
  voidPolicy:
    "VOID (full refund) only if fewer than 2 of {Coinbase, Bitstamp, Kraken} can be checked at all, and only after the recovery ladder (retries over a 24h x 7d window) is exhausted -- never on the first failed check.",
};

export function blankCustomTermSheet(): TermSheet {
  return {
    isPreset: false,
    claimText: "",
    sources: [{ venue: "", pair: "", timezone: "" }],
    thresholdUsd: null,
    candleWindowMinutes: 1,
    confirmWithinMinutes: 5,
    deadlineUtcIso: "",
    deadlineLabel: "",
    earlyYesAllowed: true,
    fallback: { fallbackVenue: null, fallbackAnyNOf: 2, approvedSources: [] },
    voidPolicy:
      "VOID (full refund) if fewer than 2 approved sources can be checked, after the recovery ladder is exhausted.",
  };
}

// Non-blocking informational notes for any named source whose venue
// isn't on the curated built-in-fetcher list (task brief #2: custom
// venues are allowed, just flagged -- never refused).
export function customVenueFlags(ts: TermSheet): string[] {
  const notes: string[] = [];
  for (const s of ts.sources) {
    if (!s.venue.trim() || !s.pair.trim()) continue;
    if (!isCuratedVenue(s.pair, s.venue)) notes.push(customVenueFlagMessage(s.venue, s.pair));
  }
  return notes;
}

// Review-card validation (TODO #2): flag any undefined timezone, trading
// pair, source/venue, or deadline on a CUSTOM (non-preset) bet. The
// preset is always well-formed by construction, so this only runs for
// custom claims. "Open offer" stays blocked while flags.length > 0.
// D-HORIZON1a: a bet may run at most 1,461 days (4 years) from open (contract-enforced).
export const HORIZON_MESSAGE = "Bets can last at most 4 years (D-HORIZON1a).";
export const PRESET_HORIZON_MESSAGE = "This bet runs past 4 years; it needs a later contract (D-HORIZON1a)";
export const MAX_HORIZON_MS = 1_461 * 86_400_000;

export function validateTermSheet(ts: TermSheet, nowMs: number = Date.now(), _opts: { humanReferee?: boolean } = {}): string[] {
  // D-HORIZON1a applies to the preset too (JP1): the preset is otherwise
  // well-formed by construction, so only the horizon check runs for it.
  if (ts.isPreset) {
    const d = Date.parse(ts.deadlineUtcIso);
    return !Number.isNaN(d) && d - nowMs > MAX_HORIZON_MS ? [PRESET_HORIZON_MESSAGE] : [];
  }
  const flags: string[] = [];
  if (!ts.claimText.trim()) flags.push("Claim text is empty.");
  // SRCREF1c / D-PM3 option C: sources are required in human mode too (the contract needs a source-check attestation).
  if (ts.sources.length === 0) {
    flags.push("At least one source is required.");
  }
  ts.sources.forEach((s, i) => {
    const label = `Source ${i + 1}`;
    if (!s.venue.trim()) flags.push(`${label}: venue is undefined.`);
    else if (s.venue.trim().length < 3) flags.push(`${label}: venue "${s.venue}" is too vague to resolve against.`);
    // Non-curated venues are allowed (D-VENUE1) -- flagged separately via
    // customVenueFlags(), never blocked here.
    if (!s.pair.trim()) flags.push(`${label}: trading pair is undefined.`);
    if (!s.timezone.trim()) flags.push(`${label}: timezone is undefined.`);
  });
  if (!ts.deadlineUtcIso.trim()) flags.push("Deadline (UTC) is undefined.");
  else if (Number.isNaN(Date.parse(ts.deadlineUtcIso))) flags.push("Deadline is not a valid UTC timestamp.");
  else if (Date.parse(ts.deadlineUtcIso) - nowMs > MAX_HORIZON_MS) flags.push(HORIZON_MESSAGE);
  return flags;
}

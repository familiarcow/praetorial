// FE16 (S18): the app-wide states (paused / shut down / offline) and the plain-English strings for the load, empty and error states
// that used to show developer text. One place, so a screen and its test read the same sentence.
export const COPY = {
  paused: "New bets are paused. You can't make or take a bet right now; bets that are already live carry on as normal.",
  shutdown: "Praetorial is shut down. No new bets can be made or taken. If you have a live bet, open it and press \"Get my money back\" to get your stake back in full.",
  outOfDate: "This page is out of date. Refresh.",
  moneyStale: "This page is out of date, so the amounts are hidden until it loads again.",
  offline: "You're offline. Reconnect to make or take a bet. What you see may be out of date.",
  createPaused: "Making new bets is temporarily paused.",
  createShutdown: "Making new bets is off: Praetorial is shut down.",
  takePaused: "New bets are paused. This one can't be taken yet. Try again later.",
  takeShutdown: "Praetorial is shut down, so this bet can't be taken.",
  refundButton: "Get my money back",
  loading: "Loading…",
  betLoadFailed: "We couldn't load this bet. Check your connection and try again.",
  listLoadFailed: "We couldn't load the list. Try again in a moment.",
  noOpenBets: "No open bets right now.",
  noBetsYet: "You have no bets yet.",
  loginToSeeBets: "Log in to see your bets.",
  balanceLoading: "Loading your balance…",
  balanceUnavailable: "unavailable",
  walletSettingUp: "Setting up your wallet…",
  connection: "Connection problem. Retrying…",
  navCreate: "Create bet", // NAV1 (UX-31 PM call: "Create bet" as the primary action)
} as const;

export interface GlobalBanner { kind: "offline" | "shutdown" | "paused" | "out-of-date" | "busy" | "connection"; text: string }

/** Offline can sit alongside a contract state; shutdown implies paused on the contract, so it is shown instead of the paused banner. */
export function globalBanners(s: { paused: boolean; shutdown: boolean; offline: boolean; busySeconds?: number; outOfDate?: boolean; viewFailed?: boolean }): GlobalBanner[] {
  const out: GlobalBanner[] = [];
  if (s.outOfDate) out.push({ kind: "out-of-date", text: COPY.outOfDate });
  if (s.offline) out.push({ kind: "offline", text: COPY.offline });
  if (s.shutdown) out.push({ kind: "shutdown", text: COPY.shutdown });
  else if (s.paused) out.push({ kind: "paused", text: COPY.paused });
  if (s.busySeconds != null && s.busySeconds > 0) out.push({ kind: "busy", text: busyText(s.busySeconds) });
  // REVIEW1 (#8): a failed read is being re-tried in the background (lib/liveState). Offline already says why.
  else if (s.viewFailed && !s.offline) out.push({ kind: "connection", text: COPY.connection });
  return out;
}

// ---- FE16b ----
/** Money figures and money actions are off when what we last read can't be trusted. */
export function moneyBlocked(s: { offline: boolean; viewFailed: boolean; outOfDate: boolean }): boolean {
  return s.offline || s.viewFailed || s.outOfDate;
}
export const MONEY_HIDDEN = "—";
export const showMoney = (text: string, stale: boolean): string => (stale ? MONEY_HIDDEN : text);
export const busyText = (secs: number): string => (secs > 0 ? `Busy, retrying in ${secs}s` : "Busy, retrying now");
/** Seconds to wait from a Retry-After header (whole seconds); default 5, clamped to 1..60. */
export function parseRetryAfter(v: string | null | undefined): number {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return 5;
  return Math.min(60, Math.max(1, Math.round(n)));
}
/** "network" = the RPC is on a different chain than lib/release.json; "release" = the contract pins another resolver than this build. Unknown reads never flag. */
export function outOfDateReason(rel: { network: string; resolver_wasm_hash: string }, seen: { chainId?: string | null; resolverKeys?: string[] | null }): "network" | "release" | null {
  if (typeof seen.chainId === "string" && seen.chainId && seen.chainId !== rel.network) return "network";
  const k = seen.resolverKeys;
  if (Array.isArray(k) && k.length >= 3 && k[2] !== rel.resolver_wasm_hash) return "release";
  return null;
}

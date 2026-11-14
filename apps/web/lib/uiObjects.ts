// MODAL1b: pure logic behind the shared UI objects in src/objects/ (no React, so tsx --test can cover it).
// Money text lives in lib/amount.ts (formatAmount); myBets uses it. All math is BigInt / decimal strings.
import { findAsset, isAssetEnabled, disabledReason, type NetworkId } from "./assets";
import { ALL_STATUSES, statusChip, type Chip } from "./liveBet";
import { sideFee } from "./stakeDeadlines";
import type { Bet } from "./escrowAdapter";

export { formatAmount, type AmountOpts } from "./amount";
import { formatAmount } from "./amount";

export type Tone = "neutral" | "info" | "warn" | "good" | "bad";
export const PILL_STATUSES = ALL_STATUSES;
const TONE: Record<Chip["id"], Tone> = { open: "info", live: "info", ruling: "info", dispute: "warn", paying: "warn", done: "good", refunded: "neutral", cancelled: "neutral", expired: "neutral" };

export interface StatusPillInfo { id: Chip["id"]; label: string; sentence: string; tone: Tone }
/** Label, plain sentence and tone for a contract BetStatus. `referee` (account) only changes who "decides". */
export function statusPillFor(status: string, referee?: string | null, outcome?: string | null): StatusPillInfo {
  const bet = { status, outcome: outcome ?? "x", envelope: { referee: referee ? { account: referee } : null } } as unknown as Bet;
  const c = statusChip(bet, null);
  return { ...c, tone: c.label === "Unknown" ? "neutral" : TONE[c.id] };
}

/** Time left until targetMs. >= 1 day "2d 5h", >= 1 hour "3h 5m", else "M:SS". Sub-second remaining still counts as time left. */
export function countdownText(targetMs: number, nowMs: number): { expired: boolean; text: string; totalSecs: number } {
  const ms = targetMs - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return { expired: true, text: "0:00", totalSecs: 0 };
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60);
  const text = d > 0 ? `${d}d ${h}h` : total >= 3600 ? `${h}h ${m}m` : `${m}:${String(total % 60).padStart(2, "0")}`;
  return { expired: false, text, totalSecs: total };
}

export interface FeeRow { id: "stake" | "fee" | "tip"; label: string; units: bigint; text: string }
export interface FeeBreakdownInfo { rows: FeeRow[]; stakeUnits: bigint; feeUnits: bigint; tipUnits: bigint; afterFeeUnits: bigint; totalUnits: bigint; totalText: string }
/** Stake, the contract's side fee (side_fee, incl. the minimum-fee floor) and an optional referee tip. total = stake + tip; stake = fee + afterFee exactly. */
export function feeBreakdown(a: { symbol: string; stakeUnits: bigint; feeBps: number; minFeePerSide: bigint; tipUnits?: bigint }): FeeBreakdownInfo {
  const tip = a.tipUnits ?? 0n;
  const fee = sideFee(a.stakeUnits, a.feeBps, a.minFeePerSide);
  const t = (u: bigint) => formatAmount(a.symbol, u, { cents: true });
  const rows: FeeRow[] = [
    { id: "stake", label: "Your stake", units: a.stakeUnits, text: t(a.stakeUnits) },
    { id: "fee", label: "Fee (taken from the stake)", units: fee, text: t(fee) },
  ];
  if (tip > 0n) rows.push({ id: "tip", label: "Referee tip", units: tip, text: t(tip) });
  const total = a.stakeUnits + tip;
  return { rows, stakeUnits: a.stakeUnits, feeUnits: fee, tipUnits: tip, afterFeeUnits: a.stakeUnits - fee, totalUnits: total, totalText: t(total) };
}

/** 64-hex implicit accounts are unreadable; show first 6 + last 4. Named accounts stay whole. */
export function shortAccount(id: string): string {
  return /^[0-9a-f]{64}$/.test(id) ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export function refereeChipFor(referee: { account: string } | null | undefined): { kind: "ai" | "human"; label: string } {
  return referee ? { kind: "human", label: referee.account } : { kind: "ai", label: "AI referee" };
}

export function assetBadgeFor(symbol: string, network: NetworkId): { symbol: string; decimals: number; enabled: boolean; reason: string | null } {
  return { symbol, decimals: findAsset(symbol)?.decimals ?? 0, enabled: isAssetEnabled(symbol, network), reason: isAssetEnabled(symbol, network) ? null : disabledReason(symbol, network) };
}

export interface ToastItem { id: string; tone: "info" | "success" | "error"; text: string }
export const MAX_TOASTS = 3;
export type ToastAction = { type: "add"; toast: ToastItem } | { type: "dismiss"; id: string };
export function toastReducer(s: ToastItem[], a: ToastAction): ToastItem[] {
  if (a.type === "dismiss") return s.some((t) => t.id === a.id) ? s.filter((t) => t.id !== a.id) : s;
  const next = [...s.filter((t) => t.id !== a.toast.id), a.toast];
  return next.slice(-MAX_TOASTS);
}

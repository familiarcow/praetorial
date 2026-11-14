// FE2b / S11: the take review's choices survive a detour to /add-money (BetPage unmounts on the way).
export interface TakeReviewState { tip: boolean; asset: string | null }
const key = (betId: number) => `praetorial:take-review:${betId}`;
const DEFAULT: TakeReviewState = { tip: false, asset: null };

export function saveTakeReview(s: Storage, betId: number, v: TakeReviewState): void {
  try { s.setItem(key(betId), JSON.stringify(v)); } catch { /* storage full/blocked: the choice just resets */ }
}
export function loadTakeReview(s: Storage, betId: number): TakeReviewState {
  try {
    const j = JSON.parse(s.getItem(key(betId)) ?? "null");
    if (j && typeof j.tip === "boolean" && (j.asset === null || typeof j.asset === "string")) return { tip: j.tip, asset: j.asset };
  } catch { /* fall through */ }
  return { ...DEFAULT };
}
export function clearTakeReview(s: Storage, betId: number): void {
  try { s.removeItem(key(betId)); } catch { /* ignore */ }
}

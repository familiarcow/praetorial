// JC1w (D-JUDGECHAIN1 point 9): display model for the public "Judge models" page + the long-bet builder note.
// Views: judge_chain() -> [{model_a, model_b}], pending_judge_pair() -> null | {pair, proposed_at_ns, effective_at_ns}.
import { viewFunction } from "./rpc";
import { ESCROW_CONTRACT_ID } from "./config";

export interface RawJudgePair { model_a: string; model_b: string }
export interface RawPendingJudgePair { pair: RawJudgePair; proposed_at_ns: number | string; effective_at_ns: number | string }
export interface JudgeChainViews { chain: RawJudgePair[]; pending: RawPendingJudgePair | null }

export type ViewFn = (method: string, args?: Record<string, unknown>) => Promise<any>;
const rpcView: ViewFn = (method, args = {}) => viewFunction<any>(ESCROW_CONTRACT_ID, method, args);

export async function loadJudgeChain(view: ViewFn = rpcView): Promise<JudgeChainViews> {
  const [chain, pending] = await Promise.all([view("judge_chain", {}), view("pending_judge_pair", {})]);
  return { chain: chain ?? [], pending: pending ?? null };
}

export interface JudgePairRow { position: number; role: "primary" | "backup"; modelA: string; modelB: string }
export interface PendingRow { modelA: string; modelB: string; effectiveAtIso: string; active: false; label: string }
export interface JudgeChainDisplay { pairs: JudgePairRow[]; pending: PendingRow | null }

export function judgeChainDisplay(v: JudgeChainViews): JudgeChainDisplay {
  const pairs = v.chain.map((p, i): JudgePairRow => ({ position: i + 1, role: i === 0 ? "primary" : "backup", modelA: p.model_a, modelB: p.model_b }));
  let pending: PendingRow | null = null;
  if (v.pending) {
    const effectiveAtIso = new Date(Number(BigInt(v.pending.effective_at_ns) / 1_000_000n)).toISOString();
    pending = { modelA: v.pending.pair.model_a, modelB: v.pending.pair.model_b, effectiveAtIso, active: false, label: `Proposed backup pair, not yet active (can be added from ${effectiveAtIso})` };
  }
  return { pairs, pending };
}

// No existing "long bet" constant (only the 4-year max); a bet resolving more than 7 days out gets the note.
export const LONG_BET_NOTE_MS = 7 * 86_400_000;
export const JUDGE_MODELS_HREF = "#judge-models";

export function longBetJudgeNote(deadlineMs: number, nowMs: number = Date.now()): { text: string; href: string; linkLabel: string } | null {
  if (Number.isNaN(deadlineMs) || deadlineMs - nowMs <= LONG_BET_NOTE_MS) return null;
  return {
    text: "This bet resolves more than 7 days from now, so the judge may move to a later pair in the chain if its models are retired.",
    href: JUDGE_MODELS_HREF,
    linkLabel: "Judge models",
  };
}

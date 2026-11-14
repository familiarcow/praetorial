// KEEPSUBMIT1W: web fallback for the keeper (KEEPSUBMIT1b). escrow.on_resolution stores the resolver's output in bet.last_resolution_raw
// and never applies it; submit_outcome(result, signature_hex) is permissionless and the contract verifies the resolver signature,
// terms_hash and run order. This decides whether the stored output is a SIGNED result for the in-flight run (so the button may show)
// and builds the exact args: the stored result + signature forwarded byte for byte, never re-signed or re-computed.
// Mirrors services/common/src/outcomeRelay.ts (the keeper's planner), restricted to status Resolving.
import type { Bet } from "./escrowAdapter";

export interface JudgeRulingArgs { result: Record<string, unknown> & { bet_id: number; run_no: number; checked_until: string }; signature_hex: string }
export type JudgeRulingPlan = { ok: true; args: JudgeRulingArgs; run_no: number; outcome: string } | { ok: false; reason: string };
const no = (reason: string): JudgeRulingPlan => ({ ok: false, reason });

/** Digits of every `"<key>": <int or "int">` in the raw text, in order (JSON.parse would round a ns value above 2^53). */
function exactU64s(raw: string, key: string): string[] {
  return [...raw.matchAll(new RegExp(`"${key}"\\s*:\\s*"?(\\d+)"?`, "g"))].map((m) => m[1]);
}

export function planJudgeRuling(contractId: string, betId: number, bet: Bet): JudgeRulingPlan {
  if (bet.status !== "Resolving") return no(`status ${bet.status} is not Resolving`);
  const raw = bet.last_resolution_raw;
  if (typeof raw !== "string" || raw === "") return no("no stored resolver output");
  let o: any;
  try { o = JSON.parse(raw); } catch { return no("stored output is not valid JSON"); }
  if (!o || typeof o !== "object" || !o.result || typeof o.result !== "object") return no("stored output has no result (error output)");
  const sig = o.signing?.signature_hex;
  if (typeof sig !== "string" || !/^[0-9a-fA-F]{128}$/.test(sig)) return no("stored output is unsigned");
  if (o.contract !== contractId) return no("stored output is for another contract");
  const r = o.result;
  if (Number(r.bet_id) !== betId) return no("stored result is for another bet");
  if (typeof r.run_no !== "number") return no("result.run_no missing");
  if (bet.pending_run_no === null || bet.pending_run_no === undefined) return no("no resolution in flight");
  if (r.run_no !== bet.pending_run_no) return no("run_no does not match the pending run");
  if ((bet.used_run_nos ?? []).includes(r.run_no)) return no("run_no already used");
  if (r.terms_hash !== bet.envelope.terms_hash) return no("terms_hash mismatch");
  if (typeof r.outcome !== "string" || typeof r.element_results_hash !== "string") return no("result missing outcome/element_results_hash");
  const cu = exactU64s(raw, "checked_until")[0];
  if (cu === undefined) return no("result.checked_until missing");
  const result: any = { ...r, checked_until: cu };
  const nc = exactU64s(raw, "next_check_ns")[0];
  if (nc !== undefined) result.next_check_ns = nc;
  if (Array.isArray(r.model_not_found)) {
    const obs = exactU64s(raw, "observed_ns");
    result.model_not_found = r.model_not_found.map((m: any, i: number) => ({ ...m, observed_ns: obs[i] ?? String(m.observed_ns) }));
  }
  return { ok: true, args: { result, signature_hex: sig }, run_no: r.run_no, outcome: r.outcome };
}

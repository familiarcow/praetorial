// KEEPSUBMIT1: decide whether the keeper may relay a bet's stored resolver output (bet.last_resolution_raw, written by the escrow's
// on_resolution callback and never applied by it) to the permissionless submit_outcome, and build the exact args.
// The contract re-verifies everything (resolver signature against resolver_keys()[0], terms_hash, run order); this planner only refuses
// what can never succeed so the keeper does not burn gas on it. It never signs anything: it forwards the stored result + signature byte for byte.
import type { Bet } from "./types.js";

export const RELAYABLE_STATUSES = ["Taken", "Resolving", "Challenged", "Evidence"] as const;

export interface OutcomeRelayArgs { result: Record<string, unknown> & { bet_id: number; run_no: number; checked_until: string }; signature_hex: string }
export type OutcomeRelayPlan = { ok: true; args: OutcomeRelayArgs; run_no: number; outcome: string } | { ok: false; reason: string };

const no = (reason: string): OutcomeRelayPlan => ({ ok: false, reason });

/** Digits of every `"<key>": <int or "int">` in the raw text, in order (JSON.parse would round a ns value above 2^53 as a JS number). */
function exactU64s(raw: string, key: string): string[] {
  return [...raw.matchAll(new RegExp(`"${key}"\\s*:\\s*"?(\\d+)"?`, "g"))].map((m) => m[1]);
}

export function planOutcomeRelay(contractId: string, betId: number, bet: Bet): OutcomeRelayPlan {
  if (!(RELAYABLE_STATUSES as readonly string[]).includes(bet.status)) return no(`status ${bet.status} does not accept an outcome`);
  const raw = bet.last_resolution_raw;
  if (typeof raw !== "string" || raw === "") return no("no stored resolver output");
  let o: any;
  try { o = JSON.parse(raw); } catch { return no("stored resolver output is not valid JSON (malformed or truncated)"); }
  if (!o || typeof o !== "object" || !o.result || typeof o.result !== "object") return no("stored output has no result (error output)");
  const sig = o.signing?.signature_hex;
  if (typeof sig !== "string" || !/^[0-9a-fA-F]{128}$/.test(sig)) return no("stored output is unsigned (no signing.signature_hex)");
  if (o.contract !== contractId) return no(`contract field ${String(o.contract)} != ${contractId}`);
  const r = o.result;
  if (Number(r.bet_id) !== betId) return no(`result.bet_id ${String(r.bet_id)} != ${betId}`);
  if (typeof r.run_no !== "number") return no("result.run_no missing");
  if (bet.pending_run_no === null || bet.pending_run_no === undefined) return no("no pending_run_no (no resolution in flight)");
  if (r.run_no !== bet.pending_run_no) return no(`run_no ${r.run_no} != pending_run_no ${bet.pending_run_no}`);
  if ((bet.used_run_nos ?? []).includes(r.run_no)) return no(`run_no ${r.run_no} already used`);
  if (r.terms_hash !== bet.envelope.terms_hash) return no("result.terms_hash != bet terms_hash");
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

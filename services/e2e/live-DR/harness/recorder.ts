// DR0 part 1: evidence recorder. Takes what a rehearsal run observed (tx results, get_bet snapshots, balances
// before/after finalize) and writes an evidence directory in the layout services/verifier/final_step.sh reads
// (services/e2e/live-runR3e). Pure file output: no network, no keys, no env reads.
import { assertRealJudge } from "./judgeBackend.js";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Balances { maker: string; taker: string; fee: string; escrow: string; [k: string]: string }
export interface RecordedRun {
  escrow: string;
  betId: number;
  wasmSha256: string;
  newArgs: Record<string, any>;
  /** resolver_keys = [outcome_pubkey, attest_pubkey, resolver_wasm_hash] */
  views: { outlayer_config: Record<string, unknown>; resolver_keys: string[]; keeper_credit_balance?: string };
  termsRaw: string;
  /** checked_at is a u64 in ns: kept as a decimal string and written verbatim (a JS number would change the digits) */
  sourcecheck: { spec_hash: string; checked_at: string; pubkey_hex: string; signature_hex: string; tx_hash?: string };
  /** DR1b: B4 material captured at run time. responses = {sha256(raw NEAR AI stream): stream}, sources = {id: reader text}. */
  judgeEvidence?: { sources?: Record<string, string>; responses?: Record<string, string> };
  /** DR1b: NEAR AI public attestation reports (keyless GET /v1/attestation/report?model=&signing_address=), one per signer, verbatim body. */
  attestations?: { model: string; signing_address: string; raw: string }[];
  rawResolution: { result: Record<string, any>; signing: { pubkey_hex: string; signature_hex: string }; judge?: any; [k: string]: any };
  /** get_bet snapshots */
  bets: { afterRequest: Record<string, any>; afterSubmit: { status: string; outcome: string; proposed_at_ns: string | number } };
  txs: Record<string, any>[];
  finalize: {
    txs: Record<string, any>[];
    before: { ts: string; status: string; outcome: string; balances: Balances; [k: string]: any };
    after: { ts: string; status: string; outcome: string; balances: Balances; pending_not_done: number; [k: string]: any };
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (v: unknown) => JSON.stringify(v, null, 1) + "\n";

/** raw-unit deltas between two balance views, computed here (never trusted from the caller). */
export function deltas(before: Balances, after: Balances): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(after)) out[k] = (BigInt(after[k]) - BigInt(before[k] ?? "0")).toString();
  return out;
}

/** Distinct (model, signing_address) signers of the recorded NEAR AI answers: what B4 needs an attestation report for. */
export function attestationTargets(rawResolution: any): { model: string; signing_address: string }[] {
  const seen = new Set<string>(), out: { model: string; signing_address: string }[] = [];
  for (const d of rawResolution?.judge?.run_diagnostics ?? []) {
    const p = d.signature_proof;
    if (!p || typeof d.model !== "string") continue;
    const k = `${d.model}\n${String(p.signing_address).toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ model: d.model, signing_address: String(p.signing_address).toLowerCase() });
  }
  return out;
}

/** What verify-bet B4 will still SKIP on for this record + captured material. [] means B4 can be a full PASS. Never treated as optional. */
export function b4Gaps(rawResolution: any, m: { judgeEvidence?: RecordedRun["judgeEvidence"]; attestations?: RecordedRun["attestations"] }): string[] {
  const gaps: string[] = [];
  const diags: any[] = rawResolution?.judge?.run_diagnostics ?? [];
  const missingStreams = diags.filter((d) => d.signature_proof && m.judgeEvidence?.responses?.[d.signature_proof.response_sha256] === undefined).length;
  if (missingStreams) gaps.push(`raw NEAR AI stream for ${missingStreams} answer(s) (judge_evidence.json responses; binds the answer text to the signature)`);
  const srcs: any[] = rawResolution?.judge?.sources ?? [];
  const missingSrc = srcs.filter((s) => m.judgeEvidence?.sources?.[s.id] === undefined).map((s) => s.id);
  if (missingSrc.length) gaps.push(`source text for ${missingSrc.join(",")} (judge_evidence.json sources; quote-in-source check)`);
  const noAtt = attestationTargets(rawResolution).filter((t) => !(m.attestations ?? []).some((a) => a.model === t.model && a.signing_address.toLowerCase() === t.signing_address));
  if (noAtt.length) gaps.push(`attestation report for ${noAtt.map((t) => `${t.model} signer ${t.signing_address.slice(0, 12)}...`).join("; ")}`);
  return gaps;
}

/** Writes judge_evidence.json (--judge-evidence) and attestation_report_<n>.json (--attestation) when captured. */
export function writeJudgeEvidence(m: { judgeEvidence?: RecordedRun["judgeEvidence"]; attestations?: RecordedRun["attestations"] }, dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (m.judgeEvidence) writeFileSync(join(dir, "judge_evidence.json"), JSON.stringify(m.judgeEvidence));
  (m.attestations ?? []).forEach((a, i) => writeFileSync(join(dir, `attestation_report_${i + 1}.json`), a.raw));
}

export function writeEvidenceDir(run: RecordedRun, dir: string): void {
  const f = run.finalize;
  // FRZ2SEC1: no evidence dir for a run the offline mock judged (key not injected), whichever copy of the raw we hold.
  assertRealJudge(run.rawResolution, "rawResolution");
  const lr = run.bets?.afterRequest?.last_resolution_raw;
  if (lr !== undefined && lr !== null) assertRealJudge(lr, "bets.afterRequest.last_resolution_raw");
  if (BigInt(f.after.balances.escrow) !== 0n) throw new Error(`recorder: escrow still holds ${f.after.balances.escrow} after the last payout (must be 0)`);
  if (f.after.pending_not_done !== 0) throw new Error(`recorder: ${f.after.pending_not_done} payouts still pending after finalize`);
  if (run.views.resolver_keys.length !== 3) throw new Error("recorder: views.resolver_keys must be [outcome_pubkey, attest_pubkey, resolver_wasm_hash]");
  if (!/^\d+$/.test(run.sourcecheck.checked_at)) throw new Error("recorder: sourcecheck.checked_at must be a decimal ns string");
  mkdirSync(dir, { recursive: true });
  const w = (name: string, body: string) => writeFileSync(join(dir, name), body);

  w("escrow_name.txt", run.escrow + "\n");
  w("terms.json", run.termsRaw);
  w("results.json", json({
    txs: run.txs,
    recreated: { wasm_sha256: run.wasmSha256, new_args: run.newArgs, views: run.views },
    terms_sha256: sha256(run.termsRaw),
    bet_id: run.betId,
    bet_after_request: run.bets.afterRequest,
    bet_after_submit: run.bets.afterSubmit,
    summary: { escrow: run.escrow, recorder: "services/e2e/live-DR/harness/recorder.ts" },
  }));
  w("raw_resolution.txt", JSON.stringify(run.rawResolution));
  // the loader reads everything after the first "\n{" as JSON and takes checked_at's exact digits from the text
  const sc = run.sourcecheck;
  w("sourcecheck.log", `Tx: ${sc.tx_hash ?? "n/a"}\n{\n  "checked_at": ${sc.checked_at},\n  "ok": true,\n  "signing": {\n    "pubkey_hex": "${sc.pubkey_hex}",\n    "signature_hex": "${sc.signature_hex}"\n  },\n  "spec_hash": "${sc.spec_hash}",\n  "unreachable": []\n}\n`);
  writeJudgeEvidence(run, dir);
  w("b4_evidence.json", json({
    captured: { streams: Object.keys(run.judgeEvidence?.responses ?? {}).length, sources: Object.keys(run.judgeEvidence?.sources ?? {}).length, attestations: (run.attestations ?? []).length },
    gaps: b4Gaps(run.rawResolution, run),
    note: "gaps == what verify-bet B4 will SKIP on; B4 is never optional (DR1b). Run: verify-bet --evidence-dir <dir> --judge-evidence <dir>/judge_evidence.json --attestation <dir>/attestation_report_N.json",
  }));
  w("results_finalize.json", json({
    txs: f.txs,
    before: f.before,
    after: { ...f.after, deltas: deltas(f.before.balances, f.after.balances) },
  }));
}

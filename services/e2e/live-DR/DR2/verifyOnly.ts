// DR2 phase 2, "already settled: verify-only" helpers. Pure functions (unit-tested); the live script is finishVerify.ts.
// Used when the keeper request/submit/finalize path settled the bet before the harness fetched ESPN truth: the record says so, never fakes ordering.
import type { GameTruth, Outcome } from "./groundTruth.js";

export interface ChainTx { hash: string; signer: string; method: string; argsB64: string; tsNs: string; logs: string[] }
export interface TxRow { method: string; hash: string; by: "keeper" | "taker" | "maker" | "other"; signer: string; webDriven: boolean; tsNs: string; args: any; logs: string[] }

export function groundTruthRecord(t: GameTruth, o: { betId: number; fetchedAtIso: string; chainOutcomeAtFetch: string | null; proposedAtNs: string | null }) {
  const before = o.chainOutcomeAtFetch !== null;
  return {
    bet_id: o.betId, fetched_at: o.fetchedAtIso, source: "ESPN public scoreboard (independent of the judge)", raw_sha256: t.rawSha256,
    home: t.home, away: t.away, final: t.final, winner: t.winner, pick_team_abbr: t.pick_team_abbr, outcome: t.outcome, reason: t.reason,
    outcome_read_before_this: before,
    ordering_note: before
      ? `The bet was already Settled on chain (outcome ${o.chainOutcomeAtFetch}, proposed_at ${o.proposedAtNs}) before the harness fetched this ESPN truth; the keeper path ran request_resolution/submit_outcome/finalize without the harness. ESPN is independent of the judge, so the comparison is still valid, but the truth was NOT written ahead of the chain outcome.`
      : "Written before any outcome was on chain.",
  };
}

export function classifyTxs(txs: ChainTx[], c: { betId: number; keeper: string; taker: string; maker: string }): TxRow[] {
  const want = new Set(["request_resolution", "submit_outcome", "finalize"]);
  const rows: TxRow[] = [];
  for (const t of txs) {
    if (!want.has(t.method)) continue;
    let args: any = {}; try { args = JSON.parse(Buffer.from(t.argsB64, "base64").toString("utf8")); } catch { /* keep {} */ }
    const id = args.bet_id ?? args.result?.bet_id;
    if (Number(id) !== c.betId) continue;
    const by = t.signer === c.keeper ? "keeper" : t.signer === c.taker ? "taker" : t.signer === c.maker ? "maker" : "other";
    rows.push({ method: t.method, hash: t.hash, by, signer: t.signer, webDriven: by === "taker" || by === "maker", tsNs: t.tsNs, args, logs: t.logs });
  }
  return rows.sort((a, b) => Number(BigInt(a.tsNs) - BigInt(b.tsNs)));
}

export function explainRuns(rows: TxRow[], bet: { used_run_nos: number[]; all_results: { run_no: number; outcome: string }[]; last_resolution_raw: string | null }) {
  const runs = rows.filter((r) => r.method === "submit_outcome").map((r) => ({
    run_no: Number(r.args.result?.run_no), outcome: String(r.args.result?.outcome), submit_tx: r.hash, by: r.by,
    in_all_results: bet.all_results.some((a) => a.run_no === Number(r.args.result?.run_no)),
    in_used_run_nos: bet.used_run_nos.includes(Number(r.args.result?.run_no)),
    log: r.logs.find((l) => l.startsWith("submit_outcome")) ?? null,
  }));
  let raw: any = {}; try { raw = bet.last_resolution_raw ? JSON.parse(bet.last_resolution_raw) : {}; } catch { /* keep {} */ }
  const contents: string[] = (raw.judge?.run_diagnostics ?? []).map((d: any) => String(d.content ?? ""));
  const auditFlag = contents.some((c) => /"audit"\s*:\s*"flag"/.test(c)) || (raw.notes ?? []).some((n: string) => /audit flag/i.test(n));
  return { runs, auditFlag, judge_ran: raw.judge?.judge_ran ?? null };
}

export function compareOutcome(chain: string, truth: Outcome): { match: boolean; wrongWinner: boolean } {
  const match = chain === truth;
  return { match, wrongWinner: !match && (chain === "YES" || chain === "NO") && (truth === "YES" || truth === "NO") };
}

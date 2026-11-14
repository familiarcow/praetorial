// Live (read-only) evidence collection: public NEAR RPC views + the escrow's tx history from a public tx indexer + FastFS download.
// No keys, no transactions.
import { createHash } from "node:crypto";
import { resolveRpcUrls } from "../../common/src/rpc.js";
import type { Evidence } from "./run.js";
import { extractParamsEvents, parseBigJson } from "./params.js";
import { successfulEscrowLogs } from "../../common/src/escrowEvents.js";
import { postJson, tsOf, fetchEscrowHistoryFrom, type LiveDeps } from "../../common/src/txHistoryCore.js";

async function rpc(network: string, method: string, params: unknown, d: LiveDeps = {}): Promise<any> {
  const { all } = resolveRpcUrls(network);
  let last = "";
  for (const url of all) {
    try {
      const j = await postJson(url, { jsonrpc: "2.0", id: "v", method, params }, d);
      if (j.error) { last = JSON.stringify(j.error).slice(0, 300); continue; }
      return j.result;
    } catch (e) { last = String(e); }
  }
  throw new Error(`rpc ${method} failed: ${last}`);
}

export async function view(network: string, account: string, method: string, args: unknown = {}, d: LiveDeps = {}): Promise<any> {
  const r = await rpc(network, "query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }, d);
  if (r.error) throw new Error(`view ${method}: ${r.error}`);
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

/** Raw view text (u64 ns kept as exact digit strings) -- PendingParams carries u64 timestamps. */
async function viewBig(network: string, account: string, method: string, args: unknown, d: LiveDeps): Promise<any> {
  const r = await rpc(network, "query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }, d);
  if (r.error) throw new Error(`view ${method}: ${r.error}`);
  return parseBigJson(Buffer.from(r.result).toString("utf8"));
}

export async function codeHash(network: string, account: string, d: LiveDeps = {}): Promise<string> {
  const r = await rpc(network, "query", { request_type: "view_account", finality: "final", account_id: account }, d);
  return Buffer.from(require58(r.code_hash)).toString("hex");
}

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function require58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  while (out.length < 32) out.unshift(0);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- tx history (V1c / D-VER2)
// Plain NEAR RPC cannot list an account's transactions, so history comes from the FastNEAR tx indexer
// (keyless, public): POST <idx>/v0/account {account_id, limit, resume_token} -> txs touching the account,
// POST <idx>/v0/transactions {tx_hashes[]} -> full tx + receipt tree (args, logs, status, block_timestamp).
// Same family as the default RPC host (tx.test.fastnear.com / tx.main.fastnear.com); override with NEAR_TX_INDEXER_URL.
export function indexerUrl(network: string): string {
  return (process.env.NEAR_TX_INDEXER_URL ?? "").trim() || (network === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com");
}

export type { LiveDeps };
const ok = (rc: any) => { const s = rc.execution_outcome?.outcome?.status ?? {}; return "SuccessValue" in s || "SuccessReceiptId" in s; };
const calls = (rc: any): { method: string; raw: string }[] =>
  (rc.receipt?.receipt?.Action?.actions ?? []).filter((a: any) => a.FunctionCall).map((a: any) => ({ method: a.FunctionCall.method_name, raw: Buffer.from(a.FunctionCall.args, "base64").toString("utf8") }));
const jsonOr = (s: string): any => { try { return JSON.parse(s); } catch { return undefined; } };

/** Fetch every function-call tx touching the escrow, return its receipts flattened (ordered by block time) with the tx hash. */
export const fetchEscrowHistory = (network: string, escrow: string, d: LiveDeps): Promise<{ hash: string; rc: any }[]> => fetchEscrowHistoryFrom(indexerUrl(network), escrow, d);

/** Map the escrow's receipts for one bet into the Evidence fields the offline checks already consume. */
export function mapHistory(escrow: string, betId: number, bet: any, pendingNotDone: number, hist: { hash: string; rc: any }[], ev: Evidence): string[] {
  const notes: string[] = [];
  const toEscrow = hist.filter((h) => h.rc.receipt?.receiver_id === escrow);
  const logsOf = (rc: any): string[] => rc.execution_outcome?.outcome?.logs ?? [];
  const deposits: bigint[] = [];

  // Open (B2 attestation, B5 deposit) and Take (B5 deposit): mt_on_transfer receipts that the escrow accepted.
  for (const { rc } of toEscrow) {
    if (!ok(rc)) continue;
    for (const c of calls(rc)) {
      if (c.method !== "mt_on_transfer") continue;
      const a = jsonOr(c.raw); const msg = a ? jsonOr(String(a.msg)) : undefined;
      if (!a || !msg) continue;
      const accepted = BigInt(a.amounts?.[0] ?? 0) - BigInt(jsonOr(Buffer.from(rc.execution_outcome.outcome.status.SuccessValue ?? "", "base64").toString())?.[0] ?? 0);
      if (msg.kind === "Open" && logsOf(rc).some((l) => l.startsWith(`open bet_id=${betId} `))) {
        const m = String(a.msg).match(/"attestation"\s*:\s*\{[^}]*?"checked_at"\s*:\s*(\d+)/);
        if (m && msg.attestation?.signature_hex) {
          ev.attestation = { specHash: msg.envelope.terms_hash, checkedAt: m[1], pubkeyHex: ev.pins.attest_pubkey, signatureHex: msg.attestation.signature_hex };
        }
        deposits.push(accepted);
      } else if (msg.kind === "Take" && Number(msg.bet_id) === betId && logsOf(rc).some((l) => l.startsWith(`take bet_id=${betId} `))) deposits.push(accepted);
    }
  }

  // submit_outcome calls that succeeded, in block order (B3). The signer is the pinned outcome_pubkey: the contract verified it on-chain.
  for (const { rc } of toEscrow) {
    if (!ok(rc)) continue;
    for (const c of calls(rc)) {
      if (c.method !== "submit_outcome") continue;
      const a = jsonOr(c.raw);
      if (a && Number(a.result?.bet_id) === betId) ev.submitted.push({ result: a.result, signatureHex: a.signature_hex, pubkeyHex: ev.pins.outcome_pubkey, tsNs: tsOf(rc).toString() });
    }
  }

  // L1b14 / D-RUNNO1: the run_no the escrow ASSIGNED to each request_resolution for this bet, read from the input_data it sent to
  // OutLayer in that call (also for runs that later produced no output: next_run_no stays advanced, so run_nos have gaps by design).
  const assigned: { runNo: number; tsNs: string }[] = [];
  for (const { rc } of hist) {
    if (rc.receipt?.predecessor_id !== escrow) continue;
    for (const c of calls(rc)) {
      if (c.method !== "request_execution") continue;
      const input = jsonOr(String(jsonOr(c.raw)?.input_data ?? ""));
      if (input && input.contract === escrow && Number(input.bet_id) === betId && Number.isInteger(input.run_no)) assigned.push({ runNo: input.run_no, tsNs: tsOf(rc).toString() });
    }
  }
  if (assigned.length > 0) ev.assignedRuns = assigned;
  else notes.push("B3: no request_resolution input_data carrying run_no found for this bet; run_no order checked as the strict sequence 1..n");

  // E2 (L1b14): the account may have been deleted and recreated under the same name. Only the deploy + new() AFTER the latest
  // CreateAccount belong to the contract that is live now; earlier ones belong to a deleted incarnation and are ignored.
  const hasAction = (rc: any, name: string) => (rc.receipt?.receipt?.Action?.actions ?? []).some((x: any) => x === name || (x && typeof x === "object" && name in x));
  const mine = hist.filter((h) => h.rc.receipt?.receiver_id === escrow && ok(h.rc));
  const created = mine.filter((h) => hasAction(h.rc, "CreateAccount")).map((h) => tsOf(h.rc)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).pop();
  const afterCreate = (rc: any) => created === undefined || tsOf(rc) >= created;
  let deployHash: string | undefined; let deployTs = -1n; let staleIgnored = 0;
  for (const { rc } of mine) {
    for (const x of rc.receipt?.receipt?.Action?.actions ?? []) {
      const code: string | undefined = x?.DeployContract?.code;
      if (code === undefined) continue;
      if (!afterCreate(rc)) { staleIgnored++; continue; }
      if (tsOf(rc) > deployTs) {
        deployTs = tsOf(rc);
        const b = Buffer.from(code, "base64"); // the indexer reports the 32-byte code hash; a full wasm is hashed here
        deployHash = b.length === 32 ? b.toString("hex") : createHash("sha256").update(b).digest("hex");
      }
    }
  }
  let newFound = false;
  for (const { rc } of mine) for (const c of calls(rc)) {
    if (c.method !== "new") continue;
    if (!afterCreate(rc)) { staleIgnored++; continue; }
    if (!newFound) { ev.newArgs = jsonOr(c.raw); newFound = true; }
  }
  ev.incarnation = { createdAtNs: created?.toString(), deployCodeHash: deployHash, newFound, staleIgnored };

  // finalize + payout transfers (B5, B6)
  const PAYOUT_CALLS = ["finalize", "drain_payouts", "void_after_deadline", "emergency_refund"];
  const payTxs = new Set<string>();
  let finalizeNs: bigint | undefined;
  for (const { hash, rc } of toEscrow) {
    if (!ok(rc)) continue;
    for (const c of calls(rc)) {
      const a = jsonOr(c.raw);
      if (!PAYOUT_CALLS.includes(c.method) || !a || Number(a.bet_id) !== betId) continue;
      payTxs.add(hash);
      if (c.method === "finalize" && finalizeNs === undefined) finalizeNs = tsOf(rc);
    }
  }
  if (finalizeNs !== undefined) ev.finalizeAtNs = finalizeNs.toString();
  if (payTxs.size > 0) {
    const paid: Record<string, bigint> = {};
    let failedTransfers = 0;
    for (const { hash, rc } of hist) {
      if (!payTxs.has(hash) || rc.receipt?.predecessor_id !== escrow) continue;
      for (const c of calls(rc)) {
        if (c.method !== "mt_transfer") continue;
        if (!ok(rc)) { failedTransfers++; continue; }
        const a = jsonOr(c.raw);
        paid[a.receiver_id] = (paid[a.receiver_id] ?? 0n) + BigInt(a.amount);
      }
    }
    const feeAcct: string | undefined = ev.newArgs?.fee_account;
    const roleOf = (acct: string) => (acct === bet.envelope.maker ? "maker" : acct === bet.taker ? "taker" : feeAcct === undefined || acct === feeAcct ? "fee" : "other");
    const after = { maker: 0n, taker: 0n, fee: 0n, other: 0n };
    for (const [acct, amt] of Object.entries(paid)) after[roleOf(acct) as keyof typeof after] += amt;
    const dep = deposits.reduce((x, y) => x + y, 0n);
    const total = Object.values(after).reduce((x, y) => x + y, 0n);
    if ((bet.bonds ?? []).length || (bet.objection_deposits ?? []).length) {
      ev.finalizeSkipReason = "bet has challenge bonds / objection deposits: their deposits and refunds are not mapped from receipts yet";
    } else {
      ev.finalize = {
        derived: "receipts",
        before: { balances: { maker: "0", taker: "0", fee: "0", escrow: dep.toString() } },
        after: {
          status: bet.status, outcome: bet.outcome,
          balances: { maker: after.maker.toString(), taker: after.taker.toString(), fee: after.fee.toString(), escrow: (dep - total).toString() },
          pending_not_done: pendingNotDone + failedTransfers + (after.other > 0n ? 1 : 0),
        },
      };
    }
  } else notes.push("no successful finalize/drain_payouts/void_after_deadline/emergency_refund call for this bet in the escrow's history");
  return notes;
}

/** Collect what public views AND the escrow's public tx history can prove. No keys, no transactions. */
export async function collectLive(network: string, escrow: string, betId?: number, deps: LiveDeps = {}): Promise<Evidence> {
  const keys: string[] = await view(network, escrow, "resolver_keys", {}, deps);
  const bet = betId !== undefined ? await view(network, escrow, "get_bet", { bet_id: betId }, deps) : undefined;
  // DOCSREV: get_bet answers null for an id that doesn't exist; say so instead of failing later on bet.envelope.
  if (betId !== undefined && bet == null) throw new Error(`bet ${betId} not found on ${escrow} (get_bet returned null)`);
  const ev: Evidence = {
    escrow, betId: betId ?? 0,
    pins: { outcome_pubkey: keys[0], attest_pubkey: keys[1], resolver_wasm_hash: keys[2] },
    outlayerConfig: await view(network, escrow, "outlayer_config", {}, deps),
    deployedCodeHash: await codeHash(network, escrow, deps),
    bet, submitted: [],
    isShutdown: await view(network, escrow, "is_shutdown", {}, deps).catch(() => undefined),
    proposedAtNs: bet?.proposed_at != null ? String(bet.proposed_at) : undefined,
    source: `live:${network}`,
  };
  await collectParams(network, escrow, ev, deps);
  if (betId === undefined || !bet) {
    if (ev.newArgs?.judge_chain) await collectGovernance(network, escrow, ev, await fetchEscrowHistory(network, escrow, deps), deps); // verify-escrow
    return ev;
  }
  if (typeof bet.envelope?.terms === "string") ev.termsRaw = bet.envelope.terms; // keep_terms: on-chain terms text (B1 re-hashes it)
  if (typeof bet.last_resolution_raw === "string") {
    const raw = jsonOr(bet.last_resolution_raw);
    if (raw?.judge) ev.judge = raw.judge; // B4 consumes the same record offline mode reads from raw_resolution.txt
  }
  const pending: any[] = await view(network, escrow, "pending_payouts", { bet_id: betId }, deps);
  const hist = await fetchEscrowHistory(network, escrow, deps);
  ev.historyNotes = mapHistory(escrow, betId, bet, pending.length, hist, ev);
  await collectGovernance(network, escrow, ev, hist, deps);
  return ev;
}

export async function fetchResolverWasm(ev: Evidence): Promise<Buffer | undefined> {
  const base = (ev.outlayerConfig as any)?.wasm_base_url;
  if (!base) return undefined;
  const r = await fetch(`${base}/${ev.pins.resolver_wasm_hash}.wasm`);
  if (!r.ok) return undefined;
  return Buffer.from(await r.arrayBuffer());
}

// ---------------------------------------------------------------- PA1b / D-PARAMS1 params replay inputs
/** Latest CreateAccount ns for the escrow + the first successful new() after it (the live incarnation), from tx history. */
function incarnation(escrow: string, hist: { hash: string; rc: any }[]): { createdAt?: bigint; newArgs?: Record<string, any> } {
  const mine = hist.filter((h) => h.rc.receipt?.receiver_id === escrow && ok(h.rc));
  const has = (rc: any, n: string) => (rc.receipt?.receipt?.Action?.actions ?? []).some((x: any) => x === n || (x && typeof x === "object" && n in x));
  const createdAt = mine.filter((h) => has(h.rc, "CreateAccount")).map((h) => tsOf(h.rc)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).pop();
  for (const { rc } of mine) for (const c of calls(rc)) if (c.method === "new" && (createdAt === undefined || tsOf(rc) >= createdAt)) return { createdAt, newArgs: jsonOr(c.raw) };
  return { createdAt };
}

const METHOD_MISSING = /MethodNotFound|MethodResolveError|method .*not found/i;

/** Reads protocol_fee_bps / asset_limit / pending_params and the params_* events from the escrow's own tx history (same indexer as B2/B3/B5/B6). */
async function collectParams(network: string, escrow: string, ev: Evidence, d: LiveDeps): Promise<void> {
  let fee: number;
  try { fee = await view(network, escrow, "protocol_fee_bps", {}, d); }
  catch (e) {
    const m = String(e instanceof Error ? e.message : e);
    if (METHOD_MISSING.test(m)) { ev.paramsSkip = "contract predates PA1 (no protocol_fee_bps view: MethodNotFound), so there are no adjustable params to replay"; return; }
    throw e; // any other failure is not "old contract": never silently skip
  }
  const hist = await fetchEscrowHistory(network, escrow, d);
  const inc = incarnation(escrow, hist);
  const newArgs = ev.newArgs ?? inc.newArgs;
  if (!newArgs) { ev.paramsSkip = "new() args not found in the escrow's tx history, cannot replay params"; return; }
  const asset_limit: Record<string, any> = {};
  for (const [id] of (newArgs.asset_limits ?? []) as [string, any][]) asset_limit[id] = await view(network, escrow, "asset_limit", { asset_id: id }, d);
  const pending_params = await viewBig(network, escrow, "pending_params", {}, d);
  const receipts = hist
    .filter((h) => h.rc.receipt?.receiver_id === escrow && (inc.createdAt === undefined || tsOf(h.rc) >= inc.createdAt))
    .map((h) => ({ tx_hash: h.hash, block_timestamp: tsOf(h.rc).toString(), ok: ok(h.rc), logs: (h.rc.execution_outcome?.outcome?.logs ?? []) as string[] }));
  if (ev.newArgs === undefined) ev.newArgs = newArgs; // verify-escrow (no bet): new() args still come from history
  ev.params = { views: { protocol_fee_bps: fee, asset_limit, pending_params }, events: extractParamsEvents(receipts) };
}

// ---------------------------------------------------------------- JC1y: governance replay inputs for E1
/**
 * Populates ev.governance for a post-JC1x contract (new() args carry judge_chain): the initial guardian + chain + asset ids from
 * new(), every log of the CURRENT incarnation's SUCCESSFUL escrow receipts (D-JCD1 #5: failed receipts' logs are never replayed),
 * and the live judge_chain view when readable. Pre-JC1x contracts (no judge_chain in new()) are left without governance.
 */
export async function collectGovernance(network: string, escrow: string, ev: Evidence, hist: { hash: string; rc: any }[], d: LiveDeps): Promise<void> {
  const na = ev.newArgs;
  if (!na?.judge_chain) return;
  const created = incarnation(escrow, hist).createdAt;
  const current = hist.filter((h) => created === undefined || tsOf(h.rc) >= created);
  const initial = { guardian: String(na.guardian), chain: na.judge_chain as { model_a: string; model_b: string }[], assets: ((na.asset_limits ?? []) as [string, any][]).map(([id]) => id) };
  const views: NonNullable<Evidence["governance"]>["views"] = {};
  try { views.chain = await view(network, escrow, "judge_chain", {}, d); }
  catch (e) { (ev.historyNotes ??= []).push(`E1: judge_chain view not readable (${String(e instanceof Error ? e.message : e).slice(0, 120)}); chain replayed from events only`); }
  ev.governance = { initial, logs: successfulEscrowLogs(escrow, current), ...(views.chain ? { views } : {}) };
}

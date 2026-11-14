// V1 (familiarcow 2026-11-11: "We should be able to verify the results of every action"): every bet action -> the on-chain
// transaction that did it. Pure; input = the escrow's receipts from the public tx indexer (txHistoryCore.fetchEscrowHistoryFrom),
// output = one BetTx per (transaction, bet). Host-neutral (no node:* / Buffer): used by the indexer Worker and node services.
// What a BetTx says is only what the receipts prove: the tx hash, who signed it, who acted (the user behind a relayer or the
// intents transfer), which escrow method ran, whether the escrow accepted it, and the exact token amounts that moved in/out.
// Mapping rules mirror services/verifier/src/live.ts mapHistory (accepted deposit = amount - refund; payouts = the escrow's
// mt_transfer receipts in the same tx).

export type BetTxKind =
  | "create" | "take" | "cancel" | "expire" | "reclaim" | "referee-change" | "request-result" | "ruling" | "challenge"
  | "objection" | "evidence" | "concede" | "referee-rule" | "finalize" | "payout" | "refund" | "amend" | "extend-window" | "prune";

export interface BetTxMove { account: string; token: string; amount: string }
export interface BetTx {
  bet_id: number;
  hash: string;
  /** Block timestamp of the escrow receipt (ns, exact digits). */
  at_ns: string;
  kind: BetTxKind;
  method: string;
  /** The transaction's signer (often the relayer or the keeper, paying gas for someone else). */
  signer: string;
  /** The account that acted: the transfer's sender, the AuthCall signer, or the receipt's predecessor (meta-tx user). */
  actor: string;
  /** The escrow accepted it (receipt succeeded; for a token transfer, not fully refunded). */
  ok: boolean;
  /** Into the escrow; `account` paid. token "near" = native NEAR (yocto). */
  moved_in: BetTxMove[];
  /** Out of the escrow in this tx (payouts, refunds, fees); `account` received. */
  moved_out: BetTxMove[];
  outcome?: string;
  run_no?: number;
  round?: number;
  /** submit_outcome: the exact signed result (JSON text as sent, u64 digits intact) and its signature. */
  signed?: { result_json: string; signature_hex: string };
  /** request-result: the program OutLayer was asked to run (its execution_requested event). */
  program?: { wasm_hash: string; url: string };
}

export interface HistEntry { hash: string; signer?: string; rc: any }

const METHOD_KIND: Record<string, BetTxKind> = {
  cancel: "cancel", expire: "expire", reclaim: "reclaim", request_resolution: "request-result", submit_outcome: "ruling",
  referee_rule: "referee-rule", amend_referee: "referee-change", submit_exhibits: "evidence", amend: "amend", prune_terms: "prune",
  extend_window: "extend-window", finalize: "finalize", void_after_deadline: "refund", emergency_refund: "refund",
  drain_payouts: "payout", retry_payout: "payout", concede: "concede",
};
const TRANSFER_KIND: Record<string, BetTxKind> = { Open: "create", Take: "take", Bond: "challenge", Objection: "objection" };
const AUTH_KIND: Record<string, BetTxKind> = { RequestResolution: "request-result", ExtendWindow: "extend-window" };
const OUT_METHODS = new Set(["mt_transfer", "mt_batch_transfer", "ft_transfer"]);

const b64 = (s: string): string => {
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch { return ""; }
};
const jsonOr = (s: string): any => { try { return JSON.parse(s); } catch { return undefined; } };
const statusOf = (rc: any): any => rc?.execution_outcome?.outcome?.status ?? {};
const okRc = (rc: any): boolean => { const s = statusOf(rc); return typeof s === "object" && s !== null && ("SuccessValue" in s || "SuccessReceiptId" in s); };
const logsOf = (rc: any): string[] => rc?.execution_outcome?.outcome?.logs ?? [];
const tsOf = (rc: any): string => String(rc?.execution_outcome?.block_timestamp ?? "0");
const calls = (rc: any): { method: string; raw: string; deposit: string }[] =>
  (rc?.receipt?.receipt?.Action?.actions ?? []).filter((a: any) => a && typeof a === "object" && a.FunctionCall)
    .map((a: any) => ({ method: String(a.FunctionCall.method_name), raw: b64(String(a.FunctionCall.args ?? "")), deposit: String(a.FunctionCall.deposit ?? "0") }));

/** bet id from a log line ("open bet_id=54 maker=…") or an escrow event ({"bet_id":54}). */
function betIdFromLogs(logs: string[]): number | undefined {
  for (const l of logs) {
    const m = l.match(/^[a-z_]+ bet_id=(\d+)\b/) ?? l.match(/"standard":"praetorial-escrow".*?"bet_id":(\d+)/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function programOf(logs: string[]): BetTx["program"] {
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:") || !l.includes("execution_requested")) continue;
    const j = jsonOr(l.slice("EVENT_JSON:".length));
    const rd = jsonOr(String(j?.data?.[0]?.request_data ?? ""));
    const w = rd?.code_source?.WasmUrl;
    if (w && typeof w.hash === "string" && typeof w.url === "string") return { wasm_hash: w.hash, url: w.url };
  }
  return undefined;
}

/** Index every bet action in the escrow's receipts. One BetTx per (tx, bet), in block order. */
export function indexBetTxs(escrow: string, hist: HistEntry[]): BetTx[] {
  const byTx = new Map<string, HistEntry[]>();
  for (const h of hist) { const l = byTx.get(h.hash) ?? []; l.push(h); byTx.set(h.hash, l); }
  const out: BetTx[] = [];
  for (const [hash, list] of byTx) {
    const rcs = [...list].sort((a, b) => (BigInt(tsOf(a.rc)) < BigInt(tsOf(b.rc)) ? -1 : BigInt(tsOf(a.rc)) > BigInt(tsOf(b.rc)) ? 1 : 0));
    const signer = String(list.find((h) => h.signer)?.signer ?? rcs[0]?.rc?.receipt?.receipt?.Action?.signer_id ?? "");
    const txLogs = rcs.flatMap((h) => logsOf(h.rc));
    const entries: BetTx[] = [];
    for (const { rc } of rcs) {
      if (rc?.receipt?.receiver_id !== escrow) continue;
      const pred = String(rc.receipt.predecessor_id ?? "");
      for (const c of calls(rc)) {
        const a = jsonOr(c.raw);
        const base = { hash, at_ns: tsOf(rc), method: c.method, signer, ok: okRc(rc), moved_in: [] as BetTxMove[], moved_out: [] as BetTxMove[] };
        if (c.method === "mt_on_transfer" || c.method === "ft_on_transfer") {
          const msg = a ? jsonOr(String(a.msg ?? "")) : undefined;
          const kind = msg ? TRANSFER_KIND[msg.kind] : undefined;
          if (!a || !kind) continue;
          const bet = kind === "create" ? betIdFromLogs(logsOf(rc)) : Number(msg.bet_id);
          if (bet === undefined || !Number.isInteger(bet)) continue;
          const tokens: string[] = a.token_ids ?? (a.token_id ? [a.token_id] : []);
          const amounts: string[] = a.amounts ?? (a.amount ? [a.amount] : []);
          const s = statusOf(rc);
          const refunds: unknown = typeof s.SuccessValue === "string" ? jsonOr(b64(s.SuccessValue)) : undefined;
          const moved_in: BetTxMove[] = [];
          tokens.forEach((t, i) => {
            const back = Array.isArray(refunds) ? BigInt(String(refunds[i] ?? "0")) : typeof refunds === "string" ? BigInt(refunds) : 0n;
            const got = BigInt(String(amounts[i] ?? "0")) - back;
            if (base.ok && got > 0n) moved_in.push({ account: String(a.sender_id), token: t, amount: got.toString() });
          });
          entries.push({ ...base, bet_id: bet, kind, actor: String(a.sender_id), ok: base.ok && moved_in.length > 0, moved_in, ...(kind === "challenge" && msg.round != null ? { round: Number(msg.round) } : {}) });
          continue;
        }
        if (c.method === "on_auth") {
          const msg = a ? jsonOr(String(a.msg ?? "")) : undefined;
          const k = msg ? Object.keys(msg)[0] : undefined;
          const kind = k ? AUTH_KIND[k] : undefined;
          const bet = kind ? Number(msg[k!]?.bet_id) : NaN;
          if (!kind || !Number.isInteger(bet)) continue;
          entries.push({ ...base, bet_id: bet, kind, actor: String(a.signer_id ?? pred) });
          continue;
        }
        const kind = METHOD_KIND[c.method];
        if (!kind || !a) continue;
        const bet = c.method === "submit_outcome" ? Number(a.result?.bet_id) : c.method === "retry_payout" ? betIdFromLogs(txLogs) : Number(a.bet_id);
        if (bet === undefined || !Number.isInteger(bet)) continue;
        const e: BetTx = { ...base, bet_id: bet, kind, actor: pred };
        if (c.deposit !== "0" && BigInt(c.deposit) > 0n && base.ok) e.moved_in.push({ account: pred, token: "near", amount: c.deposit });
        if (c.method === "submit_outcome") {
          e.outcome = String(a.result?.outcome ?? "");
          e.run_no = Number(a.result?.run_no);
          const m = c.raw.match(/"result"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*|\[[^\]]*\][^{}]*)*\})/);
          if (m && typeof a.signature_hex === "string") e.signed = { result_json: m[1], signature_hex: a.signature_hex };
        }
        if (c.method === "referee_rule") e.outcome = String(a.outcome ?? "");
        if (kind === "request-result") e.program = programOf(txLogs);
        entries.push(e);
      }
    }
    if (!entries.length) continue;
    // Tokens the escrow sent out in this tx (payouts, refunds, fees, the keeper's run cost) belong to its first bet action.
    const sink = entries[0];
    for (const { rc } of rcs) {
      if (rc?.receipt?.predecessor_id !== escrow || !okRc(rc)) continue;
      for (const c of calls(rc)) {
        if (!OUT_METHODS.has(c.method)) continue;
        const a = jsonOr(c.raw);
        if (!a) continue;
        if (c.method === "mt_batch_transfer") (a.token_ids ?? []).forEach((t: string, i: number) => sink.moved_out.push({ account: String(a.receiver_id), token: t, amount: String(a.amounts?.[i] ?? "0") }));
        else sink.moved_out.push({ account: String(a.receiver_id), token: String(a.token_id ?? rc.receipt.receiver_id), amount: String(a.amount ?? "0") });
      }
    }
    out.push(...entries);
  }
  return out.sort((x, y) => (BigInt(x.at_ns) < BigInt(y.at_ns) ? -1 : BigInt(x.at_ns) > BigInt(y.at_ns) ? 1 : 0));
}

/** One bet's actions, in block order. */
export function betTxsFor(all: BetTx[], betId: number): BetTx[] {
  return all.filter((t) => t.bet_id === betId);
}

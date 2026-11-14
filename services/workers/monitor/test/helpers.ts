// Shared fixtures for the CF1c monitor/notifier Worker tests (not a *.test.ts, so not collected).
import type { Bet } from "@praetorial/common/types.js";
export { fakeDoStorage } from "../../relayer/test/helpers.js";

export const ESC = "escrow.testnet";
export const INT = "intents.testnet";
export const USDC = "usdc.fakes.testnet";
export const RPC_URL = "https://test.rpc.fastnear.com";
export const RPC2_URL = "https://second.rpc.test";
export const NS = 1_000_000_000;
export const T0 = 1_700_000_000_000; // ms

export function mkBet(id: number, over: Partial<Bet> = {}, envOver: Record<string, unknown> = {}): Bet {
  return {
    envelope: {
      bet_id: id, version: 1, maker: `maker${id}.testnet`, taker_allow: { Any: {} }, terms_hash: `th${id}`,
      maker_asset: USDC, taker_asset: USDC, models_snapshot_hash: "m", outcomes: ["YES", "NO"], maker_side: "YES",
      stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "0", keep_terms: false, max_paid_runs: 1,
      tier: 1, arbiter: null, funding_deadline: 100, early_settle_outcome: null,
      finality_delay: 0, settlement_period: 10 * NS, resolve_deadline: 1000 * NS, consent_party_controlled: false, ...envOver,
    },
    storage_maker: "0", storage_taker: "0",
    status: "Taken", taker: `taker${id}.testnet`, created_at: id, taken_at: 1, proposed_at: null, outcome: null, used_run_nos: [], runs_used: 0, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [], objection_deposits: [], arbiter_submissions: [], amend_count: 0,
    pending_resolution_request: null, last_resolution_raw: null, pruned: false, next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
    ...over,
  } as Bet;
}

export interface World {
  bets: Map<number, Bet>; payouts: any[]; paused: boolean; shutdown: boolean; balances: Record<string, string>;
  account: { amount: string; storage_usage: number }; perByte: string; relayerBudget: unknown | null; accounts: Record<string, string>;
  telegram: { chat: string; text: string }[]; views: number[]; outbound: number; version: string;
  secondDown: boolean; secondDisagree: boolean; secondViews: number; rpcFail: boolean;
}
export function world(): World {
  return { bets: new Map(), payouts: [], paused: false, shutdown: false, balances: { [USDC]: "0" }, account: { amount: "100000000000000000000000000", storage_usage: 1000 },
    perByte: "10000000000000000000", relayerBudget: { capYocto: "1000", usedYocto: "10" }, accounts: {}, telegram: [], views: [], outbound: 0, version: "1.0.0",
    secondDown: false, secondDisagree: false, secondViews: 0, rpcFail: false };
}

/** The one chain brain: answers every view the monitor/notifier make. Node reference code and the Worker share it. */
export function callView(w: World, contract: string, method: string, args: any): unknown {
  if (w.rpcFail) throw new Error("rpc down");
  if (contract === ESC) {
    if (method === "get_bet") { w.views.push(args.bet_id); return w.bets.get(args.bet_id) ?? null; }
    if (method === "is_paused") return w.paused;
    if (method === "is_shutdown") { if (!w.shutdown) throw new Error("no such method"); return true; }
    if (method === "pending_payouts_view") { const from = Math.max(1, Number(args.from ?? 0)); return w.payouts.filter((p) => p.id >= from); } // honours `from` (MON1 scan cursor); no limit: fixtures use sparse ids (dense paging: monitor/test/stuckPayouts.test.ts)
    if (method === "contract_version") return w.version;
  }
  if (contract === INT && method === "mt_balance_of") return w.balances[args.token_id] ?? "0";
  throw new Error(`unmocked view ${contract}.${method}`);
}
export const viewClientOf = (w: World) => ({ async view<T>(c: string, m: string, a: any = {}): Promise<T> { return callView(w, c, m, a) as T; } });

export function outboundFetch(w: World) {
  return async (input: any, init?: any): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    w.outbound++;
    const text = String(init?.body ?? "");
    if (url.hostname === "api.telegram.org") { const b = JSON.parse(text); w.telegram.push({ chat: String(b.chat_id), text: b.text }); return Response.json({ ok: true }); }
    if (url.hostname === "relayer.test") { if (w.relayerBudget === null) return new Response("down", { status: 503 }); return Response.json(w.relayerBudget); }
    const second = url.hostname === "second.rpc.test";
    if (url.hostname !== "test.rpc.fastnear.com" && !second) throw new Error(`unexpected outbound ${url.hostname}`);
    const body: any = JSON.parse(text);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    const p = body.params;
    if (body.method === "query" && p.request_type === "call_function") {
      if (second) {
        w.secondViews++;
        if (w.secondDown) return new Response("down", { status: 500 });
        let r: any = callView(w, p.account_id, p.method_name, JSON.parse(atob(p.args_base64)));
        if (w.secondDisagree && r && p.method_name === "get_bet") r = { ...r, outcome: r.outcome === "YES" ? "NO" : "YES" };
        return ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(r))) });
      }
      try { return ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(callView(w, p.account_id, p.method_name, JSON.parse(atob(p.args_base64)))))) }); }
      catch (e: any) { return Response.json({ jsonrpc: "2.0", id: body.id, error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: String(e.message) } } }); }
    }
    if (body.method === "query" && p.request_type === "view_account") {
      const amt = w.accounts[p.account_id];
      if (amt !== undefined) return ok({ amount: amt, storage_usage: 100 });
      return ok(w.account);
    }
    if (body.method === "EXPERIMENTAL_protocol_config") return ok({ runtime_config: { storage_amount_per_byte: w.perByte } });
    throw new Error(`unmocked rpc ${body.method}`);
  };
}

export const norm = (a: any[]) => a.map((x) => ({ key: x.key, kind: x.kind, severity: x.severity, message: x.message, detail: x.detail })).sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
export const asyncJson = async (r: Response) => (await r.json()) as any;

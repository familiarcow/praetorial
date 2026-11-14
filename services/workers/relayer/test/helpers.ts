// Shared fixtures for the CF1b relayer Worker tests (not a *.test.ts, so not collected).
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as borsh from "borsh";
import { KeyPair } from "near-api-js";
import bs58 from "bs58";
import { SCHEMA, actionCreators, buildDelegateAction, encodeDelegateAction, Signature, SignedTransaction, createTransaction, encodeTransaction } from "@near-js/transactions";

export const ESCROW = "escrow3.praetorial-dev-1101.testnet";
export const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
export const USDC = "usdc.fakes.testnet";
export const EST = 5_000_000_000_000_000_000_000n;
export const RELAYER_KEY = KeyPair.fromRandom("ed25519") as any;
export const BLOCK_HASH = bs58.encode(new Uint8Array(32).fill(9));

export interface Built { base64: string; delegateAction: any; signature: any; keyPair: KeyPair }
export function buildDelegate(o: { senderId?: string; receiverId?: string; methodName?: string; args?: Record<string, unknown>; nonce?: bigint; maxBlockHeight?: bigint; signWith?: KeyPair; actions?: any[]; keyPair?: KeyPair }): Built {
  const keyPair = o.keyPair ?? KeyPair.fromRandom("ed25519");
  const delegateAction = buildDelegateAction({
    senderId: o.senderId ?? "zerobalance1.testnet", receiverId: o.receiverId ?? ESCROW,
    actions: o.actions ?? [actionCreators.functionCall(o.methodName ?? "cancel", o.args ?? { bet_id: 1 }, 30_000_000_000_000n, 0n)],
    nonce: o.nonce ?? 1n, maxBlockHeight: o.maxBlockHeight ?? 5000n, publicKey: keyPair.getPublicKey() as any,
  });
  const hash = createHash("sha256").update(Buffer.from(encodeDelegateAction(delegateAction))).digest();
  const sig = (o.signWith ?? keyPair).sign(hash);
  const signature = new Signature({ keyType: 0, data: sig.signature });
  return { base64: Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, { delegateAction, signature })).toString("base64"), delegateAction, signature, keyPair };
}

/** The bytes near-api-js would send for the relayer's outer NEP-366 wrapper tx. */
export function expectedOuterTx(b: Built, relayerId: string, nonce: bigint): Uint8Array {
  const tx = createTransaction(relayerId, RELAYER_KEY.getPublicKey() as any, b.delegateAction.senderId, nonce, [actionCreators.signedDelegate({ delegateAction: b.delegateAction, signature: b.signature })], bs58.decode(BLOCK_HASH));
  const hash = createHash("sha256").update(encodeTransaction(tx)).digest();
  return encodeTransaction(new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: RELAYER_KEY.sign(hash).signature }) }));
}

/** In-memory stand-in for a Durable Object's SQLite storage (node:sqlite behind the DO SQL API shape). */
export function fakeDoStorage(file = ":memory:") {
  const db = new DatabaseSync(file);
  // Eager like the real DO SQL API: the statement runs at exec() time, toArray() just returns the rows.
  const sql = {
    exec(q: string, ...b: unknown[]) {
      if (b.length === 0 && !/^\s*(select|pragma)/i.test(q)) { db.exec(q); return { toArray: () => [] as any[] }; }
      const st = db.prepare(q);
      const rows = /^\s*(select|pragma)/i.test(q) ? (st.all(...(b as any[])) as any[]) : (st.run(...(b as any[])), [] as any[]);
      return { toArray: () => rows };
    },
  };
  const transactionSync = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE;");
    try { const r = fn(); db.exec("COMMIT;"); return r; } catch (e) { try { db.exec("ROLLBACK;"); } catch { /* */ } throw e; }
  };
  return { ctx: { storage: { sql, transactionSync } }, close: () => db.close() };
}

export interface Rpc { heightFn: () => number; sent: string[]; nonce: number; indexerBettors: Set<string>; telegram: string[]; burnt: string;
  /** CF1b2: escrow bets served by get_bet (id -> bet), failure switches, and outbound counters. */
  bets: Map<number, { envelope: { maker: string }; taker: string | null }>; indexerDown: boolean; viewsFail: boolean; views: number; outbound: number;
  /** LIVE1: override the send_tx answer (a JSON-RPC result or error object); undefined = plain success. */
  sendTx?: (params?: any) => { result?: unknown; error?: unknown };
  /** SEC1/MON-2: `tx` lookups by hash (absent = UNKNOWN_TRANSACTION); every send_tx's signed bytes, accepted or not. */
  txs?: Map<string, unknown>; attempted?: string[];
  /** FUND2: accounts that do not exist on chain (view_account -> UNKNOWN_ACCOUNT); intents balances "account|token" -> units. */
  missing?: Set<string>; mt?: Map<string, string>;
  /** SEC1/MON-9: escrow asset_limit min_per_side per asset id (default "1"; "none" = the view answers null). */
  minStake?: Map<string, string> }
export function rpcWorld(height = 4000): Rpc { return { heightFn: () => height, sent: [], nonce: 100, indexerBettors: new Set(), telegram: [], burnt: "3000000000000000000000", bets: new Map(), indexerDown: false, viewsFail: false, views: 0, outbound: 0 }; }

/** fetch mock for every outbound call the relayer Worker makes. */
export function outboundFetch(w: Rpc) {
  return async (input: any, init?: any): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    w.outbound++;
    const text = init?.body ?? (typeof input === "object" && input.text ? await input.text() : "");
    if (url.hostname === "api.telegram.org") { w.telegram.push(JSON.parse(String(text)).text); return Response.json({ ok: true }); }
    if (url.hostname === "indexer.test") {
      if (w.indexerDown) return new Response("down", { status: 503 });
      const acct = url.searchParams.get("account") ?? "";
      return Response.json(w.indexerBettors.has(acct) ? [{ maker: acct, taker: null }] : []);
    }
    if (url.hostname !== "test.rpc.fastnear.com") throw new Error(`unexpected outbound ${url.hostname}`);
    const body: any = JSON.parse(String(text));
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "block") return ok({ header: { height: w.heightFn(), hash: BLOCK_HASH } });
    if (body.method === "query" && body.params.request_type === "view_access_key") return ok({ nonce: w.nonce, permission: "FullAccess" });
    if (body.method === "query" && body.params.request_type === "view_account") {
      if (w.missing?.has(body.params.account_id)) return Response.json({ jsonrpc: "2.0", id: body.id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: body.params.account_id } }, message: `account ${body.params.account_id} does not exist while viewing` } });
      return ok({ amount: "1000000000000000000000000", locked: "0", storage_usage: 182 });
    }
    if (body.method === "query" && body.params.request_type === "call_function" && body.params.method_name === "mt_balance_of") {
      const a = JSON.parse(atob(body.params.args_base64));
      return ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(w.mt?.get(`${a.account_id}|${a.token_id}`) ?? "0"))) });
    }
    if (body.method === "query" && body.params.request_type === "call_function" && body.params.method_name === "asset_limit") {
      const id = JSON.parse(atob(body.params.args_base64)).asset_id;
      const m = w.minStake?.get(id) ?? "1";
      return ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(m === "none" ? null : { min_per_side: m, max_per_side: "999999999999999999999999999999" }))) });
    }
    if (body.method === "query" && body.params.request_type === "call_function" && body.params.method_name === "get_bet") {
      w.views++;
      if (w.viewsFail) return new Response("rpc down", { status: 500 });
      const bet = w.bets.get(JSON.parse(atob(body.params.args_base64)).bet_id) ?? null;
      return ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(bet))) });
    }
    if (body.method === "query" && body.params.request_type === "call_function") return ok({ result: Array.from(new TextEncoder().encode("null")) });
    if (body.method === "send_tx") (w.attempted ??= []).push(body.params.signed_tx_base64);
    if (body.method === "tx") {
      const r = w.txs?.get(body.params.tx_hash);
      if (r === undefined) return Response.json({ jsonrpc: "2.0", id: body.id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} }, message: "Transaction doesn't exist" } });
      return ok(r);
    }
    if (body.method === "send_tx" && w.sendTx) {
      const r = w.sendTx(body.params);
      if (r.error) return Response.json({ jsonrpc: "2.0", id: body.id, error: r.error });
      w.sent.push(body.params.signed_tx_base64); w.nonce++;
      return ok(r.result);
    }
    if (body.method === "send_tx") {
      w.sent.push(body.params.signed_tx_base64); w.nonce++;
      return ok({ status: { SuccessValue: "" }, transaction: { hash: "WORKERTXHASH" }, transaction_outcome: { outcome: { tokens_burnt: w.burnt } }, receipts_outcome: [] });
    }
    throw new Error(`unmocked rpc ${body.method}`);
  };
}

export const RELAYER_ID = "relayer.testnet";
export const workerBindings = (extra: Record<string, string> = {}): Record<string, string> => ({
  NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESCROW, INTENTS_CONTRACT_ID: INTENTS, USDC_TOKEN_ID: USDC,
  RELAYER_ACCOUNT_ID: RELAYER_ID, RELAYER_PRIVATE_KEY: RELAYER_KEY.toString(), RELAYER_RPC_PER_SEC: "100000",
  RELAYER_MAX_TRANSFER_AMOUNT: "1000000000", RELAYER_MAX_BLOCK_HEIGHT_FUTURE: "1200", RELAYER_PER_CALL_SPONSORSHIP_YOCTO: EST.toString(),
  RELAYER_MAX_REQUESTS_PER_WINDOW: "20", RELAYER_WINDOW_MS: "60000", RELAYER_DAILY_BUDGET_YOCTO: "100000000000000000000000",
  INDEXER_URL: "https://indexer.test", ...extra,
});

/** A node-side config equal to workerBindings, for parity runs against the node Relayer. */
export const nodeConfig = (over: Record<string, any> = {}) => ({
  escrowContract: ESCROW, intentsContract: INTENTS, usdcTokenId: USDC, maxTransferAmount: 1_000_000_000n, maxBlockHeightFuture: 1200n,
  perCallSponsorshipYocto: EST, maxRequestsPerWindow: 20, windowMs: 60_000, dailyBudgetYocto: 100_000_000_000_000_000_000_000n, ...over,
});

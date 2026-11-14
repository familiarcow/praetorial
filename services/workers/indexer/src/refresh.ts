// IDX2: POST /refresh {"bet_id": N[, "contract_id": served id]} -- the web's nudge right after a successful Open or Take, so the
// board shows the change in seconds instead of after the next minute sweep (tickBets).
//  * The caller only NAMES a bet. Everything stored comes from the chain: bet_count() bounds the id (<= bet_count + 1: a lagging
//    RPC may not count the brand-new bet yet), get_bet(N) is the bet (absent -> 404, nothing written). Any bet data in the body is ignored.
//  * Merge = the tick's own code (merge.ts mergeReads + upsertStmts): terminal lock / sameBet identity, unchanged re-read = no write,
//    D-DSY1 second-RPC confirmation for a terminal state (unconfirmed -> "settling, confirming", no winner served).
//  * Never takes the tick lease (indexer_lock) and never writes the tick's sweep state; concurrent writes are made safe in SQL
//    (merge.ts: a row is only replaced by a read that started later, and a terminal row never by a non-terminal read).
//  * Configured escrow only (loadServedContracts). Limits: REFRESH_IP_PER_MIN per client address + REFRESH_GLOBAL_PER_MIN overall,
//    fixed one-minute D1 windows (sourcecheck's limiter shape: count, refuse at the cap, retry-after). CORS: the web origin(s) only.
import type { Bet } from "@praetorial/common/types.js";
import { countingFetch, str } from "../../common/src/tickKit.js";
import { loadIndexerConfig, loadServedContracts, type D1Like, type IndexerEnv } from "./env.js";
import { COLS, toTagged, mergeReads, upsertStmts, chainClients, type Row } from "./merge.js";

export const REFRESH_IP_PER_MIN = 30;
/** Every accepted refresh costs ~2-3 RPC views (bet_count, get_bet, maybe one second-RPC confirmation). */
export const REFRESH_GLOBAL_PER_MIN = 300;
const MAX_BODY = 1024;
const MINUTE_MS = 60_000;

/** The web app's origins per network (same lists as the sourcecheck/funding Workers' *_ALLOWED_ORIGINS). Requests through the web
 * Worker's /_proxy/indexer carry no Origin (same-origin for the browser) and are allowed like any non-browser caller. */
export const REFRESH_ORIGINS: Record<"testnet" | "mainnet", readonly string[]> = {
  testnet: ["https://praetorial-web-testnet.familiarcow.workers.dev", "http://localhost:3000", "http://localhost:5173"],
  // DOM1: apex + www, then the old workers.dev web origin (TODO-REMOVE after the praetorial.com cutover is confirmed).
  mainnet: ["https://praetorial.com", "https://www.praetorial.com", "https://praetorial-web-mainnet.familiarcow.workers.dev"], // TODO-REMOVE last entry
};

export type RefreshLimit = { ok: true } | { ok: false; scope: "ip" | "global"; retryAfterS: number };

/** Counts one refresh against the address, then the global minute. A per-address refusal consumes nothing (an abuser cannot eat the
 * global budget with refused calls). Atomic per counter: a conditional UPSERT that does not apply at the cap (changes = 0). */
export async function consumeRefresh(db: D1Like, ip: string, nowMs: number, perIp = REFRESH_IP_PER_MIN, global = REFRESH_GLOBAL_PER_MIN): Promise<RefreshLimit> {
  const bucket = Math.floor(nowMs / MINUTE_MS);
  const retryAfterS = Math.max(1, Math.ceil(((bucket + 1) * MINUTE_MS - nowMs) / 1000));
  const bump = (k: string, cap: number) => db.prepare("INSERT INTO indexer_refresh_limit (k, bucket, count) VALUES (?, ?, 1) ON CONFLICT(k) DO UPDATE SET count = CASE WHEN indexer_refresh_limit.bucket = excluded.bucket THEN indexer_refresh_limit.count + 1 ELSE 1 END, bucket = excluded.bucket WHERE indexer_refresh_limit.bucket <> excluded.bucket OR indexer_refresh_limit.count < ?").bind(k, bucket, cap);
  if (((await bump(`ip:${ip}`, perIp).run()).meta?.changes ?? 0) !== 1) return { ok: false, scope: "ip", retryAfterS };
  const [g] = await db.batch([bump("global", global), db.prepare("DELETE FROM indexer_refresh_limit WHERE bucket < ?").bind(bucket)]) as { meta?: { changes?: number } }[];
  if ((g?.meta?.changes ?? 0) !== 1) return { ok: false, scope: "global", retryAfterS };
  return { ok: true };
}

export async function handleRefresh(req: Request, env: IndexerEnv, db: D1Like, clock: () => number): Promise<Response> {
  const net = (str(env.NEAR_NETWORK_ID) ?? str(env.NEAR_NETWORK)) === "mainnet" ? "mainnet" : "testnet";
  const origin = req.headers.get("origin");
  const originOk = origin !== null && REFRESH_ORIGINS[net].includes(origin.replace(/\/+$/, ""));
  const cors: Record<string, string> = originOk ? { "access-control-allow-origin": origin!, vary: "Origin" } : { vary: "Origin" };
  const json = (status: number, v: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...cors, ...extra } });
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}, h: Record<string, string> = {}) => json(status, { ok: false, error, ...extra }, h);

  if (origin !== null && !originOk) return new Response(JSON.stringify({ ok: false, error: "origin not allowed" }), { status: 403, headers: { "content-type": "application/json", vary: "Origin" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" } });
  if (req.method !== "POST") return fail(405, "method not allowed", {}, { allow: "POST, OPTIONS" });

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return fail(413, "request too large");
  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "request too large");
  let b: any;
  try { b = JSON.parse(raw); } catch { return fail(400, 'request body must be JSON {"bet_id": N}'); }
  if (!b || typeof b !== "object" || Array.isArray(b)) return fail(400, 'request body must be JSON {"bet_id": N}');
  const betId = b.bet_id;
  if (typeof betId !== "number" || !Number.isSafeInteger(betId) || betId < 1) return fail(400, "bet_id must be a positive integer");
  const served = loadServedContracts(env).map((c) => c.id);
  const contractId = b.contract_id === undefined ? served[0]! : b.contract_id;
  if (typeof contractId !== "string" || !served.includes(contractId)) return fail(400, "contract_id is not the escrow this indexer serves");
  // the edge's address for a direct call (cannot be forged); the web proxy's x-client-ip only when there is none (service binding)
  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-client-ip") ?? "").trim();
  if (!ip) return fail(400, "client address unavailable (fail closed)");

  const lim = await consumeRefresh(db, ip, clock());
  if (!lim.ok) {
    const error = lim.scope === "global" ? `refresh cap reached (${REFRESH_GLOBAL_PER_MIN}/min); the board updates within a minute anyway` : `rate limit: ${REFRESH_IP_PER_MIN} refreshes per minute per address`;
    return fail(429, error, { scope: lim.scope }, { "retry-after": String(lim.retryAfterS), "access-control-expose-headers": "retry-after" });
  }

  const cfg = loadIndexerConfig(env);
  const cf = countingFetch();
  const { client, second } = chainClients(cfg, cf.fetch);
  const contract = cfg.contracts.find((c) => c.id === contractId)!;
  const readMs = clock(); // the read starts now: the row is stamped with it (merge.ts read_ms guard)
  let bet: Bet | null;
  try {
    const count = Number(await client.view<number | string>(contractId, "bet_count", {}));
    if (!Number.isFinite(count)) throw new Error("bet_count unreadable");
    if (betId > count + 1) return fail(400, `bet_id out of range (bet_count ${count})`);
    bet = await client.view<Bet | null>(contractId, "get_bet", { bet_id: betId });
  } catch (err: any) {
    console.error(`indexer refresh: ${contractId}:${betId} unreadable: ${String(err?.message ?? err)}`);
    return fail(502, "chain unreadable; the board updates within a minute anyway");
  }
  if (!bet) return fail(404, "no such bet");

  const key = `${contractId}:${betId}`;
  const r = await db.prepare(`SELECT ${COLS} FROM indexer_bets WHERE key = ?`).bind(key).first<Row>();
  const prev = new Map(r ? [[key, toTagged(r)] as const] : []);
  const fresh = new Map([[key, { betId, bet, contractId, version: contract.version }] as const]);
  // no alert raiser: the next tick re-reads every unconfirmed terminal (its backlog) and raises the D-DSY1 alerts with its cooldowns
  const { bets, dirty } = await mergeReads(prev, fresh, { second, maxConfirms: Math.min(1, cfg.maxConfirms) });
  const ordOf = new Map(cfg.contracts.map((c, i) => [c.id, i] as const));
  // written = the guarded upsert applied (a newer row from a concurrent tick, or a terminal one, makes it a no-op)
  const res = dirty.size ? await db.batch(upsertStmts(db, [...dirty], bets, ordOf, readMs)) as { meta?: { changes?: number } }[] : [];
  return json(200, { ok: true, bet_id: betId, contract_id: contractId, written: res.some((x) => (x?.meta?.changes ?? 0) > 0) });
}

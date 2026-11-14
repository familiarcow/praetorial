// Registry Worker (CF1f, D-REGW1, D-HOST3): the node registry (services/registry) as a Cloudflare Worker with D1 storage.
// Same routes (POST /claim, GET /search, /lookup/account/:id, /lookup/username/:name, /health), same JSON bodies/status codes/CORS, built on the
// SAME host-neutral core (registry/src/core.ts: claim/search/lookup/rate rules, NEP-413 digest, full-access-key check). Differences are only the host:
// ed25519 via WebCrypto, storage via D1 (UNIQUE folded username / account_id / nonce let the DB enforce what the node server did in memory), the
// per-IP token bucket in D1. A read of `now` and the RPC client are injectable for tests.
import { HttpErr, DEFAULT_MAX_BODY_BYTES, NONCE_MAX_AGE_MS, NONCE_MAX_SKEW_MS, parseClaim, verifyClaimSignature, requireFullAccessKey, searchUsers, searchFold, lookupFold, foldOf, bucketStep, isRateLimitedRoute, corsAllowed, decodeParam, type Bucket } from "../../../registry/src/core.js";
import { createRpcClient, type RegistryRpc } from "../../../registry/src/rpc.js";
import { healthBody } from "../../common/src/health.js";
import { DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";

export interface D1Stmt { bind(...a: unknown[]): D1Stmt; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<{ results: T[] }>; run(): Promise<unknown> }
export interface D1Like { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> }
export interface RegistryEnv { REGISTRY_DB?: D1Like; [name: string]: unknown }
export interface Deps { rpc?: RegistryRpc; now?: () => number }

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown, d: number): number => { const n = Number(str(v)); return str(v) !== undefined && Number.isFinite(n) ? n : d; };
const verifyEd25519 = async (digest: Uint8Array, sig: Uint8Array, pk: Uint8Array): Promise<boolean> => {
  try { const key = await crypto.subtle.importKey("raw", pk as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]); return await crypto.subtle.verify("Ed25519", key, sig as Uint8Array<ArrayBuffer>, digest as Uint8Array<ArrayBuffer>); } catch { return false; }
};

interface UserRow { username: string; account_id: string; discoverable: number }
const REGEX_LIKE_CAP = 500;

export async function handle(req: Request, env: RegistryEnv, deps: Deps = {}): Promise<Response> {
  const now = deps.now ?? Date.now;
  const registryId = str(env.REGISTRY_ID), db = env.REGISTRY_DB;
  const origin = req.headers.get("origin");
  const corsOrigins = (str(env.REGISTRY_CORS_ORIGINS) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = corsAllowed(origin, corsOrigins);
  const headers = (extra: Record<string, string> = {}): Headers => {
    const h = new Headers({ "content-type": "application/json", ...extra });
    if (allowed) { h.set("access-control-allow-origin", origin!); h.set("vary", "origin"); }
    return h;
  };
  const send = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: headers(extra) });
  try {
    if (!registryId || !db) { console.error("registry: misconfigured (REGISTRY_ID and the REGISTRY_DB D1 binding are required)"); return send(500, { error: "misconfigured" }); }
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      const h = new Headers(); if (allowed) { h.set("access-control-allow-origin", origin!); h.set("vary", "origin"); h.set("access-control-allow-methods", "GET, POST, OPTIONS"); h.set("access-control-allow-headers", "content-type"); h.set("access-control-max-age", "600"); }
      return new Response(null, { status: 204, headers: h });
    }
    if (isRateLimitedRoute(req.method, url.pathname)) {
      const xff = req.headers.get("x-forwarded-for");
      const ip = env.REGISTRY_TRUST_PROXY === "1" && xff ? xff.split(",")[0].trim() : req.headers.get("cf-connecting-ip") ?? "unknown";
      const rate = { capacity: num(env.REGISTRY_RATE_CAPACITY, 20), refillPerSec: num(env.REGISTRY_RATE_REFILL_PER_SEC, 0.5) };
      const prev = await db.prepare("SELECT tokens, at FROM rate WHERE ip = ?").bind(ip).first<Bucket>();
      const { bucket, retryAfter } = bucketStep(prev ?? undefined, now(), rate);
      await db.prepare("INSERT INTO rate (ip, tokens, at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET tokens = excluded.tokens, at = excluded.at").bind(ip, bucket.tokens, bucket.at).run();
      if (retryAfter !== null) return send(429, { error: "rate_limited" }, { "retry-after": String(retryAfter) });
    }
    if (req.method === "POST" && url.pathname === "/claim") {
      const maxBody = num(env.REGISTRY_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
      if (Number(req.headers.get("content-length") ?? 0) > maxBody) throw new HttpErr(413, "body_too_large");
      const raw = await req.text();
      if (new TextEncoder().encode(raw).length > maxBody) throw new HttpErr(413, "body_too_large");
      return send(200, await claim(db, registryId, raw, now(), deps.rpc ?? createRpcClient(str(env.NEAR_RPC_URL) ?? DEFAULT_TESTNET_RPC_URL)));
    }
    if (req.method === "GET" && url.pathname === "/search") {
      const q = searchFold(url.searchParams.get("q") ?? "");
      if (!q) return send(200, []);
      const { results } = await db.prepare("SELECT username, account_id, discoverable FROM users WHERE discoverable = 1 AND instr(folded, ?) > 0 LIMIT ?").bind(q, REGEX_LIKE_CAP).all<UserRow>();
      return send(200, searchUsers(results.map((r) => ({ username: r.username, account_id: r.account_id, discoverable: r.discoverable === 1 })), q));
    }
    const um = req.method === "GET" && url.pathname.match(/^\/lookup\/username\/?(.*)$/);
    if (um) {
      const f = lookupFold(decodeParam(um[1]));
      const u = f === null ? null : await db.prepare("SELECT username, account_id FROM users WHERE folded = ?").bind(f).first<UserRow>();
      return u ? send(200, { username: u.username, account_id: u.account_id }) : send(404, { error: "not_found" });
    }
    const m = req.method === "GET" && url.pathname.match(/^\/lookup\/account\/(.+)$/);
    if (m) {
      const u = await db.prepare("SELECT username FROM users WHERE account_id = ?").bind(decodeParam(m[1])).first<UserRow>();
      return u ? send(200, { username: u.username }) : send(404, { error: "not_found" });
    }
    if (req.method === "GET" && url.pathname === "/health") return send(200, healthBody("registry", env, { registryId })); // STACK1 (ok:true kept for existing callers)
    return send(404, { error: "not_found" });
  } catch (e) {
    if (e instanceof HttpErr) return send(e.status, { error: e.code });
    console.error("registry: internal error", (e as Error).message);
    return send(500, { error: "internal" });
  }
}

async function claim(db: D1Like, registryId: string, raw: string, t: number, rpc: RegistryRpc) {
  const c = parseClaim(raw, t);
  await verifyClaimSignature(c, registryId, verifyEd25519);
  await requireFullAccessKey(c, (id) => rpc.viewAccessKeyList(id), rpc.accountExists ? (id) => rpc.accountExists!(id) : undefined);
  // One atomic D1 batch: prune stale nonces/buckets, burn the nonce (PK: replay), drop this account's old row (rename), insert the new one (UNIQUE folded:
  // taken). Any constraint failure rolls the whole batch back, so a failed claim never burns the nonce (same as the node store).
  try {
    await db.batch([
      db.prepare("DELETE FROM nonces WHERE ts < ?").bind(t - NONCE_MAX_AGE_MS - NONCE_MAX_SKEW_MS),
      db.prepare("DELETE FROM rate WHERE at < ?").bind(t - 86_400_000),
      db.prepare("INSERT INTO nonces (nonce, ts) VALUES (?, ?)").bind(c.nonceKey, c.ts),
      db.prepare("DELETE FROM users WHERE account_id = ?").bind(c.accountId),
      db.prepare("INSERT INTO users (username, folded, account_id, public_key, discoverable, claimed_at) VALUES (?, ?, ?, ?, ?, ?)").bind(c.username, foldOf(c.username), c.accountId, c.publicKey, c.discoverable ? 1 : 0, t),
    ]);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/nonces\.nonce/.test(msg)) throw new HttpErr(409, "nonce_replay");
    if (/users\.folded|users\.account_id/.test(msg)) throw new HttpErr(409, "username_taken");
    throw e;
  }
  return { username: c.username, account_id: c.accountId };
}

export default { fetch: (req: Request, env: RegistryEnv): Promise<Response> => handle(req, env) };

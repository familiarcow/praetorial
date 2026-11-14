// Username registry: NEP-413 claim (proves control of a full-access key at claim time), search, lookup.
import http from "node:http";
import { URL } from "node:url";
import nacl from "tweetnacl";
import { HttpErr, NONCE_MAX_AGE_MS, NONCE_MAX_SKEW_MS, DEFAULT_MAX_BODY_BYTES, parseClaim, verifyClaimSignature, requireFullAccessKey, searchUsers, lookupFold, foldOf, bucketStep, isRateLimitedRoute, corsAllowed, type Bucket } from "./core.js";
import { JsonFileStore, MemoryStore, type RegistryStore } from "./store.js";
import { createRpcClient, type RegistryRpc } from "./rpc.js";
import { loadRegistryConfig } from "./config.js";

export interface RegistryServerOpts {
  registryId: string; store: RegistryStore; rpc: RegistryRpc; corsOrigins: string[];
  rate: { capacity: number; refillPerSec: number }; maxBodyBytes?: number; trustProxy?: boolean; now?: () => number;
}

export function createRegistryServer(o: RegistryServerOpts): http.Server {
  const now = o.now ?? Date.now;
  const maxBody = o.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const buckets = new Map<string, Bucket>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  function limit(ip: string): number | null { // returns retry-after seconds when limited
    const { bucket, retryAfter } = bucketStep(buckets.get(ip), now(), o.rate);
    buckets.set(ip, bucket);
    return retryAfter;
  }
  function clientIp(req: http.IncomingMessage): string {
    if (o.trustProxy) { const x = req.headers["x-forwarded-for"]; if (typeof x === "string" && x) return x.split(",")[0].trim(); }
    return req.socket.remoteAddress ?? "unknown";
  }
  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > maxBody) { reject(new HttpErr(413, "body_too_large")); return; }
      let size = 0; const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => { size += c.length; if (size > maxBody) { reject(new HttpErr(413, "body_too_large")); req.destroy(); return; } chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function claim(raw: string) {
    const t = now();
    const c = parseClaim(raw, t);
    await verifyClaimSignature(c, o.registryId, (d, sig, pk) => nacl.sign.detached.verify(d, sig, pk));
    await requireFullAccessKey(c, (id) => o.rpc.viewAccessKeyList(id), o.rpc.accountExists ? (id) => o.rpc.accountExists!(id) : undefined);
    return serial(async () => {
      const st = await o.store.read();
      for (const [n, at] of Object.entries(st.nonces)) if (at < t - NONCE_MAX_AGE_MS - NONCE_MAX_SKEW_MS) delete st.nonces[n];
      if (st.nonces[c.nonceKey] !== undefined) throw new HttpErr(409, "nonce_replay");
      const f = foldOf(c.username);
      for (const u of Object.values(st.users)) if (u.account_id !== c.accountId && foldOf(u.username) === f) throw new HttpErr(409, "username_taken");
      st.nonces[c.nonceKey] = c.ts;
      st.users[c.accountId] = { username: c.username, account_id: c.accountId, public_key: c.publicKey, discoverable: c.discoverable, claimed_at: t };
      await o.store.write(st);
      return { username: c.username, account_id: c.accountId };
    });
  }

  async function search(qRaw: string) { return searchUsers(Object.values((await o.store.read()).users), qRaw); }

  async function lookupUsername(raw: string) {
    const f = lookupFold(raw);
    if (f === null) return null;
    return Object.values((await o.store.read()).users).find((u) => foldOf(u.username) === f) ?? null;
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = corsAllowed(origin, o.corsOrigins);
    if (allowed) { res.setHeader("access-control-allow-origin", origin!); res.setHeader("vary", "origin"); }
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.statusCode = status; res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "OPTIONS") {
        if (allowed) { res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS"); res.setHeader("access-control-allow-headers", "content-type"); res.setHeader("access-control-max-age", "600"); }
        res.statusCode = 204; res.end(); return;
      }
      const limited = isRateLimitedRoute(req.method ?? "", url.pathname);
      if (limited) {
        const ra = limit(clientIp(req));
        if (ra !== null) { send(429, { error: "rate_limited" }, { "retry-after": String(ra) }); req.resume(); return; }
      }
      if (req.method === "POST" && url.pathname === "/claim") { send(200, await claim(await readBody(req))); return; }
      if (req.method === "GET" && url.pathname === "/search") { send(200, await search(url.searchParams.get("q") ?? "")); return; }
      const um = req.method === "GET" && url.pathname.match(/^\/lookup\/username\/?(.*)$/);
      if (um) {
        let name = "";
        try { name = decodeURIComponent(um[1]); } catch { /* not_found */ }
        const u = await lookupUsername(name);
        if (!u) { send(404, { error: "not_found" }); return; }
        send(200, { username: u.username, account_id: u.account_id }); return;
      }
      const m = req.method === "GET" && url.pathname.match(/^\/lookup\/account\/(.+)$/);
      if (m) {
        const st = await o.store.read();
        const u = st.users[decodeURIComponent(m[1])];
        if (!u) { send(404, { error: "not_found" }); return; }
        send(200, { username: u.username }); return;
      }
      if (req.method === "GET" && url.pathname === "/health") { send(200, { ok: true }); return; }
      send(404, { error: "not_found" });
    } catch (e) {
      if (e instanceof HttpErr) { send(e.status, { error: e.code }); if (e.status === 413) req.destroy(); return; }
      console.error("registry: internal error", (e as Error).message);
      send(500, { error: "internal" });
    }
  });
}

export async function main(): Promise<void> {
  const cfg = loadRegistryConfig();
  const store = cfg.storePath ? new JsonFileStore(cfg.storePath) : new MemoryStore();
  if (!cfg.storePath) console.error("registry: REGISTRY_STORE_PATH unset: using in-memory store (data lost on restart)");
  const server = createRegistryServer({ registryId: cfg.registryId, store, rpc: createRpcClient(cfg.rpcUrl), corsOrigins: cfg.corsOrigins, rate: cfg.rate, trustProxy: cfg.trustProxy });
  server.listen(cfg.port, () => console.error(`registry listening on :${cfg.port}`));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });

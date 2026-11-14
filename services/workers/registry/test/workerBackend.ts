// CF1f parity harness (not a *.test.ts): the Worker `handle` over fakeD1 (node:sqlite, D1 API) behind a node http server, so the
// node registry suites (registry/test/*.test.ts) run UNCHANGED against the Worker (REGISTRY_BACKEND=worker, see registry/test/helpers.ts).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeD1 } from "../../indexer/test/helpers.js";
import { handle } from "../src/index.js";
import type { RegistryRpc } from "../../../registry/src/rpc.js";
import type { RegistryServerOpts } from "../../../registry/src/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const registryMigrationSql = (): string => fs.readFileSync(path.join(HERE, "../migrations/0001_init.sql"), "utf8");

export async function startWorkerBackend(over: Partial<RegistryServerOpts>, rpc: RegistryRpc, registryId: string) {
  const f = fakeD1(":memory:", false);
  await f.d1.exec(registryMigrationSql());
  const rate = over.rate ?? { capacity: 1000, refillPerSec: 1000 };
  const env: Record<string, unknown> = {
    REGISTRY_DB: f.d1, REGISTRY_ID: registryId, REGISTRY_CORS_ORIGINS: (over.corsOrigins ?? ["https://app.example"]).join(","),
    REGISTRY_RATE_CAPACITY: String(rate.capacity), REGISTRY_RATE_REFILL_PER_SEC: String(rate.refillPerSec), REGISTRY_TRUST_PROXY: over.trustProxy ? "1" : "0",
  };
  const log = process.env.REGISTRY_BACKEND_LOG;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    headers.set("cf-connecting-ip", req.socket.remoteAddress ?? "unknown");
    const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
    const r = await handle(new Request("http://registry.test" + req.url, { method: req.method, headers, body }), env as any, { now: over.now, rpc });
    if (log) fs.appendFileSync(log, `${req.method} ${req.url}\n`);
    res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  type Res = Omit<Response, "json"> & { json(): Promise<any> };
  const post = (p: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = (p: string, headers: Record<string, string> = {}): Promise<Res> => fetch(base + p, { headers });
  // node-store-shaped view of D1 for suites that peek at state (t.store.read())
  const store = { async read() {
    const users: Record<string, any> = {}; const nonces: Record<string, number> = {};
    for (const u of (await f.d1.prepare("SELECT username, account_id, public_key, discoverable, claimed_at FROM users").all()).results as any[]) users[u.account_id] = { ...u, discoverable: u.discoverable === 1 };
    for (const n of (await f.d1.prepare("SELECT nonce, ts FROM nonces").all()).results as any[]) nonces[n.nonce] = n.ts;
    return { users, nonces };
  } };
  return { server, store: store as any, base, post, get, backend: "worker" as const, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => { f.close(); r(); }); }) };
}

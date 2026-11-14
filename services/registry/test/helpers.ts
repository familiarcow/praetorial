import nacl from "tweetnacl";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { hashNep413 } from "@praetorial/common/nep413.js";
import { createRegistryServer, type RegistryServerOpts } from "../src/server.js";
import { MemoryStore } from "../src/store.js";
import type { AccessKeyInfo, RegistryRpc } from "../src/rpc.js";

export const REGISTRY_ID = "registry.praetorial.test";
export interface Actor { account: string; kp: nacl.SignKeyPair; pub: string }
export function actor(account: string): Actor {
  const kp = nacl.sign.keyPair();
  return { account, kp, pub: "ed25519:" + bs58.encode(kp.publicKey) };
}
/** nonce = 8-byte big-endian ms timestamp + 24 random bytes (timestamped, single-use). */
export function makeNonce(ts: number): Buffer {
  const b = Buffer.alloc(32, 0);
  randomBytes(24).copy(b, 8);
  b.writeBigUInt64BE(BigInt(ts), 0);
  return b;
}
export function claimBody(a: Actor, username: string, o: { ts?: number; nonce?: Buffer; recipient?: string; signWith?: nacl.SignKeyPair; message?: string; extra?: object } = {}) {
  const nonce = o.nonce ?? makeNonce(o.ts ?? Date.now());
  const message = o.message ?? `praetorial-username:${username.toLowerCase().replace(/^@/, "")}`;
  const digest = hashNep413({ message, nonce, recipient: o.recipient ?? REGISTRY_ID });
  const sig = nacl.sign.detached(digest, (o.signWith ?? a.kp).secretKey);
  return { username, account_id: a.account, public_key: a.pub, nonce: nonce.toString("base64"), signature: Buffer.from(sig).toString("base64"), ...(o.extra ?? {}) };
}
export function fakeRpc(keys: Record<string, AccessKeyInfo[]>): RegistryRpc {
  return { async viewAccessKeyList(id) { return keys[id] ?? []; }, async accountExists(id) { return id in keys; } };
}
export function fullKey(a: Actor): AccessKeyInfo { return { public_key: a.pub, access_key: { permission: "FullAccess" } }; }
export function fnKey(a: Actor): AccessKeyInfo { return { public_key: a.pub, access_key: { permission: { FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } } } }; }

export async function start(actors: Actor[], over: Partial<RegistryServerOpts> = {}, keys?: Record<string, AccessKeyInfo[]>) {
  // CF1f parity: REGISTRY_BACKEND=worker runs the SAME suites against the Worker handler (D1) behind a node http adapter.
  if (process.env.REGISTRY_BACKEND === "worker") {
    const { startWorkerBackend } = await import("../../workers/registry/test/workerBackend.js");
    return startWorkerBackend(over, over.rpc ?? fakeRpc(keys ?? Object.fromEntries(actors.map((a) => [a.account, [fullKey(a)]]))), REGISTRY_ID);
  }
  const store = over.store ?? new MemoryStore();
  const rpc = over.rpc ?? fakeRpc(keys ?? Object.fromEntries(actors.map((a) => [a.account, [fullKey(a)]])));
  const server = createRegistryServer({ registryId: REGISTRY_ID, store, rpc, corsOrigins: ["https://app.example"], rate: { capacity: 1000, refillPerSec: 1000 }, maxBodyBytes: 2048, ...over });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  type Res = Omit<Response, "json"> & { json(): Promise<any> };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = {}): Promise<Res> => fetch(base + path, { headers });
  return { server, store, base, post, get, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
export type { RegistryServerOpts };

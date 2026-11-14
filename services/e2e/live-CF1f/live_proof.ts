// CF1f live testnet proof (D-REGW1, D-CF1F1, D-TNEAR1): a fresh implicit testnet account (funded 0.1 NEAR by the dev account) claims ONE username on the
// DEPLOYED registry Worker via a real NEP-413 signature (the Worker checks the key is full-access on chain through the public testnet RPC), then the
// script drives search / lookup / health traffic (>= 60 requests total) while `wrangler tail praetorial-registry-testnet` runs in another process.
// usage (from services/): REGISTRY_URL=https://praetorial-registry-testnet.<sub>.workers.dev NEAR_RPC_URL=<testnet rpc> node --import tsx e2e/live-CF1f/live_proof.ts
// Never prints or stores a private key. Writes results.json (public data + tx hash only).
import fs from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { KeyPair, connect, keyStores } from "near-api-js";
import { hashNep413 } from "@praetorial/common/nep413.js";
import { DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";

const URLBASE = process.env.REGISTRY_URL!; const RPC = process.env.NEAR_RPC_URL ?? DEFAULT_TESTNET_RPC_URL;
const REGISTRY_ID = process.env.REGISTRY_ID ?? "registry.praetorial.testnet";
const CRED = `${process.env.HOME}/.near-credentials/testnet`; const DEV = "praetorial-dev-1101.testnet";
const OUT = new URL("./results.json", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (!URLBASE) throw new Error("REGISTRY_URL required");

const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("testnet", DEV, KeyPair.fromString(JSON.parse(fs.readFileSync(`${CRED}/${DEV}.json`, "utf8")).private_key));
const dev: any = await (await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks })).account(DEV);

const kp = nacl.sign.keyPair(); const pub = "ed25519:" + bs58.encode(kp.publicKey);
const account = Buffer.from(kp.publicKey).toString("hex"); // implicit account id
const username = `cf1f_${Date.now().toString(36).slice(-6)}`;
const res: any = { network: "testnet", registry: URLBASE, account, public_key: pub, username, txs: [], requests: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(res, null, 2));

const fund: any = await dev.sendMoney(account, 100_000_000_000_000_000_000_000n);
res.txs.push({ step: "fund fresh implicit account 0.1 NEAR", hash: fund.transaction.hash, url: `https://testnet.nearblocks.io/txns/${fund.transaction.hash}` });
console.log("funded", account, fund.transaction.hash); save();
await sleep(6000);

const hit = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(URLBASE + path, { method, headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); res.requests.push({ method, path, status: r.status, body: text.slice(0, 200) }); save();
  return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return text; } })() };
};

// real claim (fresh nonce + signature per attempt; retry only while the freshly funded account is not yet visible on the RPC => 403/502)
const signedClaim = () => {
  const nonce = Buffer.alloc(32); randomBytes(24).copy(nonce, 8); nonce.writeBigUInt64BE(BigInt(Date.now()), 0);
  const sig = nacl.sign.detached(hashNep413({ message: `praetorial-username:${username}`, nonce, recipient: REGISTRY_ID }), kp.secretKey);
  return { username, account_id: account, public_key: pub, nonce: nonce.toString("base64"), signature: Buffer.from(sig).toString("base64") };
};
let c = await hit("POST", "/claim", signedClaim());
for (let i = 0; (c.status === 502 || c.status === 403) && i < 4; i++) { await sleep(5000); c = await hit("POST", "/claim", signedClaim()); }
console.log("claim", c.status, JSON.stringify(c.json));
res.claim = { status: c.status, body: c.json };
if (c.status !== 200) { save(); throw new Error("claim failed: " + JSON.stringify(c.json)); }

// traffic: >= 64 requests; rate-limited routes (search, lookup/username) paced under the bucket refill (0.5/s => 1 per 2 s is safe)
const checks: string[] = [];
const ok = (cond: boolean, msg: string) => { checks.push((cond ? "PASS " : "FAIL ") + msg); if (!cond) console.log("FAIL", msg); };
for (let i = 0; i < 30; i++) {
  const s = await hit("GET", `/search?q=${encodeURIComponent(username.slice(0, 5 + (i % 4)))}`); ok(s.status === 200 && Array.isArray(s.json) && s.json.some((r: any) => r.username === username), `search ${i}`);
  await sleep(700);
  const u = await hit("GET", `/lookup/username/${username.toUpperCase()}`); ok(u.status === 200 && u.json.account_id === account, `lookup username ${i}`);
  await sleep(700);
  const a = await hit("GET", `/lookup/account/${account}`); ok(a.status === 200 && a.json.username === username, `lookup account ${i}`);
  await sleep(700);
  const h = await hit("GET", "/health"); ok(h.status === 200 && h.json.ok === true, `health ${i}`);
  await sleep(1500);
}
const miss = await hit("GET", "/lookup/username/nobodyhere_xyz"); ok(miss.status === 404, "unknown username 404");
res.checks = checks; res.requestCount = res.requests.length; res.failedChecks = checks.filter((x) => x.startsWith("FAIL")).length; save();
console.log(`requests=${res.requests.length} failedChecks=${res.failedChecks}`);
if (res.failedChecks) process.exit(1);

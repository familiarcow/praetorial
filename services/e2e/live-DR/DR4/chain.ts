// DR4 Node-side chain helpers (testnet only). Keys are read from ~/.near-credentials/testnet inside functions and never printed.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { loadWebTestnetConfig } from "./webConfig.js";
import { resolveRpcUrls } from "../../../common/src/rpc.js";
// PUB1/MISS1: resolve near-api-js from THIS checkout's services/ (repo-relative via import.meta.url), never one machine's path.
export const SERVICES_PACKAGE_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json");
const require = createRequire(SERVICES_PACKAGE_JSON);
const { connect, keyStores, KeyPair } = require("near-api-js");
export const RPC = resolveRpcUrls("testnet").primary;
// single source: apps/web/lib/network.ts (what the web build uses), so the harness cannot drift from the app
const WEB = await loadWebTestnetConfig();
export const ESCROW = WEB.escrow;
export const INTENTS = WEB.intents;
// The create form offers only NEAR (maker-asset select disabled), so the rehearsal stakes wNEAR (nep141:wrap.testnet) held in the betting balance.
export const STAKE_TOKEN = WEB.stakeToken;
export const FEE = "fee.praetorial-dev-1101.testnet";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CRED = `${process.env.HOME}/.near-credentials/testnet`;
export async function acct(id: string): Promise<any> {
  const ks = new keyStores.InMemoryKeyStore();
  if (id) await ks.setKey("testnet", id, KeyPair.fromString(JSON.parse(fs.readFileSync(`${CRED}/${id}.json`, "utf8")).private_key));
  return (await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks })).account(id || "dr6-view.testnet");
}
export async function viewer() { return acct(""); }
export const view = async (m: string, a: Record<string, unknown> = {}) => (await viewer()).viewFunction({ contractId: ESCROW, methodName: m, args: a });
export const bal = async (id: string, token: string = STAKE_TOKEN): Promise<bigint> => BigInt(await (await viewer()).viewFunction({ contractId: INTENTS, methodName: "mt_balance_of", args: { account_id: id, token_id: token } }));
export const nearBal = async (id: string): Promise<string> => { try { return (await (await viewer()).connection.provider.query({ request_type: "view_account", account_id: id, finality: "final" })).amount; } catch { return "absent"; } };

/** Taker test wallet: ed25519 key persisted (0600) outside the repo; the implicit account id is the hex public key. Secret never leaves Node. */
const cacheDir = (): string => process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir; holds scratch/<run>_<role>_key.json)"); })();
const keyFile = (role: string) => `${cacheDir()}/scratch/dr4_${role}_key.json`;
export function wallet(role: "taker"): { address: string; sign: (hashHex: string) => string } {
  const KEYFILE = keyFile(role);
  if (!fs.existsSync(KEYFILE)) { const k = nacl.sign.keyPair(); fs.writeFileSync(KEYFILE, JSON.stringify({ secret: Buffer.from(k.secretKey).toString("hex") }), { mode: 0o600 }); }
  const sk = Uint8Array.from(Buffer.from(JSON.parse(fs.readFileSync(KEYFILE, "utf8")).secret, "hex"));
  const address = Buffer.from(sk.slice(32)).toString("hex");
  return { address, sign: (hashHex) => Buffer.from(nacl.sign.detached(Uint8Array.from(Buffer.from(hashHex.replace(/^0x/, ""), "hex")), sk)).toString("hex") };
}
/** Faucet for the rehearsal: keeper mints mock USDC (the mock intents' mint) and sends a little tNEAR so an implicit account exists. */
export async function fundUsdc(to: string, amount: bigint, token: string = STAKE_TOKEN): Promise<string> {
  const keeper = await acct("keeper.praetorial-dev-1101.testnet");
  const r = await keeper.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: to, token_id: token, amount: amount.toString() }, gas: 30_000_000_000_000n });
  return r.transaction.hash;
}
export async function fundNear(to: string, yocto: bigint): Promise<string> {
  const dev = await acct("praetorial-dev-1101.testnet");
  const r = await dev.sendMoney(to, yocto);
  return r.transaction.hash;
}
/** Public tx indexer: every tx touching the escrow, with method names found in the receipt trees. */
export async function escrowMethods(sinceNs: bigint): Promise<{ hash: string; methods: string[]; tsNs: string }[]> {
  const idx = "https://tx.test.fastnear.com";
  const post = async (p: string, b: unknown) => (await fetch(idx + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
  const acc: any = await post("/v0/account", { account_id: ESCROW, limit: 60 });
  const rows: any[] = acc.account_txs ?? acc.txs ?? [];
  const hashes = rows.filter((r) => BigInt(r.tx_block_timestamp ?? r.block_timestamp ?? 0) >= sinceNs).map((r) => r.transaction_hash ?? r.tx_hash);
  if (!hashes.length) return [];
  const full: any = await post("/v0/transactions", { tx_hashes: hashes });
  return (full.transactions ?? []).map((t: any) => {
    const methods = new Set<string>(); const walk = (o: any) => { if (o && typeof o === "object") { if (typeof o.method_name === "string") methods.add(o.method_name); for (const v of Object.values(o)) walk(v); } };
    walk(t);
    return { hash: t.transaction?.hash ?? t.hash, methods: [...methods], tsNs: String(t.execution_outcome?.block_timestamp ?? t.transaction_outcome?.block_timestamp ?? "0") };
  });
}

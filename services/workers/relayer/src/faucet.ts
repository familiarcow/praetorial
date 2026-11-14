// FUND1b: testnet-only one-click "Get test NEAR". POST /faucet {account} -> a capped NEAR transfer from the relayer account (its key is
// the Worker secret; it never reaches a browser). Refuses any non-testnet network, any non-testnet account id, and rate-limits per
// account (1/day), per IP (3/day) and globally (50/day). The amount is fixed server-side and clamped to 1 NEAR.
import { BorshWriter, base58Decode, base64Encode } from "../../common/src/bytes.js";
import { parseNearSecretKey, ed25519Key, base58Encode, type JsonRpc } from "../../common/src/nearWebClient.js";
import type { DoStorage } from "./guardDriver.js";

export const FAUCET_MAX_YOCTO = 10n ** 24n; // 1 NEAR, hard ceiling
const DAY_MS = 86_400_000;
const ACCOUNT = /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+testnet$|^[0-9a-f]{64}$/; // *.testnet, or a 64-hex implicit account (every Privy user)

export interface FaucetCfg { networkId: string; amountYocto: bigint; perIpPerDay: number; globalPerDay: number }
export function faucetCfg(env: Record<string, unknown>, networkId: string): FaucetCfg {
  const n = (k: string, d: number) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
  let amount = FAUCET_MAX_YOCTO;
  try { if (typeof env.FAUCET_AMOUNT_YOCTO === "string") amount = BigInt(env.FAUCET_AMOUNT_YOCTO); } catch { /* default */ }
  if (amount <= 0n || amount > FAUCET_MAX_YOCTO) amount = FAUCET_MAX_YOCTO;
  return { networkId, amountYocto: amount, perIpPerDay: n("FAUCET_PER_IP_PER_DAY", 3), globalPerDay: n("FAUCET_GLOBAL_PER_DAY", 50) };
}

/** Borsh SignedTransaction: one Transfer action (tag 3, u128 deposit) from the faucet/relayer key. */
export async function buildTransferTx(i: { signerId: string; secretKey: string; nonce: bigint; receiverId: string; blockHash: string; yocto: bigint }): Promise<Uint8Array> {
  const { seed, pub } = parseNearSecretKey(i.secretKey);
  const tx = new BorshWriter().string(i.signerId).u8(0).fixed(pub).u64(i.nonce).string(i.receiverId).fixed(base58Decode(i.blockHash)).u32(1).u8(3).u128(i.yocto).finish();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", tx as Uint8Array<ArrayBuffer>));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", await ed25519Key(seed), digest));
  return new BorshWriter().fixed(tx).u8(0).fixed(sig).finish();
}

export interface FaucetResult { status: number; body: Record<string, unknown> }
const fail = (status: number, error: string): FaucetResult => ({ status, body: { ok: false, error } });

export async function runFaucet(a: {
  cfg: FaucetCfg; storage: DoStorage; rpc: JsonRpc; signerId: string; secretKey: string; account: unknown; ip: string; now?: number; nonceFloor?: { v: bigint };
}): Promise<FaucetResult> {
  if (a.cfg.networkId !== "testnet") return { status: 404, body: { error: "POST /relay only" } }; // mainnet: the route does not exist
  if (typeof a.account !== "string" || !ACCOUNT.test(a.account)) return fail(400, "That isn't a testnet account.");
  const now = a.now ?? Date.now();
  const sql = a.storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS faucet_log (account TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL)").toArray();
  const count = (where: string, ...b: unknown[]) => Number(sql.exec(`SELECT COUNT(*) AS c FROM faucet_log WHERE at > ? ${where}`, now - DAY_MS, ...b).toArray()[0]?.c ?? 0);
  if (count("AND account = ?", a.account) >= 1) return fail(429, "This account already got test NEAR today. Try again tomorrow.");
  if (count("AND ip = ?", a.ip) >= a.cfg.perIpPerDay) return fail(429, "Too many test NEAR requests from your network today. Try again tomorrow.");
  if (count("") >= a.cfg.globalPerDay) return fail(429, "The test NEAR faucet is out for today. Try again tomorrow.");
  try {
    const call = async (method: string, params: unknown) => {
      const res = await a.rpc.sendJsonRpc(method, params);
      if (res?.error || typeof res?.result === "undefined") throw new Error(`rpc ${method} failed`);
      return res.result;
    };
    const { pub } = parseNearSecretKey(a.secretKey);
    const block = await call("block", { finality: "final" });
    const key = await call("query", { request_type: "view_access_key", finality: "optimistic", account_id: a.signerId, public_key: "ed25519:" + base58Encode(pub) });
    const signed = await buildTransferTx({ signerId: a.signerId, secretKey: a.secretKey, nonce: BigInt(key.nonce) + 1n, receiverId: a.account, blockHash: block.header.hash, yocto: a.cfg.amountYocto });
    const out = await call("send_tx", { signed_tx_base64: base64Encode(signed), wait_until: "EXECUTED_OPTIMISTIC" });
    if (out?.status?.Failure) throw new Error("transfer failed");
    const txHash = out?.transaction?.hash ?? out?.transaction_outcome?.id;
    sql.exec("INSERT INTO faucet_log (account, ip, at) VALUES (?, ?, ?)", a.account, a.ip, now).toArray();
    return { status: 200, body: { ok: true, txHash, amountNear: (a.cfg.amountYocto / 10n ** 24n).toString() } };
  } catch {
    return fail(502, "We couldn't send test NEAR right now. Nothing was charged. Try again in a minute.");
  }
}

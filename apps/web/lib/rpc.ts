// Minimal paced JSON-RPC client for NEAR view calls (read-only). Caps at
// ~3 req/s per the task brief's RPC pacing requirement.
import { NEAR_RPC_URL, RPC_MIN_INTERVAL_MS } from "./config";
import { liveState } from "./liveState";
import { retryOn429 } from "./rateLimit";

let lastCallAt = 0;
async function pace() {
  const now = Date.now();
  const wait = lastCallAt + RPC_MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// REVIEW1 (#8, SM1 AUTH-1): a read that fails on the network is tried again a couple of times with a short backoff before it
// counts as failed; one that still fails is handed to liveState with a way to re-run it, so the app recovers by itself (no reload)
// once the RPC answers again. send_tx is a write: never re-sent from here and never marks the app's reads as failed.
const NOT_A_READ = new Set(["send_tx", "broadcast_tx_async", "broadcast_tx_commit"]);
export const RPC_READ_RETRY_DELAYS_MS = [400, 1200];

class RpcAnswerError extends Error {}

async function rpcOnce(method: string, params: Record<string, unknown>): Promise<any> {
  const res = await retryOn429(async () => {
    await pace();
    const r = await fetch(NEAR_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
    });
    return Object.assign(r, { retryAfter: r.headers.get("retry-after") });
  }, { onWait: (s) => liveState.busy(s) });
  if (res.status === 429) throw new Error("rate limited");
  const body = await res.json();
  // An RPC-level error (e.g. unknown account) is an answer: the connection works.
  if (body.error) throw new RpcAnswerError(JSON.stringify(body.error));
  return body.result;
}

async function rpcCall(method: string, params: Record<string, unknown>): Promise<any> {
  const key = `${method}:${String(params.request_type ?? "")}:${String(params.method_name ?? "")}`;
  const read = !NOT_A_READ.has(method);
  const delays = read ? RPC_READ_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await rpcOnce(method, params);
      if (read) liveState.viewOk(key);
      return out;
    } catch (e) {
      if (e instanceof RpcAnswerError) {
        if (read) liveState.viewOk(key);
        throw new Error(e.message);
      }
      if (attempt < delays.length) { await new Promise((r) => setTimeout(r, delays[attempt])); continue; }
      // A thrown network/HTTP failure means what we hold may be stale. Keep re-trying this read in the background until it answers.
      if (read) liveState.viewFailed(key, () => rpcCall(method, params).then(() => undefined));
      throw e;
    }
  }
}

/** The chain the RPC is on ("testnet" / "mainnet"), or null if it can't be read. */
export async function viewChainId(): Promise<string | null> {
  try { const r = await rpcCall("status", {}); return typeof r?.chain_id === "string" ? r.chain_id : null; } catch { return null; }
}

export async function viewFunction<T>(
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const argsBase64 = btoa(JSON.stringify(args));
  const result = await rpcCall("query", {
    request_type: "call_function",
    account_id: contractId,
    method_name: methodName,
    args_base64: argsBase64,
    finality: "optimistic",
  });
  const bytes = new Uint8Array(result.result);
  const text = new TextDecoder().decode(bytes);
  return text.length ? JSON.parse(text) : (null as unknown as T);
}

export async function viewAccountBalanceYocto(accountId: string): Promise<bigint | null> {
  try {
    const result = await rpcCall("query", {
      request_type: "view_account",
      account_id: accountId,
      finality: "optimistic", // FUND1: a just-funded account (faucet / transfer) must show up at once, not two blocks later
    });
    return BigInt(result.amount);
  } catch (err: any) {
    if (/does not exist|doesn't exist|UNKNOWN_ACCOUNT/i.test(String(err?.message ?? err))) return null;
    throw err;
  }
}

// Access-key nonce lookup -- required to build a NEP-366 DelegateAction
// (its nonce must be current-key-nonce + 1, same rule as a normal tx).
// Privy's NEAR wallet uses a single ed25519 full-access key; we look it
// up by its base58 form since that's what `query access_key` wants.
/** FUND2: like viewAccessKeyNonce, but null when the account or key does not exist on chain yet (deposit-only user). */
export async function viewAccessKeyNonceOrNull(accountId: string, publicKeyEd25519Hex: string): Promise<bigint | null> {
  const { base58FromHex } = await import("./delegate");
  const { parseAccessKeyNonce } = await import("./accountActivation");
  let r: unknown;
  try {
    r = await rpcCall("query", { request_type: "view_access_key", account_id: accountId, public_key: `ed25519:${base58FromHex(publicKeyEd25519Hex)}`, finality: "optimistic" });
  } catch (e) { return parseAccessKeyNonce(e instanceof Error ? e : new Error(String(e))); }
  return parseAccessKeyNonce(r);
}

export async function viewAccessKeyNonce(accountId: string, publicKeyEd25519Hex: string): Promise<bigint> {
  // For a NEAR implicit account the account id IS the hex public key
  // (same value passed in here); convert to the base58 NEAR RPC wants,
  // in one place, instead of each caller juggling encodings.
  const { base58FromHex } = await import("./delegate");
  const result = await rpcCall("query", {
    request_type: "view_access_key",
    account_id: accountId,
    public_key: `ed25519:${base58FromHex(publicKeyEd25519Hex)}`,
    finality: "optimistic",
  });
  return BigInt(result.nonce);
}

// Current block height -- used to set a DelegateAction's maxBlockHeight
// a short window out (the relayer independently caps how far future this
// may be via RELAYER_MAX_BLOCK_HEIGHT_FUTURE).
/** REVIEW1 (#10): timestamp of the latest final block in ms (the contract's clock), or null when the header has none. */
export async function viewFinalBlockTimeMs(): Promise<number | null> {
  const result = await rpcCall("block", { finality: "final" });
  const h = result?.header ?? {};
  const raw = h.timestamp_nanosec ?? h.timestamp;
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) return null;
  return Number(BigInt(String(raw)) / 1_000_000n);
}

export async function viewBlockHeight(): Promise<bigint> {
  const result = await rpcCall("block", { finality: "final" });
  return BigInt(result.header.height);
}

/** FE8: logs of every receipt of a finished transaction (so the app can read the contract's `open_rejected` reason). null = not readable yet. */
export async function viewTxLogs(txHash: string, senderId: string): Promise<string[] | null> {
  try {
    const r = await rpcCall("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" });
    const outs: any[] = r?.receipts_outcome ?? [];
    return outs.flatMap((o) => (o?.outcome?.logs as string[] | undefined) ?? []);
  } catch {
    return null;
  }
}

/** FE10b: the contract's panic text when a finished (relayed) transaction failed, else null (still running, unreadable, or fine). */
export async function viewTxFailure(txHash: string, senderId: string): Promise<string | null> {
  try {
    const r = await rpcCall("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" });
    const fails: unknown[] = [];
    if (r?.status?.Failure) fails.push(r.status.Failure);
    for (const o of (r?.receipts_outcome ?? []) as any[]) if (o?.outcome?.status?.Failure) fails.push(o.outcome.status.Failure);
    return fails.length ? JSON.stringify(fails) : null;
  } catch {
    return null;
  }
}

/** RELAYDEP1: hash of the latest final block (a plain transaction must reference one). */
export async function viewBlockHash(): Promise<string> {
  const result = await rpcCall("block", { finality: "final" });
  return String(result.header.hash);
}

/** RELAYDEP1: broadcast a user-signed transaction (base64 borsh SignedTransaction) and return its hash once it is included. */
export async function sendSignedTx(signedTxBase64: string, senderId: string): Promise<string> {
  const r = await rpcCall("send_tx", { signed_tx_base64: signedTxBase64, wait_until: "INCLUDED_FINAL" });
  const hash = r?.transaction?.hash ?? r?.transaction_outcome?.id;
  if (!hash) {
    // Some nodes return nothing useful at INCLUDED_FINAL; derive the id from the bytes (base58 of sha256 of the transaction).
    const { sha256 } = await import("js-sha256");
    const { decodeSignedTransaction, encodeTransaction } = await import("@near-js/transactions");
    const { base58FromHex } = await import("./delegate");
    const st = decodeSignedTransaction(Buffer.from(signedTxBase64, "base64"));
    void senderId;
    return base58FromHex(sha256(Buffer.from(encodeTransaction(st.transaction))));
  }
  if (r?.status?.Failure) throw new Error(`the transaction failed on chain: ${JSON.stringify(r.status.Failure)}`);
  return String(hash);
}

/** V1: a view's exact result text (no JSON.parse here: u64 nanoseconds above 2^53 would be rounded). */
export async function viewFunctionText(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await rpcCall("query", { request_type: "call_function", account_id: contractId, method_name: methodName, args_base64: btoa(JSON.stringify(args)), finality: "final" });
  return new TextDecoder().decode(new Uint8Array(result.result));
}

/** V1: an account's deployed code hash (base58, as NEAR reports it) and how many access keys it has (0 = nobody can deploy). */
export async function viewAccountLock(accountId: string): Promise<{ codeHashB58: string; accessKeys: number }> {
  const acct = await rpcCall("query", { request_type: "view_account", account_id: accountId, finality: "final" });
  const keys = await rpcCall("query", { request_type: "view_access_key_list", account_id: accountId, finality: "final" });
  return { codeHashB58: String(acct.code_hash), accessKeys: Array.isArray(keys?.keys) ? keys.keys.length : -1 };
}

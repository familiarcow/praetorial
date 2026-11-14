// Thin RPC helpers against the public testnet RPC, with retry/backoff.
// D-RPC1 (queue item 7b): the actual default URL / NEAR_RPC_URL /
// NEAR_RPC_FALLBACKS resolution now lives in ONE place
// (services/common/src/rpc.ts); this file just re-exports it under
// this folder's existing NODE_URL/NETWORK_ID names so call sites below
// don't change, without hardcoding the URL a second time.
import { providers } from "near-api-js";
import { resolveRpcUrls } from "../../common/src/rpc.js";

export const NODE_URL = resolveRpcUrls("testnet").primary;
export const NETWORK_ID = "testnet";

export function provider(): providers.JsonRpcProvider {
  return new providers.JsonRpcProvider({ url: NODE_URL });
}

export async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 6): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      const retryable = /429|rate|limit|timeout|ECONNRESET|Unknown block|503|502/i.test(msg);
      const waitMs = Math.min(1000 * 2 ** i, 15000) + Math.floor(Math.random() * 300);
      console.warn(`  [retry ${i + 1}/${attempts}] ${label}: ${msg} (retryable=${retryable}, waiting ${waitMs}ms)`);
      if (!retryable && i >= 1) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

export async function viewAccessKeyNonce(accountId: string, publicKeyStr: string): Promise<bigint> {
  const p = provider();
  const res: any = await withRetry(
    () =>
      p.query({
        request_type: "view_access_key",
        account_id: accountId,
        public_key: publicKeyStr,
        finality: "final",
      } as any),
    `view_access_key(${accountId})`,
  );
  return BigInt(res.nonce) + 1n;
}

export async function latestBlockHashBytes(): Promise<Uint8Array> {
  const p = provider();
  const block: any = await withRetry(() => p.block({ finality: "final" }), "block(final)");
  // near-api-js base58-decodes block hashes elsewhere; do it ourselves to
  // avoid pulling in another helper module.
  const bs58 = (await import("bs58")).default;
  return bs58.decode(block.header.hash);
}

export async function viewFunction<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  const p = provider();
  const res: any = await withRetry(
    () =>
      p.query({
        request_type: "call_function",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        finality: "optimistic",
      } as any),
    `view(${contractId}.${methodName})`,
  );
  const bytes = Buffer.from(res.result);
  return bytes.length ? JSON.parse(bytes.toString("utf8")) : (null as unknown as T);
}

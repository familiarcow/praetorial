// Thin RPC helpers, copied/adapted from services/privy-e2e/lib/rpc.ts
// (self-contained on purpose -- this folder doesn't import across
// service boundaries). Adds a mainnet provider for the view-only
// NEP-413 / simulate_intents check (step 4): no mainnet spend, ever.
import { providers } from "near-api-js";
import { NODE_URL_TESTNET, NODE_URL_MAINNET } from "./config.js";

export function testnetProvider(): providers.JsonRpcProvider {
  return new providers.JsonRpcProvider({ url: NODE_URL_TESTNET });
}

export function mainnetProvider(): providers.JsonRpcProvider {
  return new providers.JsonRpcProvider({ url: NODE_URL_MAINNET });
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
  const p = testnetProvider();
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
  const p = testnetProvider();
  const block: any = await withRetry(() => p.block({ finality: "final" }), "block(final)");
  const bs58 = (await import("bs58")).default;
  return bs58.decode(block.header.hash);
}

export async function viewAccountExists(accountId: string): Promise<boolean> {
  const p = testnetProvider();
  try {
    await p.query({ request_type: "view_account", account_id: accountId, finality: "final" } as any);
    return true;
  } catch (err: any) {
    if (/does not exist|doesn't exist/i.test(String(err?.message ?? err))) return false;
    throw err;
  }
}

/** Returns the account's current balance in yoctoNEAR, or null if it
 * doesn't exist yet. Used to make funding idempotent -- re-running the
 * suite should not keep draining the shared testnet funder. */
export async function viewAccountBalanceYocto(accountId: string): Promise<bigint | null> {
  const p = testnetProvider();
  try {
    const res: any = await p.query({ request_type: "view_account", account_id: accountId, finality: "final" } as any);
    return BigInt(res.amount);
  } catch (err: any) {
    if (/does not exist|doesn't exist/i.test(String(err?.message ?? err))) return null;
    throw err;
  }
}

export async function mainnetViewFunction<T>(
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const p = mainnetProvider();
  const res: any = await withRetry(
    () =>
      p.query({
        request_type: "call_function",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        finality: "optimistic",
      } as any),
    `mainnet view(${contractId}.${methodName})`,
  );
  const bytes = Buffer.from(res.result);
  return bytes.length ? JSON.parse(bytes.toString("utf8")) : (null as unknown as T);
}

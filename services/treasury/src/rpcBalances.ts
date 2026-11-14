// D-ECON2 follow-up (1): real balance readers.
//
// Reads the treasury/fee account's native NEAR balance (JSON-RPC
// `query` / `view_account` -- https://docs.near.org/api/rpc/contracts#view-account)
// and its NEAR Intents multi-token balances (`mt_batch_balance_of` on
// the Verifier/Intents contract, NEP-245). Method + request/response
// shape verified against the public docs:
// https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/balances
// ("Batch balance query" section: args `{ account_id, token_ids }`,
// response is a JSON array of decimal-string amounts, smallest units,
// same order as the requested token_ids).
//
// IMPORTANT per the same docs family
// (https://docs.near-intents.org/resources/faqs, "Is there a testnet
// deployment?" -> "There is no testnet deployment ... We recommend
// testing on NEAR mainnet using separate dev/test NEAR accounts."):
// the Intents/Verifier contract itself has no testnet deployment, so
// `intentsContractId` below defaults to the real mainnet `intents.near`
// regardless of networkId. Nothing in this package calls it for real:
// every test here goes through a real PacedRpcClient with a MOCKED
// fetchImpl (see services/common/src/rpc.ts), never a live endpoint.
//
// Everything below depends only on an `RpcSender` (the `sendJsonRpc`
// method `PacedRpcClient` already implements), not on the concrete
// class, so tests can inject any fake honoring that shape too.
import type { AssetBalance, FeeBalanceReader, FloatBalanceReader, FloatBalances } from "./types.js";

export interface RpcSender {
  sendJsonRpc(method: string, params: unknown): Promise<any>;
}

function unwrapRpcResult(resp: any, label: string): any {
  if (resp?.error) {
    const msg = typeof resp.error === "string" ? resp.error : JSON.stringify(resp.error);
    throw new Error(`NEAR RPC error (${label}): ${msg}`);
  }
  if (resp?.result === undefined) {
    throw new Error(`NEAR RPC (${label}): response had no result`);
  }
  return resp.result;
}

/** Native NEAR balance (yoctoNEAR) of any account, via view_account. */
export async function getNearBalanceYocto(rpc: RpcSender, accountId: string): Promise<bigint> {
  const resp = await rpc.sendJsonRpc("query", {
    request_type: "view_account",
    account_id: accountId,
    finality: "optimistic",
  });
  const result = unwrapRpcResult(resp, `view_account(${accountId})`);
  return BigInt(result.amount);
}

/** Batch NEAR Intents multi-token balances for `accountId`, in the
 * SAME ORDER as `tokenIds` (mt_batch_balance_of's documented
 * contract). Returns [] without calling the RPC at all when
 * `tokenIds` is empty -- there is nothing to ask for. */
export async function getIntentsMultiTokenBalances(
  rpc: RpcSender,
  intentsContractId: string,
  accountId: string,
  tokenIds: string[],
): Promise<bigint[]> {
  if (tokenIds.length === 0) return [];

  const argsBase64 = Buffer.from(JSON.stringify({ account_id: accountId, token_ids: tokenIds })).toString("base64");
  const resp = await rpc.sendJsonRpc("query", {
    request_type: "call_function",
    account_id: intentsContractId,
    method_name: "mt_batch_balance_of",
    args_base64: argsBase64,
    finality: "optimistic",
  });
  const result = unwrapRpcResult(resp, `mt_batch_balance_of(${accountId})`);
  const bytes = Buffer.from(result.result);
  const parsed: string[] = bytes.length ? JSON.parse(bytes.toString("utf8")) : [];
  if (parsed.length !== tokenIds.length) {
    throw new Error(
      `mt_batch_balance_of(${accountId}) on ${intentsContractId} returned ${parsed.length} balances for ${tokenIds.length} requested token ids`,
    );
  }
  return parsed.map((s) => BigInt(s));
}

export const DEFAULT_INTENTS_CONTRACT_ID = "intents.near";

/** Real FeeBalanceReader: the fee account's collected per-asset
 * balances ARE its NEAR Intents multi-token balances for the
 * configured `tokenIds` list (the set of 1Click asset ids this job
 * is willing to swap). */
export class RpcFeeBalanceReader implements FeeBalanceReader {
  constructor(
    private readonly rpc: RpcSender,
    private readonly intentsContractId: string,
    private readonly accountId: string,
    private readonly tokenIds: string[],
  ) {}

  async getFeeBalances(): Promise<AssetBalance[]> {
    const amounts = await getIntentsMultiTokenBalances(this.rpc, this.intentsContractId, this.accountId, this.tokenIds);
    return this.tokenIds.map((assetId, i) => ({ assetId, amount: amounts[i]! }));
  }
}

/** Real FloatBalanceReader: relayer/keeper gas accounts' current
 * native NEAR balances. */
export class RpcFloatBalanceReader implements FloatBalanceReader {
  constructor(
    private readonly rpc: RpcSender,
    private readonly relayerAccountId: string,
    private readonly keeperAccountId: string,
  ) {}

  async getFloatBalances(): Promise<FloatBalances> {
    const [relayer, keeper] = await Promise.all([
      getNearBalanceYocto(this.rpc, this.relayerAccountId),
      getNearBalanceYocto(this.rpc, this.keeperAccountId),
    ]);
    return { relayer, keeper };
  }
}

/** Convenience summary of the treasury/fee account's own balances
 * (native NEAR + Intents multi-token), for logging/display -- not
 * part of the planner's injected interfaces, just the two real reads
 * follow-up (1) asked for in one place. */
export interface TreasuryAccountSummary {
  accountId: string;
  nearBalanceYocto: bigint;
  intentsBalances: AssetBalance[];
}

export async function getTreasuryAccountSummary(
  rpc: RpcSender,
  intentsContractId: string,
  accountId: string,
  tokenIds: string[],
): Promise<TreasuryAccountSummary> {
  const [nearBalanceYocto, amounts] = await Promise.all([
    getNearBalanceYocto(rpc, accountId),
    getIntentsMultiTokenBalances(rpc, intentsContractId, accountId, tokenIds),
  ]);
  return {
    accountId,
    nearBalanceYocto,
    intentsBalances: tokenIds.map((assetId, i) => ({ assetId, amount: amounts[i]! })),
  };
}

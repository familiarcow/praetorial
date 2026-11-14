// LIVE2 / WITHDRAW1: "Withdraw to wallet" -- betting (Intents) balance -> the user's own NEAR account. One relayed call to the
// intents contract, exactly real intents.near's `ft_withdraw {token, receiver_id, amount}` with 1 yocto (receiver = the
// signer; the relayer refuses anything else). Before it, if the wallet isn't registered on the token contract (an
// unregistered receiver makes ft_transfer fail and intents.near refunds the balance), a `storage_deposit` registers it,
// signed and paid by the user as a plain transaction (SEC1/MON-1: never relayed). Success is judged on chain: no failed receipt AND the wallet's token balance rose by the
// amount (intents.near refunds a failed ft_transfer silently inside the same tx). NEAR comes out as wNEAR (no unwrap).
import { intentsContractFor } from "./network";
import { assetId, CURRENT_NETWORK, type NetworkId } from "./assets";

export interface WithdrawStep { receiverId: string; methodName: string; args: Record<string, unknown>; depositYocto: string; gasTgas: number }
export { WITHDRAW_GAS_TGAS, STORAGE_DEPOSIT_GAS_TGAS } from "./relayGas";
import { WITHDRAW_GAS_TGAS, STORAGE_DEPOSIT_GAS_TGAS } from "./relayGas";
import { needsUserSignedTx } from "./directTx";
/** Largest registration deposit we will pay for (0.01 NEAR); NEP-141 registrations cost 0.00125. */
export const MAX_STORAGE_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n;

/** The bare NEP-141 contract of an asset (`nep141:usdc.testnet` -> `usdc.testnet`); null if the asset has none on this network. */
export function withdrawTokenContract(symbol: string, network: NetworkId = CURRENT_NETWORK): string | null {
  const id = assetId(symbol, network);
  return id && id.startsWith("nep141:") ? id.slice("nep141:".length) : null;
}

export function buildWithdrawStep(p: { symbol: string; account: string; amountUnits: string; network?: NetworkId }): WithdrawStep {
  const token = withdrawTokenContract(p.symbol, p.network);
  if (!token) throw new Error(`${p.symbol} can't be withdrawn to a NEAR wallet`);
  if (!/^\d+$/.test(p.amountUnits) || BigInt(p.amountUnits) === 0n) throw new Error("amount must be a positive whole number of base units");
  return { receiverId: intentsContractFor(p.network ?? CURRENT_NETWORK), methodName: "ft_withdraw", args: { token, receiver_id: p.account, amount: p.amountUnits }, depositYocto: "1", gasTgas: WITHDRAW_GAS_TGAS };
}

type View = (contract: string, method: string, args: Record<string, unknown>) => Promise<unknown>;
export interface WithdrawRelayResult { ok: boolean; txHash?: string; error?: string; receiptFailure?: string; status?: "unknown"; resumed?: boolean }
export interface WithdrawDeps {
  relay(step: WithdrawStep): Promise<WithdrawRelayResult>;
  /** SEC1/MON-1: a step that carries the user's NEAR (storage_deposit) is a plain transaction the user signs and pays. */
  direct(step: WithdrawStep): Promise<WithdrawRelayResult>;
  view: View;
  txFailure(txHash: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  /** SEC1/MON-2: an earlier attempt of this exact step whose outcome was unknown (null = none / it never ran). Checked FIRST. */
  inflight?(step: WithdrawStep): Promise<WithdrawRelayResult | null>;
}
export type WithdrawResult =
  | { ok: true; txHashes: string[]; receivedUnits: string; resumed?: boolean }
  | { ok: false; txHashes: string[]; detail: string; pending?: boolean };

const fmtNear = (y: bigint): string => (Number(y / 10n ** 15n) / 1e9).toString();
const big = (v: unknown): bigint => BigInt(String(v ?? "0").replace(/"/g, "") || "0");

export async function runWithdraw(p: { symbol: string; amountUnits: string }, account: string, deps: WithdrawDeps, network: NetworkId = CURRENT_NETWORK): Promise<WithdrawResult> {
  const txHashes: string[] = [];
  let pending = false;
  const send = async (step: WithdrawStep): Promise<string | null> => {
    const userPays = needsUserSignedTx(step.methodName, BigInt(step.depositYocto));
    const r = userPays ? await deps.direct(step) : await deps.relay(step);
    if (r.txHash) txHashes.push(r.txHash);
    if (r.status === "unknown") { pending = true; return r.error ?? "checking whether it went through"; }
    if (!r.ok) return r.error ?? (userPays ? "the transaction was not sent" : "the relayer refused the transaction");
    if (!r.txHash) return "the relayer returned no transaction hash";
    const failure = await deps.txFailure(r.txHash);
    return failure ? `the transaction failed on chain: ${failure}` : null;
  };
  try {
    const step = buildWithdrawStep({ symbol: p.symbol, account, amountUnits: p.amountUnits, network });
    // SEC1 / MON-2, MON-5: the same withdraw sent before (then a timeout, a reload, a closed tab) is resolved BEFORE any
    // balance check: once it landed, the lower balance would otherwise read as a fresh problem, or (balance permitting) a
    // second withdraw would be signed.
    const earlier = deps.inflight ? await deps.inflight(step) : null;
    if (earlier) {
      if (earlier.txHash) txHashes.push(earlier.txHash);
      if (earlier.status === "unknown") return { ok: false, pending: true, txHashes, detail: earlier.error ?? "checking whether it went through" };
      if (!earlier.ok) return { ok: false, txHashes, detail: earlier.error ?? "your earlier withdrawal failed on chain" };
      const failure = earlier.txHash ? await deps.txFailure(earlier.txHash) : null;
      if (failure) return { ok: false, txHashes, detail: `the transaction failed on chain: ${failure}` };
      return { ok: true, txHashes, receivedUnits: p.amountUnits, resumed: true };
    }
    const token = String(step.args.token);
    const tokenId = `nep141:${token}`;
    const have = big(await deps.view(step.receiverId, "mt_balance_of", { account_id: account, token_id: tokenId }));
    if (have < BigInt(p.amountUnits)) return { ok: false, txHashes, detail: `your betting balance has only ${have} base units of ${p.symbol}` };
    const reg = await deps.view(token, "storage_balance_of", { account_id: account });
    if (reg === null || reg === undefined) {
      const bounds = (await deps.view(token, "storage_balance_bounds", {})) as { min?: string } | null;
      const min = big(bounds?.min);
      if (min <= 0n || min > MAX_STORAGE_DEPOSIT_YOCTO) return { ok: false, txHashes, detail: `${token} asks an unexpected storage deposit (${bounds?.min ?? "unknown"})` };
      const err = await send({ receiverId: token, methodName: "storage_deposit", args: { account_id: account, registration_only: true }, depositYocto: min.toString(), gasTgas: STORAGE_DEPOSIT_GAS_TGAS });
      if (err && pending) return { ok: false, pending: true, txHashes, detail: err };
      if (err) return { ok: false, txHashes, detail: `registering your wallet on ${token} (a one-time ${fmtNear(min)} NEAR from your NEAR account, plus gas) failed: ${err}` };
    }
    const before = big(await deps.view(token, "ft_balance_of", { account_id: account }));
    const err = await send(step);
    if (err) return pending ? { ok: false, pending: true, txHashes, detail: err } : { ok: false, txHashes, detail: err };
    let after = big(await deps.view(token, "ft_balance_of", { account_id: account }));
    for (let i = 0; after - before < BigInt(p.amountUnits) && i < 5; i++) { await deps.sleep(1000); after = big(await deps.view(token, "ft_balance_of", { account_id: account })); }
    if (after - before < BigInt(p.amountUnits)) {
      return { ok: false, txHashes, detail: `the withdrawal did not arrive: your wallet's ${p.symbol} went from ${before} to ${after} (expected +${p.amountUnits}); the intents contract refunds a failed transfer to your betting balance` };
    }
    return { ok: true, txHashes, receivedUnits: (after - before).toString() };
  } catch (e) {
    return { ok: false, txHashes, detail: String((e as Error)?.message ?? e) };
  }
}

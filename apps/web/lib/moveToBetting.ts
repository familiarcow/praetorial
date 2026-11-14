// FE2c / D-FUND1 path (3): "Move to betting balance" -- funds already sitting in the user's NEAR account (wNEAR/USDC/USDT, or
// native NEAR) go into their Intents balance with a NEP-141 ft_transfer_call to the Intents contract (1 yocto). Native NEAR
// is wrapped first (near_deposit on the wNEAR contract). Pure builders + reads; signing/relaying is the caller's job.
import { gasForMethod } from "./relayGas";
import { intentsContractFor } from "./network";
import { needsUserSignedTx } from "./directTx";
import { assetId, findAsset, CURRENT_NETWORK, type NetworkId } from "./assets";
import { viewFunction, viewAccountBalanceYocto } from "./rpc";

export type MoveSource = "token" | "native";
export interface MoveStep { receiverId: string; methodName: string; args: Record<string, unknown>; depositYocto: string; gasTgas: number }
export interface Holding { symbol: string; source: MoveSource; amountUnits: string }

/** Assets that live on NEAR as a NEP-141 and so can be moved: wNEAR (shown as NEAR), USDC, USDT, and (F3, SM1 MON-3) the omft
 * BTC/ETH/ZEC tokens an older "Withdraw to wallet" left on the NEAR account (btc/eth/zec.omft.near are NEP-141s; the relayer's
 * FUND_TOKEN_CONTRACTS already sponsors ft_transfer_call on all 6). A token with no id on the network (BTC on testnet) is skipped. */
export const MOVABLE_SYMBOLS = ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"] as const;
/** Native NEAR kept back from a wrap so the account can still pay storage. */
export const NEAR_SPENDABLE_RESERVE_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

const tokenContract = (symbol: string, network: NetworkId): string => {
  const id = assetId(symbol, network);
  if (!id || !id.startsWith("nep141:")) throw new Error(`${symbol} has no NEAR token on ${network}`);
  return id.slice("nep141:".length);
};

export function buildMoveSteps(p: { symbol: string; account: string; amountUnits: string; source: MoveSource; network?: NetworkId }): MoveStep[] {
  const network = p.network ?? CURRENT_NETWORK;
  if (!(MOVABLE_SYMBOLS as readonly string[]).includes(p.symbol)) throw new Error(`${p.symbol} can't be moved from a NEAR account`);
  if (!/^\d+$/.test(p.amountUnits) || BigInt(p.amountUnits) === 0n) throw new Error("amount must be a positive whole number of base units");
  if (p.source === "native" && p.symbol !== "NEAR") throw new Error("only NEAR can be wrapped from the native balance");
  const token = tokenContract(p.symbol, network);
  const steps: MoveStep[] = [];
  if (p.source === "native") steps.push({ receiverId: token, methodName: "near_deposit", args: {}, depositYocto: p.amountUnits, gasTgas: gasForMethod("near_deposit") });
  steps.push({
    receiverId: token,
    methodName: "ft_transfer_call",
    args: { receiver_id: intentsContractFor(network), amount: p.amountUnits, msg: JSON.stringify({ receiver_id: p.account }) },
    depositYocto: "1",
    gasTgas: gasForMethod("ft_transfer_call"),
  });
  return steps;
}

type View = (contract: string, method: string, args: Record<string, unknown>) => Promise<string>;

/** Smallest native NEAR worth wrapping: wrap takes a 0.00125 NEAR storage fee on first use, so anything near that just burns. */
export const MIN_NATIVE_MOVE_YOCTO = 2_500_000_000_000_000_000_000n; // 0.0025 NEAR

export type NativeState = "ok" | "empty" | "too-small" | "unreadable";
export interface MovableReport {
  holdings: Holding[];
  /** Why native NEAR is (not) movable: the Add money screen explains it instead of silently hiding the section. */
  native: { state: NativeState; yocto: string };
  /** Symbols whose balance could not be read. One failed read never hides the others (FUND1). */
  readFailed: string[];
}

/** What the NEAR account holds of the movable launch assets, per-asset: a failed read of one asset (e.g. USDC) only marks that asset unreadable. */
export async function movableReport(
  account: string,
  network: NetworkId = CURRENT_NETWORK,
  view: View = (c, m, a) => viewFunction<string>(c, m, a),
  nativeYocto: (a: string) => Promise<bigint | null> = viewAccountBalanceYocto,
): Promise<MovableReport> {
  const rep: MovableReport = { holdings: [], native: { state: "empty", yocto: "0" }, readFailed: [] };
  const fail = (s: string) => { if (!rep.readFailed.includes(s)) rep.readFailed.push(s); };
  for (const symbol of MOVABLE_SYMBOLS) {
    if (!findAsset(symbol)?.ids[network]) continue;
    try {
      const token = tokenContract(symbol, network);
      const bal = BigInt(String((await view(token, "ft_balance_of", { account_id: account })) ?? "0"));
      if (bal > 0n) rep.holdings.push({ symbol, source: "token", amountUnits: bal.toString() });
    } catch { fail(symbol); }
    if (symbol === "NEAR") {
      try {
        const n = await nativeYocto(account);
        const have = n ?? 0n;
        const spendable = have > NEAR_SPENDABLE_RESERVE_YOCTO ? have - NEAR_SPENDABLE_RESERVE_YOCTO : 0n;
        rep.native = { state: have === 0n ? "empty" : spendable >= MIN_NATIVE_MOVE_YOCTO ? "ok" : "too-small", yocto: have.toString() };
        if (rep.native.state === "ok") rep.holdings.push({ symbol, source: "native", amountUnits: spendable.toString() });
      } catch { rep.native = { state: "unreadable", yocto: "0" }; fail("NEAR"); }
    }
  }
  return rep;
}

/** Holdings only (kept for callers that don't need the reasons). */
export async function movableHoldings(
  account: string,
  network: NetworkId = CURRENT_NETWORK,
  view: View = (c, m, a) => viewFunction<string>(c, m, a),
  nativeYocto: (a: string) => Promise<bigint | null> = viewAccountBalanceYocto,
): Promise<Holding[]> {
  return (await movableReport(account, network, view, nativeYocto)).holdings;
}

// ---------------------------------------------------------------------------------------------------------------------
// LIVE1: the move itself. Native NEAR is wrapped first; wrap.near/wrap.testnet take a storage fee out of the FIRST
// near_deposit (0.00125 NEAR), so the amount to transfer is the wNEAR balance READ after the deposit (this also sweeps
// any wNEAR already sitting in the wallet). Each relayed step only counts once its final transaction outcome (every
// receipt) is clean: the relayer's HTTP 200 only means "broadcast", not "worked".
export interface MoveRelayResult { ok: boolean; txHash?: string; error?: string; status?: "unknown"; resumed?: boolean }
export interface MoveDeps {
  relay(step: MoveStep): Promise<MoveRelayResult>;
  /** RELAYDEP1 / D-RELAYDEP1: a transaction the USER signs and pays (carries their NEAR as a deposit). Never the relayer. */
  direct(step: MoveStep): Promise<MoveRelayResult>;
  view: View;
  /** Final outcome of a relayed tx: the failure text of any failed receipt, or null when it succeeded. */
  txFailure(txHash: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
}
export type MoveResult = { ok: true; txHashes: string[]; movedUnits: string } | { ok: false; txHashes: string[]; detail: string; pending?: boolean };

export async function runMove(
  h: Pick<Holding, "symbol" | "source" | "amountUnits">,
  account: string,
  deps: MoveDeps,
  network: NetworkId = CURRENT_NETWORK,
): Promise<MoveResult> {
  const txHashes: string[] = [];
  let pending = false; // SEC1/MON-2: a step's outcome is unknown -> "checking", never "failed"
  const steps = buildMoveSteps({ symbol: h.symbol, account, amountUnits: h.amountUnits, source: h.source, network });
  const send = async (step: MoveStep): Promise<string | null> => {
    const r = needsUserSignedTx(step.methodName, BigInt(step.depositYocto)) ? await deps.direct(step) : await deps.relay(step);
    if (r.txHash) txHashes.push(r.txHash);
    if (r.status === "unknown") { pending = true; return r.error ?? "checking whether it went through"; }
    if (!r.ok) return r.error ?? "the transaction was refused";
    if (!r.txHash) return "no transaction hash came back";
    const failure = await deps.txFailure(r.txHash);
    return failure ? `the transaction failed on chain: ${failure}` : null;
  };
  const token = steps[steps.length - 1].receiverId;
  const readBalance = async (): Promise<bigint> => BigInt(String((await deps.view(token, "ft_balance_of", { account_id: account })) ?? "0"));
  try {
    if (h.source === "native") {
      const err = await send(steps[0]);
      if (err) return { ok: false, txHashes, detail: err, ...(pending ? { pending } : {}) };
    }
    let bal = await readBalance();
    for (let i = 0; bal === 0n && h.source === "native" && i < 5; i++) { await deps.sleep(1000); bal = await readBalance(); }
    if (bal === 0n) return { ok: false, txHashes, detail: `no ${h.symbol} to move: the wallet's token balance is 0` };
    const transfer = { ...steps[steps.length - 1], args: { ...steps[steps.length - 1].args, amount: bal.toString() } };
    const err = await send(transfer);
    if (err) return { ok: false, txHashes, detail: err, ...(pending ? { pending } : {}) };
    return { ok: true, txHashes, movedUnits: bal.toString() };
  } catch (e) {
    return { ok: false, txHashes, detail: String((e as Error)?.message ?? e) };
  }
}

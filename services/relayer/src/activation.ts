// FUND2: implicit-account activation. A user funded only through a deposit address (mainnet D-FUND1 path 2) holds a betting
// balance on intents.near under their implicit id while that NEAR account does not exist on chain: no access key, so no
// meta-transaction (open/take/withdraw) can be signed for it. The relayer creates the account with one small NEAR transfer
// (an implicit account is created by the first transfer to it; its full-access key is the id itself).
// Gate: 64-hex implicit id only, account must not exist yet, and it must already hold at least one stakeable asset's minimum
// stake (escrow asset_limit.min_per_side) on the intents contract (SEC1/MON-9: a 1-base-unit balance used to buy 0.002 NEAR).
// Each id is claimed in the guard store before the transfer, so two concurrent calls never both pay (the second is told
// "in progress" and polls for the account like the first). The transfer and its gas are
// charged to the user's daily budget and the global cap like any relayed call. ACTIVATION_YOCTO=0 switches it off.
import { PolicyViolation, stakeAssetSet, type RelayerPolicyConfig } from "./policy.js";
import type { BroadcastResult, GuardsLike } from "./relayerCore.js";
import { OutcomeUnknown } from "./relayerErrors.js";

/** SEC1/MON-9: one activation per id at a time (and none again within the claim TTL, while account views may lag). */
export interface ActivationClaims {
  /** true = this caller owns the activation; false = another one is in progress or was just sent. */
  claimActivation(accountId: string): boolean;
  /** Frees the claim (the transfer never reached the chain). */
  releaseActivation(accountId: string): void;
}

/** 0.002 NEAR: the 182-byte implicit account's storage (0.00182 NEAR) plus headroom for 1-yocto stake deposits. */
export const DEFAULT_ACTIVATION_YOCTO = 2_000_000_000_000_000_000_000n;
export const IMPLICIT_ID = /^[0-9a-f]{64}$/;

export interface ActivationPorts {
  accountExists(accountId: string): Promise<boolean>;
  intentsBalance(accountId: string, tokenId: string): Promise<bigint>;
  /** SEC1/MON-9: the escrow's min stake per side for this asset id (asset_limit view); null = no limit readable -> never qualifies. */
  minStake(tokenId: string): Promise<bigint | null>;
  /** Relayer-signed NEAR transfer; throws like broadcastSignedDelegate (with transaction_outcome when it executed and failed). */
  transfer(receiverId: string, yocto: bigint): Promise<BroadcastResult>;
}

export async function activateImplicitAccount(p: {
  accountId: string;
  cfg: RelayerPolicyConfig & { perCallSponsorshipYocto: bigint };
  activationYocto: bigint;
  ports: ActivationPorts;
  guards: Pick<GuardsLike, "checkRateLimit" | "reserveBudget" | "settleBudget" | "releaseBudget"> & ActivationClaims;
}): Promise<{ activated: boolean; txHash: string | null; inProgress?: true }> {
  const { accountId, cfg, activationYocto, ports, guards } = p;
  if (activationYocto <= 0n) throw new PolicyViolation("account activation is off on this relayer");
  if (!IMPLICIT_ID.test(String(accountId ?? ""))) throw new PolicyViolation("only a 64-hex implicit account can be activated");
  if (await ports.accountExists(accountId)) return { activated: false, txHash: null };
  const assets = [...stakeAssetSet(cfg)];
  const balances = await Promise.all(assets.map((t) => ports.intentsBalance(accountId, t)));
  if (!balances.some((b) => b > 0n)) {
    throw new PolicyViolation("this account has no betting balance yet; add money first, then try again");
  }
  // Only the assets actually held are checked against their limit (keeps the view count low).
  let qualifies = false;
  for (let i = 0; i < assets.length && !qualifies; i++) {
    if (balances[i] <= 0n) continue;
    const min = await ports.minStake(assets[i]).catch(() => null);
    qualifies = min !== null && min > 0n && balances[i] >= min;
  }
  if (!qualifies) {
    throw new PolicyViolation("your betting balance is below the minimum stake; add at least one minimum stake first, then try again");
  }
  guards.checkRateLimit(accountId);
  if (!guards.claimActivation(accountId)) return { activated: false, txHash: null, inProgress: true };
  const hold = activationYocto + cfg.perCallSponsorshipYocto;
  let reservationId: number;
  try {
    ({ reservationId } = guards.reserveBudget(accountId, hold));
  } catch (err) {
    guards.releaseActivation(accountId);
    throw err;
  }
  let r: BroadcastResult;
  try {
    r = await ports.transfer(accountId, activationYocto);
  } catch (err) {
    if (err instanceof OutcomeUnknown) {
      // SEC1/MON-2: sent, outcome not known: it may land. Charge the hold and keep the claim (no second transfer within its
      // TTL); the client polls for the account exactly as after a success.
      guards.settleBudget(accountId, reservationId, hold);
      return { activated: false, txHash: err.txHash, inProgress: true };
    }
    if ((err as any)?.transaction_outcome) guards.settleBudget(accountId, reservationId, hold);
    else { guards.releaseBudget(accountId, reservationId); guards.releaseActivation(accountId); }
    throw err;
  }
  guards.settleBudget(accountId, reservationId, activationYocto + r.actualCostYocto);
  return { activated: true, txHash: r.transactionHash };
}

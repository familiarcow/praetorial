// The real NEP-366 meta-transaction relayer (node host). The pipeline itself lives in relayerCore.ts and is
// shared with the Cloudflare Worker (workers/relayer); this file wires the node-bound parts: tweetnacl/node:crypto
// delegate verification, SQLite (node:sqlite) guards, and near-api-js broadcast.
import { actionCreators, Signature, type DelegateAction } from "@near-js/transactions";
import { decodeSignedDelegate, verifySignedDelegate, BadSignedDelegate } from "./delegate.js";
import { PolicyViolation } from "./policy.js";
import { Guards, GuardViolation, GlobalCapViolation } from "./guards.js";
import type { GlobalBudgetStatus } from "./guardStore.js";
import type { BettorLookup } from "./bettor.js";
import type { NearClient } from "@praetorial/common/nearClient.js";
import { RelayerCore, sumTokensBurnt, type ChainPort, type BroadcastResult, type RelayerConfig } from "./relayerCore.js";

export { BadSignedDelegate, PolicyViolation, GuardViolation, GlobalCapViolation, sumTokensBurnt };
export type { ChainPort, BroadcastResult, RelayerConfig };

export function chainPortFromClient(client: NearClient): ChainPort {
  // RELAYFUND2: @near-js/accounts caches the access key and never bumps the cached nonce, and the paced provider
  // throws untyped Errors (so its own InvalidNonce retry never fires). Own the relayer-key nonce here: serialize
  // broadcasts (one in flight per key), seed the cache with max(chain nonce, last nonce we used), and on
  // InvalidNonce drop the cache, refetch and retry exactly once.
  let tail: Promise<unknown> = Promise.resolve();
  let lastNonce = 0n;
  const isInvalidNonce = (e: any) => e?.type === "InvalidNonce" || /InvalidNonce/.test(String(e?.message ?? "") + JSON.stringify(e?.kind ?? e?.cause ?? ""));
  async function sendOnce(outerAction: any, receiverId: string): Promise<{ result: any; nonce: bigint }> {
    const account: any = (client as any).account;
    const pk = await account.connection.signer.getPublicKey(account.accountId, account.connection.networkId);
    const key = pk.toString();
    delete account.accessKeyByPublicKeyCache[key]; // force a fresh (optimistic) read of the chain nonce
    const info = await account.findAccessKey(receiverId, [outerAction]);
    if (info?.accessKey && info.accessKey.nonce < lastNonce) info.accessKey.nonce = lastNonce; // cached object is the one signTransaction reads
    const nonce = BigInt(info?.accessKey?.nonce ?? 0) + 1n;
    const result = await account.signAndSendTransaction({ receiverId, actions: [outerAction] });
    return { result, nonce };
  }
  async function send(outerAction: any, receiverId: string): Promise<any> {
    let out;
    try {
      out = await sendOnce(outerAction, receiverId);
    } catch (e) {
      if (!isInvalidNonce(e)) throw e;
      out = await sendOnce(outerAction, receiverId); // refetch on InvalidNonce, once
    }
    if (out.nonce > lastNonce) lastNonce = out.nonce;
    return out.result;
  }
  return {
    async currentBlockHeight(): Promise<bigint> {
      const info: any = await (client as any).account.connection.provider.block({ finality: "final" });
      return BigInt(info.header.height);
    },
    broadcastSignedDelegate(delegateAction: DelegateAction, signatureBytes: Uint8Array): Promise<BroadcastResult> {
      const sig = new Signature({ keyType: 0, data: signatureBytes });
      const outerAction = actionCreators.signedDelegate({ delegateAction, signature: sig as any });
      // NEP-366: the outer tx's receiverId must be the delegate's own senderId -- the runtime then executes
      // delegateAction.actions as if originating from that account against delegateAction.receiverId.
      const run = tail.then(() => send(outerAction, delegateAction.senderId));
      tail = run.catch(() => undefined);
      return run.then((result: any) => ({ transactionHash: result?.transaction?.hash ?? result?.transaction_outcome?.id, actualCostYocto: sumTokensBurnt(result), raw: result }));
    },
  };
}

export class Relayer {
  private guards: Guards;
  private ownsGuards: boolean;
  private core: RelayerCore;
  /** `deps.bettorLookup`: does this account have a bet on the escrow (maker/taker)? Absent => nobody is a bettor. */
  constructor(chain: ChainPort, cfg: RelayerConfig, guards?: Guards, deps: { bettorLookup?: BettorLookup } = {}) {
    this.ownsGuards = !guards;
    // No dbPath given => in-memory (tests only). The real runner always passes RELAYER_GUARD_DB_PATH explicitly.
    this.guards = guards ?? new Guards(cfg, cfg.guardDbPath ?? ":memory:");
    this.core = new RelayerCore({ decode: decodeSignedDelegate, verify: verifySignedDelegate }, chain, cfg, this.guards, deps.bettorLookup);
  }

  /** Relayer-wide spend vs global cap (feeds GET /budget/global -> monitor). */
  globalBudgetStatus(): GlobalBudgetStatus { return this.core.globalBudgetStatus(); }

  /** Releases the underlying SQLite connection, if this Relayer created it itself. */
  close(): void { if (this.ownsGuards) this.guards.close(); }

  relay(signedDelegateBase64: string): Promise<{ txHash: string; receiptFailure?: string }> { return this.core.relay(signedDelegateBase64); }
}

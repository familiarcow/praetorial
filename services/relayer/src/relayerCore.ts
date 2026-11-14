// Host-neutral core of the real NEP-366 meta-transaction relayer (no node:*, no Buffer; see RelayerCore below).
// The real NEP-366 meta-transaction relayer. Replaces the old
// signer==sender mock (see git history / README "what this replaces").
//
// Flow: a user signs a DelegateAction with their OWN key (in the real
// app, via Privy signRawHash in the browser -- D-PRIVY1) and sends us the
// borsh-encoded, base64 SignedDelegateAction. We never see or hold that
// key. We independently verify the signature, enforce an allowlist/caps/
// rate-limits/budget/replay (our code is the policy -- the signer's
// wallet provider can't inspect NEAR tx content, same reasoning as
// services/privy-e2e/lib/signerPolicy.ts), then wrap it in our OWN
// NEAR transaction (an outer `signedDelegate` action addressed to the
// delegate's senderId, per NEP-366) and broadcast it. Our key pays gas
// only; it can never move user funds (same trust boundary as the module
// doc this file replaces).
import type { DelegateAction } from "@near-js/transactions";
import { BadSignedDelegate, OutcomeUnknown } from "./relayerErrors.js";
import { assertAllowedCall, assertValidAccountId, PolicyViolation, type RelayerPolicyConfig } from "./policy.js";
import { GuardViolation, GlobalCapViolation, type GuardStoreConfig as GuardsConfig, type GlobalBudgetStatus, type Submission, type SubmissionState } from "./guardStoreCore.js";
import { makeBettorChecker, type BettorLookup } from "./bettor.js";

export { BadSignedDelegate, PolicyViolation, GuardViolation, GlobalCapViolation, OutcomeUnknown };

/** SEC1 / MON-2: what one relay request ended as. `status: "unknown"` = handed to the chain, outcome not known yet (never "failed"). */
export interface RelayOutcome { txHash: string; receiptFailure?: string; status?: "unknown" }
/** SEC1 / MON-2: the resolved state of a relayed delegate (POST /relay/status). */
export type SubmissionStatus =
  | { state: "executed"; txHash: string }
  | { state: "failed"; txHash: string; receiptFailure?: string }
  | { state: "pending"; txHash: string }
  | { state: "not_executed"; txHash: string }
  | { state: "not_found" };
/** A row still "sending" after this long was orphaned (DO evicted / redeployed mid-send): treat it as outcome unknown. */
export const ORPHANED_SENDING_MS = 60_000;

export interface RelayerConfig extends RelayerPolicyConfig, GuardsConfig {
  maxBlockHeightFuture: bigint; // a delegate's maxBlockHeight may not be more than this many blocks past the current height (bounds our open relay window)
  perCallSponsorshipYocto: bigint; // flat estimated gas cost reserved against the sender's daily budget up front, settled to actual burnt cost after broadcast
  bettorCacheTtlMs?: number; // D-RLY1: how long a bettor/non-bettor answer is cached (default 60s)
  replayStaleMs?: number; // LIVE1: a replay mark older than this whose nonce never reached the chain is stale (default 120s)
  bettorLookupTimeoutMs?: number; // D-RLY1: lookup timeout; timeout => treated as NOT a bettor (default 2s)
  guardDbPath?: string; // SQLite file for persistent guard state (nonces/rate-limit/budget); defaults to ":memory:" (no persistence -- tests only, never for the real runner)
}

export interface BroadcastResult {
  transactionHash: string;
  /** Real total cost burnt by this meta-tx: the outer signedDelegate
   * wrapper's own transaction_outcome.tokens_burnt plus every receipt in
   * receipts_outcome[].tokens_burnt (the inner FunctionCall receipt(s)
   * it fans out to). This is what the relayer key actually paid in gas
   * for this call, in yoctoNEAR -- not an estimate. */
  actualCostYocto: bigint;
  raw: unknown;
}

/** Everything the Relayer needs from the chain, injected so unit tests
 * never touch the network. The real runner wires these to `client`. */
export interface ChainPort {
  currentBlockHeight(): Promise<bigint>;
  /** `hooks.onSigned(txHash)` is called with the outer tx hash right BEFORE each send_tx (SEC1/MON-2). Throws OutcomeUnknown when
   * the tx was handed to the RPC without an outcome; a plain Error only when nothing was sent. */
  broadcastSignedDelegate(delegateAction: DelegateAction, signatureBytes: Uint8Array, hooks?: { onSigned?(txHash: string): void }): Promise<BroadcastResult>;
  /** SEC1/MON-2: the executed outcome of an outer tx we signed (null = the chain does not know it). Throws when it can't tell. */
  txStatus?(txHash: string): Promise<any | null>;
  /** LIVE1: the sender's on-chain nonce for this ed25519 key (null = key/account not found). Optional; without it a
   * replay mark is never treated as stale. */
  senderKeyNonce?(accountId: string, publicKeyEd25519: Uint8Array): Promise<bigint | null>;
  /** SECREV1 SR-7: is this key an access key of the account (false = the key or the account does not exist)? */
  accessKeyExists?(accountId: string, publicKeyEd25519: Uint8Array): Promise<boolean>;
}

/** Sums tokens_burnt (yoctoNEAR, decimal string per NEAR RPC) across the
 * outer transaction_outcome and every receipts_outcome entry -- the full
 * real cost of a signAndSendTransaction call, including every receipt it
 * fanned out to (the outer signedDelegate wrapper + the inner delegated
 * FunctionCall(s)). Missing/malformed fields are treated as 0 rather
 * than thrown, so a shape we didn't anticipate degrades to "charge
 * nothing extra" instead of breaking the broadcast path post-hoc. */
export function sumTokensBurnt(result: any): bigint {
  let total = 0n;
  const addFrom = (outcomeWrapper: any) => {
    const burnt = outcomeWrapper?.outcome?.tokens_burnt;
    if (typeof burnt === "string" && /^\d+$/.test(burnt)) total += BigInt(burnt);
  };
  addFrom(result?.transaction_outcome);
  for (const r of result?.receipts_outcome ?? []) addFrom(r);
  return total;
}

/** LIVE1 2b: the first failed receipt in a send_tx/tx result, as a short human string (or undefined). A meta-tx's
 * outer status is SuccessValue even when the user's inner call panicked, so the receipts must be checked. */
export function firstReceiptFailure(result: any): string | undefined {
  const fmt = (f: any): string => {
    const exec = f?.ActionError?.kind?.FunctionCallError?.ExecutionError;
    if (typeof exec === "string") return exec;
    return JSON.stringify(f);
  };
  if (result?.status?.Failure) return fmt(result.status.Failure);
  for (const r of result?.receipts_outcome ?? []) {
    const f = r?.outcome?.status?.Failure;
    if (f) return `${r?.outcome?.executor_id ?? "receipt"}: ${fmt(f)}`;
  }
  return undefined;
}

function singleFunctionCall(delegateAction: DelegateAction): { methodName: string; args: Uint8Array; deposit: bigint } {
  if (!delegateAction.actions || delegateAction.actions.length !== 1) {
    throw new PolicyViolation(
      `delegate must contain exactly one action, got ${delegateAction.actions?.length ?? 0}`,
    );
  }
  const action: any = delegateAction.actions[0];
  // near-api-js/@near-js Action is an Enum wrapper; functionCall is the
  // only variant this relayer will ever sponsor (no Transfer, DeleteKey,
  // AddKey, Stake, DeployContract, CreateAccount, DeleteAccount -- none
  // of those are legitimate "take a bet action" shapes and every one of
  // them is a value/key-custody risk if sponsored blindly).
  const fc = action.functionCall ?? (action.enum === "functionCall" ? action[action.enum] : undefined);
  if (!fc) {
    throw new PolicyViolation(`only FunctionCall actions may be relayed (got "${action.enum ?? "unknown"}")`);
  }
  return { methodName: fc.methodName, args: fc.args, deposit: BigInt(fc.deposit ?? 0) };
}

/** The guard operations the pipeline needs; GuardStoreCore (any SqlDriver) and the node `Guards` both satisfy it. */
export interface GuardsLike {
  checkRateLimit(userId: string): void;
  checkAndMarkReplay(senderId: string, publicKey: string, nonce: bigint): void;
  releaseReplay(senderId: string, publicKey: string, nonce: bigint): void;
  replayMarkedAt(senderId: string, publicKey: string, nonce: bigint): number | undefined;
  reserveBudget(userId: string, estimateYocto: bigint, opts?: { isBettor?: boolean }): { reservationId: number };
  settleBudget(userId: string, reservationId: number, actualYocto: bigint): void;
  releaseBudget(userId: string, reservationId: number): void;
  globalBudgetStatus(): GlobalBudgetStatus;
  recordSending(r: { senderId: string; publicKey: string; nonce: bigint; txHash: string; reservationId: number; depositYocto: bigint; holdYocto: bigint; maxBlockHeight: bigint }): void;
  setSubmissionState(senderId: string, publicKey: string, nonce: bigint, state: SubmissionState, receiptFailure?: string): void;
  submission(by: { txHash: string } | { senderId: string; nonce: bigint; publicKey?: string }): Submission | undefined;
  openSubmissions(idleMs: number, limit: number): Submission[];
}

export interface DecodedLike {
  delegateAction: DelegateAction;
  signatureBytes: Uint8Array;
}

/** Host-neutral relay pipeline shared by the node relayer (relayer.ts) and the CF1b Worker: decode/verify are
 * injected (node: tweetnacl + node:crypto; Worker: WebCrypto), everything else -- policy, expiry window, rate
 * limit, budget + global cap + bettor reserve, replay, broadcast, settle/release -- is this one implementation. */
export class RelayerCore {
  private isBettor: BettorLookup;
  constructor(
    private deps: { decode(b64: string): DecodedLike; verify(d: DecodedLike): boolean | Promise<boolean> },
    private chain: ChainPort,
    private cfg: RelayerConfig,
    private guards: GuardsLike,
    bettorLookup?: BettorLookup,
  ) {
    this.isBettor = bettorLookup ? makeBettorChecker(bettorLookup, { ttlMs: cfg.bettorCacheTtlMs, timeoutMs: cfg.bettorLookupTimeoutMs }) : async () => false;
  }

  globalBudgetStatus(): GlobalBudgetStatus {
    return this.guards.globalBudgetStatus();
  }

  private async staleReplay(senderId: string, publicKeyStr: string, pk: any, nonce: bigint): Promise<boolean> {
    if (!this.chain.senderKeyNonce) return false;
    const at = this.guards.replayMarkedAt(senderId, publicKeyStr, nonce);
    if (at === undefined || Date.now() - at < (this.cfg.replayStaleMs ?? 120_000)) return false;
    try {
      const chainNonce = await this.chain.senderKeyNonce(senderId, Uint8Array.from(pk.ed25519Key?.data ?? pk.data ?? []));
      return chainNonce !== null && chainNonce < nonce;
    } catch {
      return false; // can't tell -> fail closed (still a replay)
    }
  }

  /** SEC1 / MON-2 / MON-10: settle a submission whose outcome was unknown (or orphaned mid-send). executed/failed: charge
   * what the chain says; not_executed (delegate expired AND its nonce never used): release the budget hold and the replay
   * mark; otherwise it stays pending. Never throws for a chain read error (that is "pending"). */
  async resolveSubmission(sub: Submission): Promise<SubmissionStatus> {
    const { senderId, publicKey, nonce, txHash } = sub;
    if (sub.state === "executed") return { state: "executed", txHash };
    if (sub.state === "failed") return { state: "failed", txHash, receiptFailure: sub.receiptFailure };
    if (sub.state === "not_executed") return { state: "not_executed", txHash };
    if (sub.state === "superseded") return { state: "pending", txHash };
    if (sub.state === "sending" && Date.now() - sub.updatedAtMs < ORPHANED_SENDING_MS) return { state: "pending", txHash };
    let out: any | null;
    try {
      out = this.chain.txStatus ? await this.chain.txStatus(txHash) : undefined;
    } catch {
      return { state: "pending", txHash };
    }
    if (out) {
      if (out?.status?.Failure) {
        this.guards.settleBudget(senderId, sub.reservationId, sub.holdYocto);
        const rf = firstReceiptFailure(out);
        this.guards.setSubmissionState(senderId, publicKey, nonce, "failed", rf);
        return { state: "failed", txHash, receiptFailure: rf };
      }
      this.guards.settleBudget(senderId, sub.reservationId, sumTokensBurnt(out) + sub.depositYocto);
      const rf = firstReceiptFailure(out);
      this.guards.setSubmissionState(senderId, publicKey, nonce, rf ? "failed" : "executed", rf);
      return rf ? { state: "failed", txHash, receiptFailure: rf } : { state: "executed", txHash };
    }
    if (out === undefined || !this.chain.senderKeyNonce) return { state: "pending", txHash };
    try {
      const height = await this.chain.currentBlockHeight();
      if (height <= sub.maxBlockHeight) return { state: "pending", txHash };
      const keyBytes = Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0));
      const chainNonce = await this.chain.senderKeyNonce(senderId, keyBytes);
      if (chainNonce !== null && chainNonce >= nonce) return { state: "pending", txHash }; // nonce used: it (or a twin) ran; tx lookup will show it
    } catch {
      return { state: "pending", txHash };
    }
    // The delegate can no longer execute (past its maxBlockHeight) and never did (nonce unused): nothing happened.
    this.guards.releaseBudget(senderId, sub.reservationId);
    this.guards.releaseReplay(senderId, publicKey, nonce);
    this.guards.setSubmissionState(senderId, publicKey, nonce, "not_executed");
    return { state: "not_executed", txHash };
  }

  /** POST /relay/status: look a submission up by tx hash or (sender, nonce) and resolve it. */
  async status(by: { txHash: string } | { senderId: string; nonce: bigint }): Promise<SubmissionStatus> {
    const sub = this.guards.submission(by);
    return sub ? this.resolveSubmission(sub) : { state: "not_found" };
  }

  /** MON-10 heartbeat sweep: resolve a few idle unresolved submissions so orphaned holds/marks don't wait for the 24h rollover. */
  async sweep(limit = 3, idleMs = ORPHANED_SENDING_MS): Promise<number> {
    let n = 0;
    for (const sub of this.guards.openSubmissions(idleMs, limit)) {
      const r = await this.resolveSubmission(sub);
      if (r.state !== "pending") n++;
    }
    return n;
  }

  /** Validates and relays one base64 borsh SignedDelegateAction. Returns
   * the broadcast transaction hash on success, or `status: "unknown"` with the
   * hash when it was handed to the chain without an outcome (SEC1/MON-2). Throws
   * BadSignedDelegate / PolicyViolation / GuardViolation (all caller-facing 4xx
   * reasons) or a plain Error for failures where nothing executed. */
  async relay(signedDelegateBase64: string): Promise<RelayOutcome> {
    const decoded = this.deps.decode(signedDelegateBase64);
    if (!(await this.deps.verify(decoded))) {
      throw new BadSignedDelegate("signature does not verify against the delegate action");
    }
    const { delegateAction } = decoded;
    const senderId = delegateAction.senderId;

    assertValidAccountId(senderId, "delegate senderId");
    const { methodName, args, deposit } = singleFunctionCall(delegateAction);
    assertAllowedCall(this.cfg, delegateAction.receiverId, methodName, args, deposit, senderId);

    const currentHeight = await this.chain.currentBlockHeight();
    if (delegateAction.maxBlockHeight <= currentHeight) {
      throw new PolicyViolation(
        `delegate expired: maxBlockHeight ${delegateAction.maxBlockHeight} <= current height ${currentHeight}`,
      );
    }
    if (delegateAction.maxBlockHeight > currentHeight + this.cfg.maxBlockHeightFuture) {
      throw new PolicyViolation(
        `delegate maxBlockHeight ${delegateAction.maxBlockHeight} too far in the future (current ${currentHeight}, max window ${this.cfg.maxBlockHeightFuture})`,
      );
    }

    // Borsh-deserialized PublicKey comes back as a plain `{ ed25519Key:
    // { data } }` object (no working .toString()), so key off the raw
    // bytes directly rather than relying on a class method.
    const pk: any = delegateAction.publicKey;
    const publicKeyStr = btoa(String.fromCharCode(...Uint8Array.from(pk.ed25519Key?.data ?? pk.data ?? [])));

    // SEC1 / MON-2: this exact delegate was sent before and its outcome was unknown. Answer from the chain instead of
    // refusing it as a replay: executed/failed -> the earlier result (idempotent); not executed -> relay it normally;
    // still unknown -> send it again (safe: the chain runs a delegate nonce at most once), superseding the old row.
    const prior = this.guards.submission({ senderId, publicKey: publicKeyStr, nonce: delegateAction.nonce });
    const unresolved = prior && (prior.state === "submitted" || (prior.state === "sending" && Date.now() - prior.updatedAtMs >= ORPHANED_SENDING_MS));
    if (prior && (unresolved || (prior.wasUnknown && (prior.state === "executed" || prior.state === "failed")))) {
      const r = await this.resolveSubmission(prior);
      if (r.state === "executed") return { txHash: r.txHash };
      if (r.state === "failed") return { txHash: r.txHash, receiptFailure: r.receiptFailure ?? "the transaction failed on chain" };
      if (r.state === "pending") {
        // the old outer tx may still land and burn gas: charge its hold, then take the slot for a fresh broadcast
        this.guards.settleBudget(senderId, prior.reservationId, prior.holdYocto);
        this.guards.setSubmissionState(senderId, publicKeyStr, delegateAction.nonce, "superseded");
        this.guards.releaseReplay(senderId, publicKeyStr, delegateAction.nonce);
      }
    }

    this.guards.checkRateLimit(senderId);
    // Reserve the flat per-call estimate against the user's daily budget
    // up front -- the real cost isn't known until the chain returns an
    // outcome, so this is a conservative hold, not the final charge.
    // D-RLY1: the same transaction also takes the hold from the GLOBAL cap
    // (open share for anyone; bettor-only reserve once the open share is
    // spent). The bettor lookup only happens when the open share is
    // exhausted AND the reserve could still serve this request.
    // SEC1/MON-1: the relayer (outer signer) pays the inner action's attached deposit too, so it is part of the hold and of
    // the settled cost, on the per-user budget and the global cap alike (policy keeps it at <= 1 yocto today).
    const hold = this.cfg.perCallSponsorshipYocto + deposit;
    let reservationId: number;
    try {
      ({ reservationId } = this.guards.reserveBudget(senderId, hold));
    } catch (err) {
      if (!(err instanceof GlobalCapViolation) || !err.reserveAvailable) throw err;
      if (!(await this.isBettor(senderId))) throw err;
      ({ reservationId } = this.guards.reserveBudget(senderId, hold, { isBettor: true }));
    }
    // Replay check last, and only marked seen once every other guard has
    // passed, so a rejected request never burns the sender's nonce slot.
    try {
      try {
        this.guards.checkAndMarkReplay(senderId, publicKeyStr, delegateAction.nonce);
      } catch (err) {
        // LIVE1: a mark older than the broadcast window whose nonce never reached the chain belongs to an attempt that
        // did not execute (or whose delegate was refused before consuming the nonce): clear it and take the slot.
        // A fresh mark (a concurrent double-submit) is never second-guessed, so the replay race guard is unchanged.
        if (!(err instanceof GuardViolation) || !(await this.staleReplay(senderId, publicKeyStr, pk, delegateAction.nonce))) throw err;
        this.guards.releaseReplay(senderId, publicKeyStr, delegateAction.nonce);
        this.guards.checkAndMarkReplay(senderId, publicKeyStr, delegateAction.nonce);
      }
      // SECREV1 SR-7: never pay for a delegate the chain will refuse because the key is not the sender's (throwaway ids drained the
      // global budget). An RPC error fails open: a flaky RPC must not block real users (the per-sender and global caps still apply).
      if (this.chain.accessKeyExists) {
        let exists = true;
        try { exists = await this.chain.accessKeyExists(senderId, Uint8Array.from(pk.ed25519Key?.data ?? pk.data ?? [])); } catch { exists = true; }
        if (!exists) {
          this.guards.releaseReplay(senderId, publicKeyStr, delegateAction.nonce);
          throw new PolicyViolation(`the signing key is not an access key of ${senderId} (or the account does not exist yet)`);
        }
      }
    } catch (err) {
      this.guards.releaseBudget(senderId, reservationId); // never broadcast -> release the hold, don't charge it
      throw err;
    }

    const nonce = delegateAction.nonce;
    let result: BroadcastResult;
    try {
      result = await this.chain.broadcastSignedDelegate(delegateAction, decoded.signatureBytes, {
        // MON-10: the row exists before send_tx, so even an eviction mid-await leaves a resolvable record.
        onSigned: (txHash) => this.guards.recordSending({ senderId, publicKey: publicKeyStr, nonce, txHash, reservationId, depositYocto: deposit, holdYocto: hold, maxBlockHeight: delegateAction.maxBlockHeight }),
      });
    } catch (err) {
      if (err instanceof OutcomeUnknown) {
        // SEC1 / MON-2: the tx is in the RPC's hands and may execute. Keep the replay mark and the budget hold, record it as
        // submitted, and tell the client "unknown" with the hash -- never "failed" (a retry would sign a second action).
        this.guards.setSubmissionState(senderId, publicKeyStr, nonce, "submitted");
        return { txHash: err.txHash, status: "unknown" };
      }
      if ((err as any)?.transaction_outcome) {
        // near-api-js throws (ServerTransactionError) when the tx EXECUTED
        // but failed (gas already burnt). That is real relayer spend: charge
        // the sender's budget the full reservation instead of refunding, or a
        // failing-on-chain delegate is free gas griefing.
        this.guards.settleBudget(senderId, reservationId, hold);
        this.guards.setSubmissionState(senderId, publicKeyStr, nonce, "failed", String((err as any)?.message ?? "").slice(0, 300));
      } else {
        // Nothing was sent (the chain port throws OutcomeUnknown for anything handed to the RPC): release the hold and the
        // replay key, so the user's retry of the same nonce is not refused as a replay forever (LIVE1).
        this.guards.releaseBudget(senderId, reservationId);
        this.guards.releaseReplay(senderId, publicKeyStr, nonce);
        this.guards.setSubmissionState(senderId, publicKeyStr, nonce, "not_executed");
      }
      throw err;
    }
    // Settle the reservation to the real burnt cost now that the chain
    // told us what this call actually spent -- the user's budget is
    // charged actual usage, not the flat estimate, going forward.
    this.guards.settleBudget(senderId, reservationId, result.actualCostYocto + deposit);
    const receiptFailure = firstReceiptFailure(result.raw);
    this.guards.setSubmissionState(senderId, publicKeyStr, nonce, receiptFailure ? "failed" : "executed", receiptFailure);
    return receiptFailure ? { txHash: result.transactionHash, receiptFailure } : { txHash: result.transactionHash };
  }
}

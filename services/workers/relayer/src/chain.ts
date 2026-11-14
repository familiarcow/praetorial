// ChainPort for the Worker: block height + the NEP-366 outer transaction, signed with WebCrypto Ed25519 and
// sent over plain JSON-RPC (no near-api-js). The outer tx is one `signedDelegate` action addressed to the
// delegate's senderId; the relayer key pays gas only. Bytes are tested identical to near-api-js.
import { BorshWriter, base58Decode, base64Encode } from "../../common/src/bytes.js";
import { parseNearSecretKey, ed25519Key, base58Encode, type JsonRpc } from "../../common/src/nearWebClient.js";
import type { ChainPort, BroadcastResult } from "../../../relayer/src/relayerCore.js";
import { sumTokensBurnt } from "../../../relayer/src/relayerCore.js";
import { OutcomeUnknown } from "../../../relayer/src/relayerErrors.js";

/** SEC1/MON-2: the NEAR tx hash (base58 sha256 of the borsh Transaction) of a borsh SignedTransaction = tx || 0u8 || sig[64]. */
export async function signedTxHash(signed: Uint8Array): Promise<string> {
  const tx = signed.slice(0, signed.length - 65);
  return base58Encode(new Uint8Array(await crypto.subtle.digest("SHA-256", tx as Uint8Array<ArrayBuffer>)));
}

/** send_tx errors that prove the tx was NOT accepted (the RPC validated and refused it). Anything else may have executed. */
const REFUSED_TX = /INVALID_TRANSACTION|InvalidNonce|InvalidTxError|Expired|NotEnoughBalance|InvalidSignature|PARSE_ERROR|REQUEST_VALIDATION_ERROR/;

/** Borsh SignedTransaction: [signedDelegate] action whose payload is the already-borsh SignedDelegateAction bytes. */
export async function buildOuterDelegateTx(i: { signerId: string; secretKey: string; nonce: bigint; receiverId: string; blockHash: string; signedDelegateBytes: Uint8Array }): Promise<Uint8Array> {
  const { seed, pub } = parseNearSecretKey(i.secretKey);
  if (pub.length !== 32) throw new Error("private key must carry the public key (64-byte form)");
  const tx = new BorshWriter().string(i.signerId).u8(0).fixed(pub).u64(i.nonce).string(i.receiverId).fixed(base58Decode(i.blockHash))
    .u32(1).u8(8).fixed(i.signedDelegateBytes).finish();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", tx as Uint8Array<ArrayBuffer>));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", await ed25519Key(seed), digest));
  return new BorshWriter().fixed(tx).u8(0).fixed(sig).finish();
}

/** FUND2: Borsh SignedTransaction with one Transfer action (enum 3, u128 yocto): creates an implicit account on first transfer. */
export async function buildOuterTransferTx(i: { signerId: string; secretKey: string; nonce: bigint; receiverId: string; blockHash: string; yocto: bigint }): Promise<Uint8Array> {
  const { seed, pub } = parseNearSecretKey(i.secretKey);
  if (pub.length !== 32) throw new Error("private key must carry the public key (64-byte form)");
  const tx = new BorshWriter().string(i.signerId).u8(0).fixed(pub).u64(i.nonce).string(i.receiverId).fixed(base58Decode(i.blockHash))
    .u32(1).u8(3).u128(i.yocto).finish();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", tx as Uint8Array<ArrayBuffer>));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", await ed25519Key(seed), digest));
  return new BorshWriter().fixed(tx).u8(0).fixed(sig).finish();
}

/** State shared by every relay handled by one Durable Object: nonce high-water mark + broadcast mutex. */
export interface BroadcastShared { lastNonce: bigint; tail: Promise<unknown> }

const MAX_NONCE_ATTEMPTS = 3;

export class WorkerRelayChain implements ChainPort {
  private used = 0;
  private block?: { height: bigint; hash: string };
  /** delegateAction object (as handed to the core) -> its exact borsh SignedDelegateAction bytes. */
  private signed = new WeakMap<object, Uint8Array>();
  constructor(private readonly o: { rpc: JsonRpc; accountId: string; privateKey: string; maxSubrequests: number }, private readonly shared: BroadcastShared = { lastNonce: 0n, tail: Promise.resolve() }) {}
  get subrequestsUsed() { return this.used; }
  register(d: { delegateAction: object; signedBytes: Uint8Array }): void { this.signed.set(d.delegateAction, d.signedBytes); }

  private async rpc(method: string, params: unknown): Promise<any> {
    if (this.used >= this.o.maxSubrequests) throw new Error(`subrequest budget exhausted (${this.o.maxSubrequests} per invocation)`);
    this.used++;
    const res = await this.o.rpc.sendJsonRpc(method, params);
    if (res?.error) throw new Error(`NEAR RPC error (${method}): ${typeof res.error === "string" ? res.error : JSON.stringify(res.error)}`);
    if (typeof res?.result === "undefined") throw new Error(`NEAR RPC (${method}): response had no result`);
    return res.result;
  }

  async currentBlockHeight(): Promise<bigint> {
    const b = await this.rpc("block", { finality: "final" });
    this.block = { height: BigInt(b.header.height), hash: b.header.hash };
    return this.block.height;
  }

  /** LIVE1: the sender's chain nonce for this key (null when the key/account does not exist). */
  async senderKeyNonce(accountId: string, publicKeyEd25519: Uint8Array): Promise<bigint | null> {
    try {
      const k = await this.rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: "ed25519:" + base58Encode(publicKeyEd25519) });
      return BigInt(k.nonce);
    } catch (e) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(String((e as any)?.message ?? ""))) return null;
      throw e;
    }
  }

  /** SECREV1 SR-7: is this key an access key of the account? (throws on RPC trouble; the relayer then fails open) */
  async accessKeyExists(accountId: string, publicKeyEd25519: Uint8Array): Promise<boolean> {
    return (await this.senderKeyNonce(accountId, publicKeyEd25519)) !== null;
  }

  /** FUND2: does this account exist on chain (view_account)? */
  async accountExists(accountId: string): Promise<boolean> {
    try { await this.rpc("query", { request_type: "view_account", finality: "optimistic", account_id: accountId }); return true; }
    catch (e) { if (/UNKNOWN_ACCOUNT|does not exist/i.test(String((e as any)?.message ?? ""))) return false; throw e; }
  }

  /** FUND2: NEP-245 mt_balance_of on the intents contract. */
  async intentsBalance(intents: string, accountId: string, tokenId: string): Promise<bigint> {
    const args = btoa(JSON.stringify({ account_id: accountId, token_id: tokenId }));
    const r = await this.rpc("query", { request_type: "call_function", finality: "optimistic", account_id: intents, method_name: "mt_balance_of", args_base64: args });
    return BigInt(JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result as number[]))) ?? "0");
  }

  /** SEC1/MON-9: the escrow's asset_limit(asset_id).min_per_side (null when the asset has no limit). */
  async minStake(escrow: string, assetId: string): Promise<bigint | null> {
    const args = btoa(JSON.stringify({ asset_id: assetId }));
    const r = await this.rpc("query", { request_type: "call_function", finality: "optimistic", account_id: escrow, method_name: "asset_limit", args_base64: args });
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result as number[])));
    const min = v?.min_per_side;
    return typeof min === "string" && /^\d+$/.test(min) ? BigInt(min) : null;
  }

  /** FUND2: relayer-signed NEAR transfer (implicit-account activation), serialized with the relays on the shared nonce. */
  transfer(receiverId: string, yocto: bigint): Promise<BroadcastResult> {
    const run = this.shared.tail.then(() => this.send({ receiverId, yocto }, undefined));
    this.shared.tail = run.catch(() => undefined);
    return run;
  }

  /** SEC1/MON-2: the outcome of an outer tx this relayer signed; null when the chain doesn't know it (UNKNOWN_TRANSACTION). */
  async txStatus(txHash: string): Promise<any | null> {
    try {
      return await this.rpc("tx", { tx_hash: txHash, sender_account_id: this.o.accountId, wait_until: "EXECUTED_OPTIMISTIC" });
    } catch (e) {
      if (/UNKNOWN_TRANSACTION/.test(String((e as any)?.message ?? ""))) return null;
      throw e;
    }
  }

  broadcastSignedDelegate(delegateAction: any, _sig: Uint8Array, hooks?: { onSigned?(txHash: string): void }): Promise<BroadcastResult> {
    // Serialize broadcasts: two concurrent relays must not take the same access-key nonce.
    const run = this.shared.tail.then(() => this.send(delegateAction, hooks));
    this.shared.tail = run.catch(() => undefined);
    return run;
  }

  private async send(delegateAction: any, hooks: { onSigned?(txHash: string): void } | undefined): Promise<BroadcastResult> {
    // RELAY500: the relayer key is shared with other writers (dev/test runs), so a stale view can lose the nonce race more than
    // once. The tx was not executed on InvalidNonce: learn the chain's ak_nonce from the error, refetch, retry (bounded).
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.sendOnce(delegateAction, hooks);
      } catch (e) {
        const msg = String((e as any)?.message ?? "");
        if (!/InvalidNonce/.test(msg) || attempt >= MAX_NONCE_ATTEMPTS) throw e;
        const ak = /"ak_nonce":\s*(\d+)/.exec(msg);
        if (ak && BigInt(ak[1]) > this.shared.lastNonce) this.shared.lastNonce = BigInt(ak[1]);
      }
    }
  }

  private async sendOnce(delegateAction: any, hooks: { onSigned?(txHash: string): void } | undefined): Promise<BroadcastResult> {
    const transfer = typeof delegateAction?.yocto === "bigint" ? (delegateAction as { receiverId: string; yocto: bigint }) : null;
    const signedBytes = transfer ? undefined : this.signed.get(delegateAction);
    if (!transfer && !signedBytes) throw new Error("internal: delegate was not registered");
    const { pub } = parseNearSecretKey(this.o.privateKey);
    if (!this.block) await this.currentBlockHeight();
    const key = await this.rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: this.o.accountId, public_key: "ed25519:" + base58Encode(pub) });
    const chainNonce = BigInt(key.nonce);
    const nonce = (chainNonce > this.shared.lastNonce ? chainNonce : this.shared.lastNonce) + 1n;
    this.shared.lastNonce = nonce;
    const signed = transfer
      ? await buildOuterTransferTx({ signerId: this.o.accountId, secretKey: this.o.privateKey, nonce, receiverId: transfer.receiverId, blockHash: this.block!.hash, yocto: transfer.yocto })
      : await buildOuterDelegateTx({ signerId: this.o.accountId, secretKey: this.o.privateKey, nonce, receiverId: delegateAction.senderId, blockHash: this.block!.hash, signedDelegateBytes: signedBytes! });
    // SEC1/MON-2: the hash is known before sending, so a timeout can be looked up instead of guessed. Everything up to here
    // sent nothing (plain errors); from send_tx on, only an explicit refusal proves the tx did not go out.
    const txHash = await signedTxHash(signed);
    if (this.used >= this.o.maxSubrequests) throw new Error(`subrequest budget exhausted (${this.o.maxSubrequests} per invocation)`);
    hooks?.onSigned?.(txHash);
    let out: any;
    try {
      out = await this.rpc("send_tx", { signed_tx_base64: base64Encode(signed), wait_until: "EXECUTED_OPTIMISTIC" });
    } catch (e) {
      if (REFUSED_TX.test(String((e as any)?.message ?? ""))) throw e;
      throw new OutcomeUnknown(txHash, e);
    }
    if (out?.status?.Failure) {
      // Same contract as near-api-js's ServerTransactionError: carries transaction_outcome so the core charges the estimate.
      throw Object.assign(new Error(`transaction failed: ${JSON.stringify(out.status.Failure)}`), { transaction_outcome: out.transaction_outcome ?? {} });
    }
    return { transactionHash: out?.transaction?.hash ?? out?.transaction_outcome?.id ?? txHash, actualCostYocto: sumTokensBurnt(out), raw: out };
  }
}

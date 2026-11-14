// WebCrypto NEAR client for Workers: view calls + signed FunctionCall transactions over plain
// JSON-RPC, no near-api-js, no node:crypto, no Buffer. Same method surface the node keeper
// uses on NearClient (view / call / callPayable), the same per-call attached-NEAR ceiling,
// and a hard per-invocation subrequest budget (Workers cap outbound subrequests per
// invocation; exceeding it must be a clean error, not a platform kill mid-batch).
import { BorshWriter, base58Decode, base64Encode, utf8 } from "./bytes.js";

export interface JsonRpc { sendJsonRpc(method: string, params: unknown): Promise<any>; }

const PKCS8_ED25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** `ed25519:<base58(seed32 || pub32)>` (the near-cli / key-file format) -> {seed, pub}. */
export function parseNearSecretKey(secret: string): { seed: Uint8Array; pub: Uint8Array } {
  const m = /^ed25519:(.+)$/.exec(secret.trim());
  if (!m) throw new Error("private key must be ed25519:<base58>");
  const raw = base58Decode(m[1]);
  if (raw.length !== 64 && raw.length !== 32) throw new Error("ed25519 private key has wrong length");
  return { seed: raw.slice(0, 32), pub: raw.length === 64 ? raw.slice(32) : new Uint8Array(0) };
}

export async function ed25519Key(seed: Uint8Array): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX); pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey("pkcs8", pkcs8 as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["sign"]);
}

export interface TxInput {
  signerId: string; secretKey: string; nonce: bigint; receiverId: string; blockHash: string;
  methodName: string; args: Uint8Array; gas: bigint; deposit: bigint;
}

/** Borsh SignedTransaction (one FunctionCall action) signed with WebCrypto Ed25519. */
export async function buildSignedFunctionCallTx(i: TxInput): Promise<{ signedTx: Uint8Array; txHashInput: Uint8Array }> {
  const { seed, pub } = parseNearSecretKey(i.secretKey);
  if (pub.length !== 32) throw new Error("private key must carry the public key (64-byte form)");
  const txBytes = new BorshWriter()
    .string(i.signerId).u8(0).fixed(pub).u64(i.nonce).string(i.receiverId).fixed(base58Decode(i.blockHash))
    .u32(1).u8(2).string(i.methodName).bytes(i.args).u64(i.gas).u128(i.deposit)
    .finish();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", txBytes as Uint8Array<ArrayBuffer>));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", await ed25519Key(seed), digest));
  const signedTx = new BorshWriter().fixed(txBytes).u8(0).fixed(sig).finish();
  return { signedTx, txHashInput: txBytes };
}

export interface WorkerNearClientOpts {
  rpc: JsonRpc;
  accountId: string;
  privateKey: string;
  maxAttachedYocto: bigint;
  /** Outbound RPC requests allowed for this client's lifetime (one invocation). */
  maxSubrequests: number;
  viewFinality?: "final" | "optimistic";
}

export class WorkerNearClient {
  private used = 0;
  constructor(private readonly o: WorkerNearClientOpts) {}
  get subrequestsUsed(): number { return this.used; }

  private async rpc(method: string, params: unknown): Promise<any> {
    if (this.used >= this.o.maxSubrequests) throw new Error(`subrequest budget exhausted (${this.o.maxSubrequests} per invocation)`);
    this.used++;
    const res = await this.o.rpc.sendJsonRpc(method, params);
    if (res?.error) throw new Error(`NEAR RPC error (${method}): ${typeof res.error === "string" ? res.error : JSON.stringify(res.error)}`);
    if (typeof res?.result === "undefined") throw new Error(`NEAR RPC (${method}): response had no result`);
    return res.result;
  }

  async view<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.rpc("query", {
      request_type: "call_function", account_id: contractId, method_name: methodName,
      args_base64: base64Encode(utf8(JSON.stringify(args))), finality: this.o.viewFinality ?? "final",
    });
    const bytes = new Uint8Array(r.result);
    return bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : (null as unknown as T);
  }

  async call<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}, gasTgas = 30): Promise<T> {
    return this.send(contractId, methodName, args, BigInt(gasTgas) * 1_000_000_000_000n, 0n) as Promise<T>;
  }

  async callPayable<T>(contractId: string, methodName: string, args: Record<string, unknown>, attachedYocto: bigint, gasTgas = 300): Promise<T> {
    if (attachedYocto > this.o.maxAttachedYocto) {
      throw new Error(`refusing to attach ${attachedYocto} yoctoNEAR to ${methodName}: exceeds per-call max ${this.o.maxAttachedYocto}`);
    }
    return this.send(contractId, methodName, args, BigInt(gasTgas) * 1_000_000_000_000n, attachedYocto) as Promise<T>;
  }

  private async send(contractId: string, methodName: string, args: Record<string, unknown>, gas: bigint, deposit: bigint): Promise<any> {
    const { pub } = parseNearSecretKey(this.o.privateKey);
    const pubStr = "ed25519:" + base58Encode(pub);
    const [key, block] = await Promise.all([
      this.rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: this.o.accountId, public_key: pubStr }),
      this.rpc("block", { finality: "final" }),
    ]);
    const { signedTx } = await buildSignedFunctionCallTx({
      signerId: this.o.accountId, secretKey: this.o.privateKey, nonce: BigInt(key.nonce) + 1n, receiverId: contractId,
      blockHash: block.header.hash, methodName, args: utf8(JSON.stringify(args)), gas, deposit,
    });
    const out = await this.rpc("send_tx", { signed_tx_base64: base64Encode(signedTx), wait_until: "EXECUTED_OPTIMISTIC" });
    const failure = out?.status?.Failure;
    if (failure) throw new Error(`transaction ${methodName} failed: ${JSON.stringify(failure)}`);
    return out;
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(b: Uint8Array): string {
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < b.length; i++) {
    let carry = b[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

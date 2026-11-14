// RELAYDEP1 / D-RELAYDEP1: in a NEP-366 meta-transaction the OUTER signer (the relayer) is charged every deposit attached to the
// delegate's inner actions. So a call that carries the user's NEAR (wrapping NEAR, the request_resolution bond, ...) must be a plain
// transaction the USER signs and pays for, broadcast straight to the NEAR RPC. Only gas-only calls and the 1-yocto security deposit
// go through the relayer. SEC1/MON-1: that includes NEP-145 storage_deposit (it refunds to the sender, so a relayed one drained the
// relayer); the relayer refuses it outright.
import { actionCreators, createTransaction, encodeTransaction, SCHEMA, type Transaction } from "@near-js/transactions";
import { PublicKey } from "@near-js/crypto";
import * as borsh from "borsh";
import { sha256 } from "js-sha256";
import { base58FromHex } from "./delegate";
import { gasForMethod } from "./relayGas";
import { viewAccessKeyNonce, viewBlockHash, sendSignedTx } from "./rpc";

/** Largest deposit the relayer may carry: the 1 yocto NEP-141 security deposit. */
export const RELAYED_MAX_DEPOSIT_YOCTO = 1n;
/** SEC1/MON-1: the relayer sponsors no NEP-145 registration any more (policy.ts refuses a relayed storage_deposit). */
export const SPONSORED_STORAGE_MAX_YOCTO = 0n;

export function needsUserSignedTx(methodName: string, depositYocto: bigint): boolean {
  if (methodName === "storage_deposit") return depositYocto > SPONSORED_STORAGE_MAX_YOCTO;
  return depositYocto > RELAYED_MAX_DEPOSIT_YOCTO;
}

export interface DirectTxParams {
  senderId: string; publicKeyHexEd25519: string; receiverId: string; methodName: string; args: Record<string, unknown>;
  gasTgas: number; depositYocto: string; nonce: bigint; blockHashB58: string;
}

export function buildDirectTx(p: DirectTxParams): { transaction: Transaction; hashHex: string } {
  const publicKey = PublicKey.fromString("ed25519:" + base58FromHex(p.publicKeyHexEd25519));
  const action = actionCreators.functionCall(p.methodName, Buffer.from(JSON.stringify(p.args)), BigInt(p.gasTgas) * 1_000_000_000_000n, BigInt(p.depositYocto));
  const bh = decodeB58(p.blockHashB58);
  const transaction = createTransaction(p.senderId, publicKey, p.receiverId, p.nonce, [action], bh);
  return { transaction, hashHex: sha256(Buffer.from(encodeTransaction(transaction))) };
}

export function encodeSignedTx(transaction: Transaction, signatureHex: string): string {
  const sigHex = signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex;
  const sig = Uint8Array.from(Buffer.from(sigHex, "hex"));
  if (sig.length !== 64) throw new Error(`expected 64-byte ed25519 signature, got ${sig.length}`);
  const signed = { transaction, signature: { ed25519Signature: { data: Array.from(sig) } } };
  return Buffer.from(borsh.serialize(SCHEMA.SignedTransaction as any, signed as any)).toString("base64");
}

const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeB58(s: string): Uint8Array {
  let n = 0n; for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}

export interface DirectParams {
  senderId: string; publicKeyHexEd25519: string; receiverId: string; methodName: string; args: Record<string, unknown>;
  gasTgas?: number; depositYocto: string; signRawHash: (address: string, hashHex: string) => Promise<string>;
}
/** Build, have the user's wallet sign, and broadcast one plain transaction the user pays for (gas + deposit). */
export async function runDirectTx(p: DirectParams): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  try {
    const [nonce, blockHashB58] = await Promise.all([viewAccessKeyNonce(p.senderId, p.publicKeyHexEd25519), viewBlockHash()]);
    const { transaction, hashHex } = buildDirectTx({ ...p, gasTgas: p.gasTgas ?? gasForMethod(p.methodName), nonce: nonce + 1n, blockHashB58 });
    const sig = await p.signRawHash(p.senderId, hashHex);
    const txHash = await sendSignedTx(encodeSignedTx(transaction, sig), p.senderId);
    return { ok: true, txHash };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

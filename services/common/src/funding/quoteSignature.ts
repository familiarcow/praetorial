// F1 (FUND4 SPEC §7.1): 1Click quote signature check, a dependency-light port of @defuse-protocol/one-click-sdk-typescript
// 0.1.26 `verifyQuoteSignature` (src/quote-signature.ts, ISC). Message = utf8(base58(sha256(stableStringify({...signedReq,
// ...signedQuote, timestamp})))), ed25519-signed by the 1Click manager key. Only the fields below are signed: appFees,
// depositMode, confidentiality, insured etc. are NOT (so the Worker separately checks the echoed request, see policy.ts).
// Verified against 20+ real quotes in spikes/fund3, spikes/fund4 and spikes/f1 evidence. KNOWN GAP (spikes/f1/NOTES.md):
// every BTC origin-chain quote fails this check, with the official SDK too.
// Pure + host-neutral (Worker and browser): js-sha256, tweetnacl, bs58 only.
import { sha256 } from "js-sha256";
import nacl from "tweetnacl";
import bs58 from "bs58";

export const ONE_CLICK_MANAGER_PUB_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/** json-stable-stringify 1.3.0 semantics for plain JSON data: sorted keys, undefined object members dropped, undefined in arrays -> null. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return undefined as unknown as string;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (typeof (v as { toJSON?: unknown }).toJSON === "function") return stableStringify((v as { toJSON(): unknown }).toJSON());
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === "function" ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort()) {
    if (o[k] === undefined || typeof o[k] === "function") continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(o[k])}`);
  }
  return `{${parts.join(",")}}`;
}

const or = (v: unknown) => (v ? v : undefined);

/** The signed subset of a quote response (SDK buildSignedQuoteRequest + buildSignedQuote). */
export function signedQuoteObject(r: any): Record<string, unknown> {
  const q = r?.quoteRequest ?? {}, x = r?.quote ?? {};
  const req = {
    dry: q.dry, swapType: q.swapType, slippageTolerance: q.slippageTolerance, originAsset: q.originAsset, depositType: q.depositType,
    destinationAsset: q.destinationAsset, amount: q.amount, refundTo: q.refundTo, refundType: q.refundType, recipient: q.recipient,
    recipientType: q.recipientType, deadline: q.deadline, quoteWaitingTimeMs: or(q.quoteWaitingTimeMs), referral: or(q.referral),
    virtualChainRecipient: or(q.virtualChainRecipient), virtualChainRefundRecipient: or(q.virtualChainRefundRecipient),
    customRecipientMsg: or(q.customRecipientMsg),
  };
  const base = {
    amountIn: x.amountIn, amountInFormatted: x.amountInFormatted, amountInUsd: x.amountInUsd, minAmountIn: x.minAmountIn,
    amountOut: x.amountOut, amountOutFormatted: x.amountOutFormatted, amountOutUsd: x.amountOutUsd, minAmountOut: x.minAmountOut,
  };
  const quote = q.dry ? base : {
    ...base, depositAddress: or(x.depositAddress), depositMemo: or(x.depositMemo), deadline: or(x.deadline), timeWhenInactive: or(x.timeWhenInactive),
    timeEstimate: or(x.timeEstimate), refundFee: or(x.refundFee), withdrawFee: or(x.withdrawFee),
  };
  return { ...req, ...quote, timestamp: r?.timestamp };
}

/** base58(sha256(stableStringify(signed subset))): the string the manager key signs. */
export function quoteHash(r: unknown): string {
  return bs58.encode(new Uint8Array(sha256.arrayBuffer(new TextEncoder().encode(stableStringify(signedQuoteObject(r))))));
}

const unprefix = (s: string) => (s.startsWith("ed25519:") ? s.slice(8) : s);

/** true only when `r.signature` is the manager key's ed25519 signature over quoteHash(r). Never throws. */
export function verifyQuoteSignature(r: unknown, managerPublicKey: string = ONE_CLICK_MANAGER_PUB_KEY): boolean {
  try {
    const sig = (r as any)?.signature;
    if (typeof sig !== "string") return false;
    const sigBytes = bs58.decode(unprefix(sig)), pub = bs58.decode(unprefix(managerPublicKey));
    if (sigBytes.length !== 64 || pub.length !== 32) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(quoteHash(r)), sigBytes, pub);
  } catch {
    return false;
  }
}

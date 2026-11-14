// F5 (FUND4 SPEC §5.2, familiarcow UX-37 FUND 14, D-FUND4a): Cash out and Convert are signed by the USER, with their own (Privy) key,
// through the conversion service's generate-intent / submit-intent. No relayer, no gas, no transaction of ours.
//   1. POST /withdraw/intent -> the NEP-413 `swap_transfer` payload the Worker got from 1Click (the Worker already checked it).
//   2. The browser checks it AGAIN with the Worker's own code (lib/funding/intentCheck.ts, a byte copy): exactly one transfer of
//      exactly amountIn of the origin token to the quote's deposit address, signed by this account, deadline no later than the
//      quote. It recomputes the NEP-413 hash itself and refuses a hash that differs from the Worker's.
//   3. Only then: signRawHash(account, OUR hash) (the same wallet path the username claim uses).
//   4. POST /withdraw/submit with { standard, payload, public_key, signature } (ed25519:<base58>).
// Outcomes: submitted | cancelled (the user said no; nothing sent) | mismatch (we refused to sign; nothing sent) | expired |
// refused (the Worker said no before anything was sent) | unknown (signed, and the submit's answer was lost: "checking", never
// "failed" — the record says signed, and the Worker's list corrects it if the submit never landed) | already (never sign twice).
import { checkSwapTransferIntent, hashNep413Payload, type Nep413PayloadJson } from "./funding/intentCheck";
import { FundingError, type FundingClient } from "./funding/fundingClient";
import type { SwapRecord } from "./funding/types";

export type SignResult =
  | { kind: "submitted"; intentHash: string }
  | { kind: "cancelled" }
  | { kind: "mismatch"; problems: string[] }
  | { kind: "expired" }
  | { kind: "refused"; error: unknown }
  | { kind: "unknown"; error: unknown }
  | { kind: "already" };

export interface SignDeps {
  client: Pick<FundingClient, "withdrawIntent" | "withdrawSubmit">;
  signRawHash(account: string, hashHex: string): Promise<string>;
  now(): number;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
const fromHex = (h: string): Uint8Array => {
  const s = h.replace(/^0x/, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error("not hex");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};
const toHex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
const IMPLICIT = /^[0-9a-f]{64}$/;

/** The submit body: the implicit account's own ed25519 key (its id IS the key) and the 64-byte signature. */
export function signedDataFor(payload: Nep413PayloadJson, account: string, signatureHex: string) {
  if (!IMPLICIT.test(account)) throw new Error("only an implicit (64-hex) account can sign a cash out");
  const sig = fromHex(signatureHex);
  if (sig.length !== 64) throw new Error(`an ed25519 signature is 64 bytes, got ${sig.length}`);
  return { standard: "nep413" as const, payload, public_key: `ed25519:${base58Encode(fromHex(account))}`, signature: `ed25519:${base58Encode(sig)}` };
}

/** Submit failures that prove nothing was accepted (the Worker refused the request itself). Anything else after a signature is
 * "unknown": the transfer may have gone through. */
const DEFINITELY_REFUSED = new Set(["bad_request", "not_found", "bad_recipient", "bad_refund", "too_low", "no_route", "deadline"]);

export async function signAndSubmit(r: SwapRecord, d: SignDeps): Promise<SignResult> {
  if (r.signed === true) return { kind: "already" };
  if (r.kind === "fund") return { kind: "refused", error: new Error("a deposit is not signed") };
  // SECREV1 SR-1: anyone can create a quote for any account; only sign the one this browser asked for (recipient the user typed)
  if (r.createdHere !== true) return { kind: "refused", error: new Error("this cash out was not started on this device") };
  if (!IMPLICIT.test(r.account)) return { kind: "refused", error: new Error("only an implicit (64-hex) account can sign a cash out") };
  const deadline = r.deadline ? Date.parse(r.deadline) : NaN;
  if (!Number.isFinite(deadline) || deadline <= d.now()) return { kind: "expired" };

  let got: { intent: unknown; hash: string };
  try { got = await d.client.withdrawIntent(r.account, r.depositAddress); } catch (error) { return { kind: "refused", error }; }

  const chk = checkSwapTransferIntent(got.intent, {
    signerId: r.account, depositAddress: r.depositAddress, originAsset: r.origin.assetId, amountIn: r.amountIn, maxDeadlineMs: deadline, nowMs: d.now(),
  });
  if (!chk.ok) return { kind: "mismatch", problems: chk.problems };
  const hash = toHex(hashNep413Payload(chk.payload));
  if (hash !== String(got.hash).toLowerCase().replace(/^0x/, "")) return { kind: "mismatch", problems: ["the hash to sign does not match the payload"] };

  let sigHex: string;
  try { sigHex = await d.signRawHash(r.account, hash); } catch { return { kind: "cancelled" }; }

  let signed;
  try { signed = signedDataFor(chk.payload, r.account, sigHex); } catch (error) { return { kind: "refused", error }; }
  try {
    const res = await d.client.withdrawSubmit(r.depositAddress, signed);
    return { kind: "submitted", intentHash: res.intentHash };
  } catch (error) {
    if (error instanceof FundingError && DEFINITELY_REFUSED.has(error.code)) return { kind: "refused", error };
    return { kind: "unknown", error };
  }
}

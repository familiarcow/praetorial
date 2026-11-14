// The one path Praetorial would actually ship: a Privy wallet signing a
// FunctionCall tx, gated by our own allowlist (lib/signerPolicy.ts)
// BEFORE Privy's raw_sign is ever called. Also rejects any non-
// FunctionCall action outright (see README "signer-safety gap" note --
// our allowlist only reasons about FunctionCall args; a bare Transfer
// action carries no such structure, so the safe default is to refuse
// every action type except FunctionCall for a Privy-backed wallet).
import { transactions as T } from "near-api-js";
import { rawSign } from "./privy.js";
import { buildUnsignedTx, attachSignature, broadcast } from "./nearRaw.js";
import { assertAllowed, PolicyConfig, PolicyViolation } from "./signerPolicy.js";

export { PolicyViolation };

export class PrivyPolicySigner {
  constructor(
    public accountId: string,
    public publicKeyHex: string,
    public walletId: string,
    public policy: PolicyConfig,
  ) {}

  /** Throws PolicyViolation (without ever calling Privy) if the call
   * isn't allowed. On success, builds the tx, calls Privy raw_sign,
   * broadcasts, and returns the tx hash. */
  async call(receiverId: string, methodName: string, args: Record<string, unknown>, gasTgas = 80): Promise<{ txHash: string; result: any }> {
    assertAllowed(this.policy, receiverId, methodName, args);
    const action = T.functionCall(methodName, args, BigInt(gasTgas) * 1_000_000_000_000n, 0n);
    const { tx, hash32 } = await buildUnsignedTx(this.accountId, this.publicKeyHex, receiverId, [action]);
    const sig = await rawSign(this.walletId, hash32);
    const signed = attachSignature(tx, sig.signatureHex);
    const result = await broadcast(signed);
    return { txHash: result?.transaction?.hash, result };
  }

  /** Deliberately rejects anything that is not a FunctionCall to an
   * allowlisted receiver+method -- used by the negative safety tests
   * to prove e.g. a bare Transfer action is never even built/sent. */
  async attemptDisallowed(receiverId: string, methodName: string, args: Record<string, unknown>): Promise<never> {
    assertAllowed(this.policy, receiverId, methodName, args);
    throw new Error("expected assertAllowed to throw, but it did not -- policy gap");
  }
}

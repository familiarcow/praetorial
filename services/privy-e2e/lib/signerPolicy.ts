// Step 7 of the task: Privy's policy engine can't inspect NEAR tx
// content (it only sees a 32-byte hash to raw_sign -- see the audit
// doc §4 "Privy policy engine, vs. NEP-413/raw tx hashes"). So OUR
// code must be the allowlist. This module is the enforcement point:
// every call that will end up asking Privy to raw_sign a NEAR
// FunctionCall MUST pass through `assertAllowed()` first. A rejected
// call throws before nearRaw.ts ever builds a tx or calls Privy --
// i.e. Privy's API is never even invoked for a disallowed action.
export class PolicyViolation extends Error {}

export interface PolicyConfig {
  escrowContract: string;
  intentsContract: string;
  usdcTokenId: string;
  maxTransferAmount: bigint; // cap on any single transfer_with_msg amount
}

/** The only three "receiver contract" categories a Privy-backed wallet's
 * raw-signed NEAR txs are allowed to touch, per the task's step 7 spec:
 * "escrow, the USDC token with ft_transfer_call/transfer_with_msg to
 * escrow only, intents" (intents.near IS the token/transfer surface in
 * this stack -- the mock's `transfer_with_msg` plays the NEP-245
 * Transfer-with-msg role `ft_transfer_call` would play for a plain
 * NEP-141 token). Every entry's method list is exhaustive, not a
 * default-allow. */
export function buildAllowlist(cfg: PolicyConfig) {
  return {
    [cfg.escrowContract]: new Set([
      "take", // not actually used directly by the user -- funding is via transfer_with_msg(Take); kept for direct-call paths (cancel, challenge bonds go through intents too). See methods below.
      "cancel",
      "request_resolution", // payable in NEAR, not USDC -- still capped separately by the keeper's own MAX_ATTACHED_NEAR_YOCTO, not this module
    ]),
    [cfg.intentsContract]: new Set(["transfer_with_msg"]),
  } as Record<string, Set<string>>;
}

/** Throws PolicyViolation if the call is not on the allowlist, or (for
 * transfer_with_msg) if the embedded receiver_id isn't the escrow
 * contract, the token isn't the configured USDC token, or the amount
 * exceeds the configured cap. Returns void on success. */
export function assertAllowed(cfg: PolicyConfig, receiverId: string, methodName: string, args: Record<string, unknown>): void {
  const allowlist = buildAllowlist(cfg);
  const methods = allowlist[receiverId];
  if (!methods) {
    throw new PolicyViolation(`refusing to sign: receiver "${receiverId}" is not on the allowlist (allowed: ${Object.keys(allowlist).join(", ")})`);
  }
  if (!methods.has(methodName)) {
    throw new PolicyViolation(`refusing to sign: method "${methodName}" on "${receiverId}" is not on the allowlist (allowed: ${[...methods].join(", ")})`);
  }
  if (receiverId === cfg.intentsContract && methodName === "transfer_with_msg") {
    const msgReceiver = String(args.receiver_id ?? "");
    const tokenId = String(args.token_id ?? "");
    const amount = BigInt(String(args.amount ?? "0"));
    if (msgReceiver !== cfg.escrowContract) {
      throw new PolicyViolation(`refusing to sign: transfer_with_msg receiver_id "${msgReceiver}" is not the escrow contract "${cfg.escrowContract}"`);
    }
    if (tokenId !== cfg.usdcTokenId) {
      throw new PolicyViolation(`refusing to sign: transfer_with_msg token_id "${tokenId}" is not the configured USDC token "${cfg.usdcTokenId}"`);
    }
    if (amount > cfg.maxTransferAmount) {
      throw new PolicyViolation(`refusing to sign: transfer_with_msg amount ${amount} exceeds cap ${cfg.maxTransferAmount}`);
    }
  }
}

// Transaction-content safety rail for this harness's one user-
// initiated action: a plain NEAR Transfer from the user's own Privy
// wallet back to the funder account, capped. Privy's raw_sign can't
// see tx semantics (it only ever gets a 32-byte hash) -- this module,
// run server-side BEFORE a hash is ever built, is the real allowlist.
import { MAX_TRANSFER_BACK_YOCTO, FUNDER_ID } from "./config.js";

export class PolicyViolation extends Error {}

export function assertTransferAllowed(receiverId: string, amountYocto: bigint): void {
  if (receiverId !== FUNDER_ID) {
    throw new PolicyViolation(`refusing to build tx: receiver "${receiverId}" is not the allowlisted funder "${FUNDER_ID}"`);
  }
  if (amountYocto <= 0n) {
    throw new PolicyViolation("refusing to build tx: transfer amount must be positive");
  }
  if (amountYocto > MAX_TRANSFER_BACK_YOCTO) {
    throw new PolicyViolation(`refusing to build tx: amount ${amountYocto} exceeds cap ${MAX_TRANSFER_BACK_YOCTO}`);
  }
}

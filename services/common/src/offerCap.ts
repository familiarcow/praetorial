// Praetorial app-layer sponsored-offer cap (System scope map v1 #16,
// Decisions log D5/D7). Deliberately NOT enforced in the escrow
// contract -- see contracts/escrow/tests/chaos_findings.rs
// `handle_open_has_no_per_maker_open_offer_cap_by_design_cap_is_app_layer`,
// which documents that choice at the contract level. This is the real
// enforcement point: whatever app/indexer surface builds an `Open`
// transfer_with_msg for a user must call `assertCanOpenOffer` (or check
// `exceedsOpenOfferCap`) against that user's current open, not-yet-taken
// offer count BEFORE submitting it.
//
// Standing test policy (familiarcow, 2026-11-03): a decision that moves an
// enforcement point out of the contract must land a REAL enforcing
// test here, not just a comment -- see offerCap.test.ts.

/** Max open (not-yet-taken) sponsored offers per maker account, per D5/D7. */
export const SPONSORED_OPEN_OFFER_CAP = 3;

/** True if `openOfferCount` (the maker's CURRENT open offer count, before
 * adding a new one) has already reached the sponsored cap -- i.e. a new
 * offer must be refused. */
export function exceedsOpenOfferCap(openOfferCount: number): boolean {
  return openOfferCount >= SPONSORED_OPEN_OFFER_CAP;
}

/** Throws with a clear reason if the cap would be exceeded; call this
 * before building/submitting a new offer's `Open` transfer_with_msg. */
export function assertCanOpenOffer(openOfferCount: number): void {
  if (exceedsOpenOfferCap(openOfferCount)) {
    throw new Error(
      `sponsored open-offer cap reached (${openOfferCount}/${SPONSORED_OPEN_OFFER_CAP}); ` +
        `cancel or let an existing offer expire before opening another`,
    );
  }
}

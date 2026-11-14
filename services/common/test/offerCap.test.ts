import { test } from "node:test";
import assert from "node:assert/strict";
import { SPONSORED_OPEN_OFFER_CAP, exceedsOpenOfferCap, assertCanOpenOffer } from "../src/offerCap.js";

// Real enforcement test for the app-layer sponsored-offer cap (System
// scope map v1 #16 / D5 / D7) -- the escrow contract deliberately has
// no equivalent check (see contracts/escrow/tests/chaos_findings.rs
// `handle_open_has_no_per_maker_open_offer_cap_by_design_cap_is_app_layer`).
// Per the 2026-11-03 standing test policy, moving an enforcement point
// out of the contract requires landing the real test HERE, not just a
// decision-register note.

test("cap is 3, matching the documented D5/D7 sponsorship limit", () => {
  assert.equal(SPONSORED_OPEN_OFFER_CAP, 3);
});

test("a 4th open offer is refused; the first 3 are allowed", () => {
  assert.equal(exceedsOpenOfferCap(0), false);
  assert.equal(exceedsOpenOfferCap(1), false);
  assert.equal(exceedsOpenOfferCap(2), false);
  assert.equal(exceedsOpenOfferCap(3), true, "3 open offers already -> a 4th must be refused");
  assert.equal(exceedsOpenOfferCap(4), true);
});

test("assertCanOpenOffer throws once the cap is reached, not before", () => {
  assert.doesNotThrow(() => assertCanOpenOffer(2));
  assert.throws(() => assertCanOpenOffer(3), /sponsored open-offer cap reached/);
});

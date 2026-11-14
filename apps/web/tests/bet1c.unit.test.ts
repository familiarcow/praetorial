// BET1c (UX-33 sections 4-5): Who decides + More options.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { moreOptionsSummary, expiryLabel, EXPIRY_CHOICES, FIXED_SETTLEMENT_PERIOD, FIXED_SETTLEMENT_SECS } from "../lib/betOptions";
import { OFFER_EXPIRY_OPTIONS } from "../lib/offerExpiry";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, f), "utf8");

test("challenge window is fixed at 24h (a valid contract settlement period)", () => {
  assert.equal(FIXED_SETTLEMENT_PERIOD, "24h");
  assert.equal(FIXED_SETTLEMENT_SECS, 86400);
});

test("offer closes in: 1 / 7 / 30 days in plain English, same ids/secs as OFFER_EXPIRY_OPTIONS", () => {
  assert.deepEqual(EXPIRY_CHOICES.map((c) => [c.id, c.label]), [["1d", "1 day"], ["7d", "7 days"], ["30d", "30 days"]]);
  assert.deepEqual(EXPIRY_CHOICES.map((c) => c.id), OFFER_EXPIRY_OPTIONS.map((o) => o.id));
  assert.equal(expiryLabel("7d"), "7 days");
  assert.equal(expiryLabel("bogus"), "7 days");
});

test("summary: defaults (AI bet)", () => {
  assert.equal(moreOptionsSummary({ offerExpiry: "7d", takerAccount: "", inviteByLink: false, human: false, resolveByDate: null }),
    "Closes in 7 days · anyone can take · 24h to challenge");
});

test("summary follows each choice", () => {
  assert.equal(moreOptionsSummary({ offerExpiry: "1d", takerAccount: " alice.near ", inviteByLink: true, human: false, resolveByDate: null }),
    "Closes in 1 day · only alice.near can take · 24h to challenge");
  assert.equal(moreOptionsSummary({ offerExpiry: "30d", takerAccount: "", inviteByLink: true, human: false, resolveByDate: null }),
    "Closes in 30 days · invite-only link · 24h to challenge");
  assert.equal(moreOptionsSummary({ offerExpiry: "7d", takerAccount: "", inviteByLink: false, human: true, resolveByDate: "2028-12-08" }),
    "Closes in 7 days · anyone can take · referee rules by 2028-12-08");
  assert.equal(moreOptionsSummary({ offerExpiry: "7d", takerAccount: "", inviteByLink: false, human: true, resolveByDate: null }),
    "Closes in 7 days · anyone can take");
});

test("wiring: CreateOffer mounts WhoDecides + BetOptions; the settlement-window selector is gone", () => {
  const co = read("../src/components/CreateOffer.tsx");
  assert.ok(co.includes("<WhoDecides") && co.includes("<BetOptions"));
  assert.ok(!co.includes('data-testid="settlement-period"') && !co.includes("setSettlementPeriod"), "no settlement selector");
  assert.ok(co.includes("FIXED_SETTLEMENT_PERIOD"));
  const wd = read("../src/components/WhoDecides.tsx");
  for (const id of ["decider-ai", "decider-person", "decider-help", "referee-search", "tip-maker-checkbox", "referee-registered-error", "referee-errors"]) assert.ok(wd.includes(`data-testid="${id}"`), id);
  const bo = read("../src/components/BetOptions.tsx");
  for (const id of ["more-options-toggle", "more-options-summary", "offer-expiry", "taker-account-input", "taker-error", "invite-by-link", "resolve-deadline", "resolve-label", "resolve-error", "expiry-error"]) assert.ok(bo.includes(`data-testid="${id}"`), id);
  assert.ok(!bo.includes("settlement-period"));
});

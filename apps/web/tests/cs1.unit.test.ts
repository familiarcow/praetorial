// CS1 (testnet case studies): regressions found while running real bets end to end on testnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { requestSourceCheck } from "../lib/sourceCheckClient";

test("CS1: requestSourceCheck with the default clock accepts an attestation the Worker stamped DURING the request", async () => {
  // The resolver stamps checked_at while it runs (a real check takes ~15 s). The default "now" used to be captured when the call
  // STARTED, so every fresh attestation looked like it came from the future and was refused as "stale" (live driver, 2026-11-11).
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_u: string, init: any) => {
    await new Promise((r) => setTimeout(r, 30));
    const checked_at = String(BigInt(Date.now()) * 1_000_000n);
    await new Promise((r) => setTimeout(r, 30));
    const spec_hash = createHash("sha256").update(JSON.parse(init.body).terms).digest("hex");
    return new Response(JSON.stringify({ ok: true, spec_hash, checked_at, unreachable: [], signing: { signature_hex: "33".repeat(64) } }), { status: 200 });
  };
  try {
    const att = await requestSourceCheck(createHash("sha256").update("t").digest("hex"), "t", "http://x/sc", 1000);
    assert.match(att.checked_at, /^\d+$/);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("CS1: requestSourceCheck with the default clock still refuses an attestation older than the freshness window", async () => {
  const realFetch = globalThis.fetch;
  const old = String((BigInt(Date.now()) - 2n * 3_600_000n) * 1_000_000n);
  (globalThis as any).fetch = async (_u: string, init: any) => {
    const spec_hash = createHash("sha256").update(JSON.parse(init.body).terms).digest("hex");
    return new Response(JSON.stringify({ ok: true, spec_hash, checked_at: old, unreachable: [], signing: { signature_hex: "33".repeat(64) } }), { status: 200 });
  };
  try {
    await assert.rejects(requestSourceCheck(createHash("sha256").update("t").digest("hex"), "t", "http://x/sc", 1000), (e: any) => e.kind === "stale");
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

// ---- CS1 #3: testnet plumbing bets are hidden from the site-wide Home sections (config only; nothing is deleted).
import { readFileSync } from "node:fs";
import { exploreOffers, inProgressCandidates, IN_PROGRESS_LIMIT } from "../lib/homeSections";
import { exploreHidden, parseIdList } from "../lib/exploreHidden";
import { NETWORKS } from "../lib/network";

const FRZ3 = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet";

const T = { networkId: "testnet", escrow: FRZ3 } as const;
const BUILD = { VITE_EXPLORE_HIDDEN: "1-48" };

test("CS1: the testnet build hides bets 1-48 (pre-launch plumbing); the case studies (49+) stay visible", () => {
  const h = exploreHidden(FRZ3, BUILD, T);
  for (const id of [1, 5, 14, 33, 44, 47, 48]) assert.ok(h.has(id), `bet ${id} should be hidden`);
  for (const id of [49, 50, 51, 52, 53, 54, 1000]) assert.ok(!h.has(id), `bet ${id} should be visible`);
});

test("CS1: the hide list is a build setting for the testnet escrow only: never mainnet, another contract, or an unset build", () => {
  assert.equal(exploreHidden(FRZ3, {}, T).size, 0, "unset (mocked e2e / dev): nothing hidden");
  assert.equal(exploreHidden(NETWORKS.mainnet.escrow, BUILD, { networkId: "mainnet", escrow: NETWORKS.mainnet.escrow }).size, 0);
  assert.equal(exploreHidden("someone-else.testnet", BUILD, T).size, 0);
  assert.deepEqual([...parseIdList("1-3, 7,9-10")], [1, 2, 3, 7, 9, 10]);
  assert.equal(parseIdList("garbage,5-1,-3,4.5").size, 0, "anything malformed is ignored, never a wide range");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["build:testnet"], /VITE_EXPLORE_HIDDEN=1-48 /);
  assert.doesNotMatch(pkg.scripts["build:mainnet"], /EXPLORE_HIDDEN/);
});

test("CS1: Explore drops hidden offers; In progress drops hidden bets BEFORE the newest-N cap (they never use up a slot)", () => {
  const offers = [{ bet_id: 3, maker: "a" }, { bet_id: 49, maker: "b" }, { bet_id: 50, maker: "me" }];
  const hidden = new Set([3]);
  assert.deepEqual(exploreOffers(offers, "me", hidden).map((o) => o.bet_id), [49]);
  assert.deepEqual(exploreOffers(offers, null).map((o) => o.bet_id), [3, 49, 50], "no hide set = unchanged");
  const hist = Array.from({ length: 60 }, (_, i) => ({ bet_id: i + 1, status: "Taken" }));
  const shown = inProgressCandidates(hist, IN_PROGRESS_LIMIT, new Set(Array.from({ length: 58 }, (_, i) => i + 1)));
  assert.deepEqual(shown, [60, 59]);
});

test("CS1: both site-wide Home sections apply the hide list for THIS build's escrow", () => {
  for (const f of ["src/components/BrowsePage.tsx", "src/components/InProgressBets.tsx"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.match(src, /exploreHidden\(ESCROW_CONTRACT_ID\)/, `${f} must pass exploreHidden(ESCROW_CONTRACT_ID)`);
  }
});

// ---- CS1 (mainnet bug): the web writes typed templates ({template, fields}) and custom sheets ({claim, ...}); termsClaimText only
// read a legacy `claimText` key, so Explore showed 0 of 12 testnet offers and In progress 0 of 16 bets (rows without a readable
// question are dropped, BROWSE1b), and every other screen said "Terms not available".
import { termsClaimText, termSheetSummary } from "../lib/escrowAdapter";
import { buildTypedSheet, canonicalTerms } from "../lib/templates";

const env = (sheet: unknown) => ({ terms: typeof sheet === "string" ? sheet : canonicalTerms(sheet as any) });

test("CS1: a typed BTC close sheet reads as a plain question", () => {
  const s = buildTypedSheet("btc_close_at_t", { t_utc: "2026-11-11T20:30:00Z", op: ">=", x_usd: 74400, open_utc: "2026-11-11T19:04:00Z" });
  assert.equal(termsClaimText(env(s)), "Bitcoin's 1-minute close at 2026-11-11 20:30 UTC is at or above $74,400");
});

test("CS1: every launch template and the custom claim read as a question; never a hash, never empty", () => {
  assert.equal(termsClaimText(env(buildTypedSheet("btc_touch", { direction: "at_or_below", x_usd: 70000, deadline_utc: "2026-11-13T12:00:00Z", open_utc: "2026-11-11T19:00:00Z" }))),
    "Bitcoin touches $70,000 or lower before 2026-11-13 12:00 UTC");
  assert.equal(termsClaimText(env(buildTypedSheet("game_winner", { league: "NHL", event_id: "2026020294", scheduled_date: "2026-11-11", pick: { team_id: "3", name: "New York Rangers" } }))),
    "New York Rangers win their NHL game on 2026-11-11");
  assert.equal(termsClaimText(env(buildTypedSheet("nws_daily_high", { station: "KNYC", date: "2026-11-11", op: ">=", x_f: 63 }))),
    "The official NWS high in New York City (Central Park) on 2026-11-11 is 63°F or warmer");
  assert.equal(termsClaimText(env(buildTypedSheet("nws_daily_high", { station: "KLAX", date: "2026-11-12", op: "<=", x_f: 70 }))),
    "The official NWS high in Los Angeles (LAX airport) on 2026-11-12 is 70°F or cooler");
  assert.equal(termsClaimText(env({ claim: "The Knicks beat the Cavaliers on 2026-11-11.", elements: [] })), "The Knicks beat the Cavaliers on 2026-11-11.");
  assert.equal(termsClaimText(env({ claimText: "Legacy sheet" })), "Legacy sheet");
});

test("CS1: unreadable terms stay unreadable (BROWSE1b): no terms, not JSON, unknown template, missing fields", () => {
  assert.equal(termsClaimText({ terms: undefined as any }), null);
  assert.equal(termsClaimText(env("not json")), null);
  assert.equal(termsClaimText(env({ template: { id: "mystery", version: 1 }, fields: {} })), null);
  assert.equal(termsClaimText(env({ template: { id: "btc_close_at_t", version: 1 }, fields: { op: ">=" } })), null);
  assert.equal(termsClaimText(env({ claim: "   " })), null);
  assert.equal(termSheetSummary({ terms: canonicalTerms({ foo: 1 } as any), terms_hash: "ab".repeat(32) }), "Terms not available");
});

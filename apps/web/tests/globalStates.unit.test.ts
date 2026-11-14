// FE16 (S18): global states (paused / shutdown / offline) and the plain-English copy pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COPY, globalBanners } from "../lib/globalStates";
import { takeAvailability } from "../lib/takeView";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(here, "..", p), "utf8");
const NOW = 1_800_000_000n * 1_000_000_000n;
const FUND = Number(NOW + 86_400n * 1_000_000_000n);
const bet = (over: Record<string, any> = {}): any => ({
  status: "Open", taker: null, fee_min_taker: "500000", storage_rates: new Proxy({}, { get: () => "457" }),
  envelope: { maker: "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: null,
    maker_asset: "nep141:usdc.testnet", taker_asset: "nep141:usdc.testnet", stake_maker: "10000000", stake_taker: "10000000", taker_options: [],
    fee_bps: 100, funding_deadline: FUND, resolve_deadline: FUND + 86_400_000_000_000, settlement_period: 86_400_000_000_000, referee: null },
  ...over,
});
const ctx = (o: Record<string, any> = {}) => ({ account: "me.testnet", inviteSig: null, nowNs: NOW, paused: false, shutdown: false, ...o });

test("globalBanners: none / paused / shutdown (wins over paused) / offline (shown alongside)", () => {
  assert.deepEqual(globalBanners({ paused: false, shutdown: false, offline: false }), []);
  assert.deepEqual(globalBanners({ paused: true, shutdown: false, offline: false }).map((b) => b.kind), ["paused"]);
  assert.deepEqual(globalBanners({ paused: true, shutdown: true, offline: false }).map((b) => b.kind), ["shutdown"]);
  assert.deepEqual(globalBanners({ paused: false, shutdown: false, offline: true }).map((b) => b.kind), ["offline"]);
  assert.deepEqual(globalBanners({ paused: true, shutdown: false, offline: true }).map((b) => b.kind), ["offline", "paused"]);
});

test("banner copy: spec S18 wording", () => {
  assert.match(COPY.paused, /^New bets are paused\./);
  assert.match(COPY.shutdown, /^Praetorial is shut down\./);
  assert.match(COPY.shutdown, /Get my money back/);
  assert.match(COPY.offline, /^You're offline\./);
});

test("take path: paused and shut down are separate, plain states; a terminal fact still wins", () => {
  const p = takeAvailability(bet(), ctx({ paused: true }));
  assert.equal(p.kind, "paused");
  assert.match(p.message, /^New bets are paused\./);
  const s = takeAvailability(bet(), ctx({ shutdown: true }));
  assert.equal(s.kind, "shutdown");
  assert.match(s.message, /^Praetorial is shut down/);
  assert.equal(takeAvailability(bet({ status: "Cancelled" }), ctx({ shutdown: true })).kind, "cancelled");
});

test("copy pass: the old developer strings are gone from the screens", () => {
  const banned: [string, RegExp][] = [
    ["src/App.tsx", /"rpc error"|account not funded yet|>\s*Create offer\s*</],
    ["src/components/BetPage.tsx", /"loading\.\.\."|"rpc error"|Emergency refund/],
    ["src/components/BrowsePage.tsx", /indexer unavailable|loading offers\.\.\.|>no open offers<|>no bets yet<|log in to see your bets/],
    ["src/components/Login.tsx", /loading balance\.\.\.|creating wallet\.\.\./],
    ["src/components/AboutPage.tsx", />loading\.\.\.</], // NAV1: the judge models list moved from JudgeModelsPage to About
    ["src/components/StatusBanner.tsx", /Contract shut down|New bets paused\./],
    ["index.html", /Privy NEAR E2E/],
  ];
  for (const [f, re] of banned) assert.doesNotMatch(src(f), re, `${f} still has a developer string`);
});

test("copy pass: the replacement strings", () => {
  assert.equal(COPY.loading, "Loading…");
  assert.equal(COPY.betLoadFailed, "We couldn't load this bet. Check your connection and try again.");
  assert.equal(COPY.listLoadFailed, "We couldn't load the list. Try again in a moment.");
  assert.equal(COPY.noOpenBets, "No open bets right now.");
  assert.equal(COPY.noBetsYet, "You have no bets yet.");
  assert.equal(COPY.loginToSeeBets, "Log in to see your bets.");
  assert.equal(COPY.balanceLoading, "Loading your balance…");
  assert.equal(COPY.refundButton, "Get my money back");
});

test("SECREV1 SR-5: an AI-decided offer whose terms are not kept on chain (keep_terms:false) cannot be taken (anyone can force a VOID)", () => {
  const a = takeAvailability(bet({ envelope: { ...bet().envelope, keep_terms: false, terms: null } }), ctx());
  assert.equal(a.kind, "hash-only");
  assert.match(a.message, /terms/i);
  assert.equal(takeAvailability(bet({ envelope: { ...bet().envelope, keep_terms: true, terms: "{}" } }), ctx()).kind, "available");
  // a person decides: no AI run, so the hash-only VOID path does not apply
  assert.equal(takeAvailability(bet({ envelope: { ...bet().envelope, keep_terms: false, referee: { account: "ref.testnet" } } }), ctx()).kind, "available");
  // terminal facts still win
  assert.equal(takeAvailability(bet({ status: "Cancelled", envelope: { ...bet().envelope, keep_terms: false } }), ctx()).kind, "cancelled");
});

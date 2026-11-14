// NAV1 (UX-31 / UX-32): Home / About / Wallet (F3: Account). Pure logic behind the three sections, the account rows, the About content,
// token-unit money text (never "$" for USDC/USDT) and the routes. React only renders what these return.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatAmount } from "../lib/amount";
import { formatMoney } from "../lib/intentsBalance";
import { matchRoute, legacyRedirect, loginPageLine, routeRequiresLogin } from "../lib/router";
import { accountRows, WALLET_ASSETS } from "../lib/walletCards";
import { inProgressCandidates, exploreOffers, IN_PROGRESS_STATUSES, IN_PROGRESS_LIMIT } from "../lib/homeSections";
import { ABOUT, LAUNCH_JUDGE_CHAIN, modelLabel, judgePairsForAbout, feeRows, RESOLVER_WASM_HASH_SHORT } from "../lib/about";
import type { MovableReport } from "../lib/moveToBetting";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

// ---------- money in token units ----------
test("UX-31: USDC/USDT are token amounts, never dollars: '12.50 USDC', not '$12.50'", () => {
  assert.equal(formatAmount("USDC", 12_500_000n, { cents: true }), "12.50 USDC");
  assert.equal(formatAmount("USDT", 12_500_000n, { cents: true }), "12.50 USDT");
  assert.equal(formatAmount("USDC", 10_000_000n), "10 USDC");
  assert.equal(formatAmount("USDC", 500_000n), "0.5 USDC");
  assert.equal(formatAmount("USDC", 12_500_000n, { plain: true }), "12.5");
  assert.equal(formatMoney("USDC", "12500000"), "12.50 USDC");
  assert.equal(formatMoney("USDC", "0"), "0.00 USDC");
  assert.equal(formatMoney("NEAR", (5n * 10n ** 24n).toString()), "5 NEAR");
});

test("no money formatter in lib/ prefixes a token amount with '$' (BTC price levels in term sheets are prices, not balances)", () => {
  for (const f of ["../lib/amount.ts", "../lib/intentsBalance.ts", "../lib/stakeDeadlines.ts", "../lib/payoutScreen.ts", "../lib/refereeScreen.ts", "../lib/ruling.ts"]) {
    assert.doesNotMatch(read(f), /`\$\$\{|"\$0|`-\$\$\{/, `${f} still renders a token amount with a $ sign`);
  }
});

// ---------- Account rows (F3 replaced NAV1's wallet cards; the row model is tested in tests/account.unit.test.ts) ----------
const NEAR = (n: string) => (BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n).toString();
const report = (o: Partial<MovableReport> = {}): MovableReport => ({ holdings: [], native: { state: "empty", yocto: "0" }, readFailed: [], ...o });

test("account rows: one per launch asset, in launch order (USDC, USDT, NEAR, BTC, ETH, ZEC), each with a bundled logo", () => {
  assert.deepEqual(WALLET_ASSETS, ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  assert.deepEqual(accountRows(null, null, "loading", "mainnet").map((r) => r.symbol), ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  for (const s of WALLET_ASSETS) assert.ok(read(`../src/assets/logos/${s.toLowerCase()}.svg`).includes("<svg"), `${s} logo is bundled locally`);
});

test("account rows: betting and NEAR-account amounts in token units (one amount rule); Move only for what the NEAR account holds; BTC gets no invented NEAR-account amount", () => {
  const map = { betting: { USDC: 12500000n, NEAR: 20n * 10n ** 24n, BTC: 0n }, stray: [], nearAccount: {}, inBets: {}, payouts: [], inFlight: [] };
  const rows = accountRows(map, report({
    holdings: [{ symbol: "USDC", source: "token", amountUnits: "3000000" }, { symbol: "NEAR", source: "native", amountUnits: NEAR("4.95") }],
    native: { state: "ok", yocto: NEAR("5") },
  }), { inBets: {}, payouts: [], record: { won: 0, lost: 0 }, memberSince: null }, "mainnet");
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  assert.equal(by.USDC.bettingText, "12.50 USDC");
  assert.equal(by.USDC.nearText, "In your NEAR account: 3.00 USDC");
  assert.equal(by.USDC.moves.length, 1);
  assert.equal(by.NEAR.nearText, "In your NEAR account: 5 NEAR");
  assert.equal(by.NEAR.bettingText, "20 NEAR");
  assert.equal(by.NEAR.moves[0]!.source, "native");
  assert.equal(by.BTC.bettingText, "0 BTC");
  assert.equal(by.BTC.moves.length, 0);
  assert.equal(by.BTC.nearText, null);
  assert.ok(!rows.some((r) => /\$/.test(`${r.bettingText}${r.nearText}`)), "no $ on a token amount");
});

// ---------- Home sections ----------
// H1: My Bets grouping ("Needs you", Settled collapsed) and the cards moved to betView: tests/h1Home.unit.test.ts.
test("Explore: other people's untargeted open offers only (mine are under My Bets)", () => {
  const offers = [{ bet_id: 1, maker: "a.near" }, { bet_id: 2, maker: "me.near" }, { bet_id: 3, maker: "b.near" }];
  assert.deepEqual(exploreOffers(offers, "me.near").map((o) => o.bet_id), [1, 3]);
  assert.deepEqual(exploreOffers(offers, null).map((o) => o.bet_id), [1, 2, 3]);
});

test("In progress: accepted and not yet settled, site-wide, newest first, capped", () => {
  assert.deepEqual([...IN_PROGRESS_STATUSES], ["Taken", "Resolving", "Proposed", "Challenged", "Evidence", "Rejudge", "Finalized"]);
  const h = [
    { bet_id: 1, maker: "a", taker: null, status: "Open", outcome: null },
    { bet_id: 2, maker: "a", taker: "b", status: "Taken", outcome: null },
    { bet_id: 3, maker: "a", taker: "b", status: "Settled", outcome: "YES" },
    { bet_id: 4, maker: "a", taker: "b", status: "Proposed", outcome: null },
    { bet_id: 5, maker: "a", taker: "b", status: "Voided", outcome: null },
    { bet_id: 6, maker: "a", taker: "b", status: "Finalized", outcome: "NO" },
    { bet_id: 4, maker: "a", taker: "b", status: "Proposed", outcome: null },
  ];
  assert.deepEqual(inProgressCandidates(h), [6, 4, 2]);
  const many = Array.from({ length: 50 }, (_, i) => ({ bet_id: i, maker: "a", taker: "b", status: "Taken", outcome: null }));
  assert.equal(inProgressCandidates(many).length, IN_PROGRESS_LIMIT);
  assert.equal(inProgressCandidates(many)[0], 49);
});

// H1: progressWords is gone; In progress cards show the betView pill and sentence (one status vocabulary, SM2 H1-1).

// ---------- About ----------
test("About: the launch judge chain equals the mainnet args (4 pairs, DeepSeek-V4.1-Flash + glm-5.3-flash first)", () => {
  const args = JSON.parse(read("../../../release/mainnet-night/args.mainnet.json"));
  assert.deepEqual(LAUNCH_JUDGE_CHAIN, args.judge_chain);
  assert.equal(LAUNCH_JUDGE_CHAIN.length, 4);
  const pairs = judgePairsForAbout(LAUNCH_JUDGE_CHAIN);
  assert.deepEqual(pairs[0], { position: 1, label: "DeepSeek-V4.1-Flash + glm-5.3-flash", role: "First choice" });
  assert.equal(pairs[3]!.role, "Backup 3");
});

test("modelLabel: provider prefix and dated suffix dropped", () => {
  assert.equal(modelLabel("deepseek-ai/DeepSeek-V4.1-Flash-1017"), "DeepSeek-V4.1-Flash");
  assert.equal(modelLabel("z-ai/glm-5.3-flash"), "glm-5.3-flash");
  assert.equal(modelLabel("anthropic/claude-haiku-5-5"), "claude-haiku-5-5");
});

test("About: the judge fingerprint is the pinned resolver wasm hash from the mainnet args", () => {
  const args = JSON.parse(read("../../../release/mainnet-night/args.mainnet.json"));
  assert.ok(args.resolver_wasm_hash.startsWith(RESOLVER_WASM_HASH_SHORT.replace("…", "")));
  assert.equal(RESOLVER_WASM_HASH_SHORT, "8791413f…");
  const text = JSON.stringify(ABOUT);
  assert.match(text, /8791413f/);
  assert.match(text, /FastFS/);
  assert.match(text, /OutLayer/);
});

test("About: every section familiarcow listed is there, in plain words", () => {
  assert.deepEqual(ABOUT.map((s) => s.id), ["what", "how", "models", "verify", "fees", "know"]);
  const how = ABOUT.find((s) => s.id === "how")!;
  const t = JSON.stringify(how);
  for (const w of [/offer/i, /take/i, /person/i, /24 hours/, /two/i, /7 days/, /concede/i, /refund/i]) assert.match(t, w);
  const know = JSON.stringify(ABOUT.find((s) => s.id === "know"));
  for (const w of [/real money/i, /beta/i, /NEAR Intents/, /risk/i]) assert.match(know, w);
  assert.doesNotMatch(JSON.stringify(ABOUT), /\$\d/, "no dollar amounts on About");
});

test("About fees: 1% per side, with each asset's minimum fee per side from the release limits, in token units", () => {
  const rows = feeRows(["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  assert.deepEqual(rows.map((r) => r.symbol), ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  assert.equal(rows[0]!.minFee, "0.50 USDC");
  assert.equal(rows[1]!.minFee, "0.50 USDT");
  assert.equal(rows[3]!.minFee, "0.00000679 BTC");
  assert.equal(rows[0]!.minStake, "10.00 USDC");
  assert.match(JSON.stringify(ABOUT.find((s) => s.id === "fees")), /1% of each side's stake/);
});

// ---------- routes ----------
test("routes: / is Home, /docs (DOCS1: was /about), /account (F3: Wallet renamed Account); old /wallet, /settings, /add-money, /browse, /my-bets, /judges, /about redirect (keeping ?need/return)", () => {
  assert.deepEqual(matchRoute("/"), { name: "home" });
  assert.deepEqual(matchRoute("/docs"), { name: "docs", page: "what" });
  assert.equal(legacyRedirect("/about", "", ""), "/docs");
  assert.deepEqual(matchRoute("/account"), { name: "account" });
  assert.equal(legacyRedirect("/add-money", "?asset=USDC&need=10&return=%2Fnew", ""), "/account?asset=USDC&need=10&return=%2Fnew");
  assert.equal(legacyRedirect("/add-money", "", ""), "/account");
  assert.equal(legacyRedirect("/add-money/", "", ""), "/account");
  assert.equal(legacyRedirect("/wallet", "?asset=USDC&need=10", ""), "/account?asset=USDC&need=10");
  assert.equal(legacyRedirect("/browse", "", ""), "/");
  assert.equal(legacyRedirect("/my-bets", "", ""), "/");
  assert.equal(legacyRedirect("/judges", "", ""), "/docs/verification#models");
  assert.equal(legacyRedirect("/", "", "#judge-models"), "/docs/verification#models");
  assert.equal(legacyRedirect("/account", "", ""), null);
  for (const r of [{ name: "home" }, { name: "account" }] as const) assert.equal(routeRequiresLogin(r), true);
  assert.equal(routeRequiresLogin({ name: "docs", page: "what" }), false); // DOCS1: Docs are public
  assert.equal(loginPageLine({ name: "account" }), "Log in to open your account. You will come back to this page.");
});

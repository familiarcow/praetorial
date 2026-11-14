// F3 (FUND4 SPEC §3, familiarcow UX-37 / D-FUND4a, SM2 STATES.md M5 + gaps F3-1..5): the Account screen's view model (lib/walletCards.ts),
// its loaders (lib/accountBalances.ts), MON-3 (BTC/ETH/ZEC on the NEAR account can be moved back; no cash out of them to the NEAR
// account), the /account route and the username carried in the app state.
import test from "node:test";
import assert from "node:assert/strict";
import {
  accountRows, isEmptyAccount, accountView, moneyUnread, strayRows, lockedInBets, payoutsFromBets, betRecord, memberSince, inFlightLines, needHeadline,
  canCashOutToNear, recordText, WALLET_ASSETS, type BetsSection, type MoneyRead,
} from "../lib/walletCards";
import { batchFallbackView, nearAccountFrom, loadMoney, loadBets } from "../lib/accountBalances";
import { buildMoveSteps, movableReport, MOVABLE_SYMBOLS, type MovableReport } from "../lib/moveToBetting";
import { appCtx } from "../lib/appState";
import { matchRoute, legacyRedirect, loginPageLine } from "../lib/router";
import { balanceMap, STRAY_ETH_USDC, STRAY_UNKNOWN, fundRecord, withdrawRecord, ID, ACCOUNT } from "./funding/fixtures";
import type { Bet } from "../lib/escrowAdapter";

const ME = ACCOUNT;
const NEAR = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;
const report = (over: Partial<MovableReport> = {}): MovableReport => ({ holdings: [], native: { state: "empty", yocto: "0" }, readFailed: [], ...over });
const NO_BETS: BetsSection = { inBets: {}, payouts: [], record: { won: 0, lost: 0 }, memberSince: null };

test("rows: one per bet token in D-ASSET1 order, non-zero betting balances first, zero rows after and compact", () => {
  const map = balanceMap({ betting: { USDC: 0n, USDT: 50000000n, NEAR: 0n, BTC: 98500n, ETH: 0n, ZEC: 0n }, nearAccount: {}, inBets: {} });
  const rows = accountRows(map, report(), NO_BETS, "mainnet");
  assert.deepEqual(rows.map((r) => r.symbol), ["USDT", "BTC", "USDC", "NEAR", "ETH", "ZEC"]);
  assert.deepEqual(rows.map((r) => r.compact), [false, false, true, true, true, true]);
  assert.equal(rows[0].bettingText, "50.00 USDT");
  assert.equal(rows[1].bettingText, "0.000985 BTC");
  assert.equal(rows[2].bettingText, "0.00 USDC");
  assert.deepEqual(WALLET_ASSETS, ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
});

test("rows: the NEAR-account line (B3) and the in-bets line (B4/B5) only when non-zero; NEAR counts native + wrapped", () => {
  const rep = report({
    holdings: [{ symbol: "USDC", source: "token", amountUnits: "3000000" }, { symbol: "NEAR", source: "native", amountUnits: NEAR("5.05").toString() }],
    native: { state: "ok", yocto: NEAR("5.1").toString() },
  });
  const bets: BetsSection = { ...NO_BETS, inBets: { BTC: { units: 20000n, bets: 1 }, USDC: { units: 25000000n, bets: 3 } } };
  const rows = accountRows(balanceMap(), rep, bets, "mainnet");
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  assert.equal(by.USDC.nearText, "In your NEAR account: 3.00 USDC");
  assert.equal(by.NEAR.nearText, "In your NEAR account: 5.1 NEAR");
  assert.equal(by.USDT.nearText, null);
  assert.deepEqual(by.USDC.moves.map((h) => h.source), ["token"]);
  assert.equal(by.BTC.inBetsText, "In bets: 0.0002 BTC (1 bet)");
  assert.equal(by.USDC.inBetsText, "In bets: 25.00 USDC (3 bets)");
  assert.equal(by.ETH.inBetsText, null);
  assert.equal(by.ETH.compact, true);
});

test("rows: an unread section is never shown as 0 (betting unread, NEAR account flagged; unread bets are one page notice, not a 0 line)", () => {
  const rows = accountRows(balanceMap({ betting: "error" }), report({ readFailed: ["USDC"] }), "error", "mainnet");
  const usdc = rows.find((r) => r.symbol === "USDC")!;
  assert.equal(usdc.betting, null);
  assert.equal(usdc.bettingText, null);
  assert.equal(usdc.nearUnreadable, true);
  assert.equal(usdc.inBetsText, null);
  assert.equal(usdc.compact, false);
  const loading = accountRows(null, null, "loading", "mainnet");
  assert.ok(loading.every((r) => r.betting === null && r.inBetsText === null));
});

test("empty state only when the balances were read and are 0, nothing in flight, nothing known in bets", () => {
  const zero = balanceMap({ betting: { USDC: 0n, NEAR: 0n }, stray: [], nearAccount: {}, inBets: {}, payouts: [], inFlight: [] });
  assert.equal(isEmptyAccount(zero, report(), NO_BETS, true), true);
  assert.equal(isEmptyAccount(zero, report({ native: { state: "too-small", yocto: "1" } }), NO_BETS, true), false, "dust native NEAR is still money");
  assert.equal(isEmptyAccount({ ...zero, betting: "error" }, report(), NO_BETS, true), false, "unread is not empty");
  // AFIX1 (familiarcow 11-13): "Add money" is a verdict on EVERY source. A bet list still loading or unread is not "nothing in bets".
  assert.equal(isEmptyAccount(zero, report(), "loading", true), false, "the bet list is still loading: not known to be empty");
  assert.equal(isEmptyAccount(zero, report(), "error", true), false, "an unread bet list is not an empty one");
  assert.equal(isEmptyAccount(zero, report(), { ...NO_BETS, inBets: { USDC: { units: 1n, bets: 1 } } }, true), false);
  assert.equal(isEmptyAccount({ ...zero, inFlight: [fundRecord()] }, report(), NO_BETS, true), false);
  assert.equal(isEmptyAccount({ ...zero, stray: [STRAY_ETH_USDC] }, report(), NO_BETS, true), false);
  assert.equal(isEmptyAccount(null, null, NO_BETS, true), false);
});

// ---- ACCT2 (familiarcow 11-13): an empty account still lists every bet token at 0, under the Add money hero ----
test("ACCT2 an empty mainnet account has a row for each of the 6 bet tokens, every one read as 0 (never '…', never 'Can't read')", () => {
  const zero = balanceMap({ betting: {}, stray: [], nearAccount: {}, inBets: {}, payouts: [], inFlight: [] });
  const ok: MoneyRead = { map: zero, report: report(), inFlightRead: true };
  assert.equal(accountView(ok, NO_BETS), "empty");
  const rows = accountRows(zero, report(), NO_BETS, "mainnet");
  assert.deepEqual(rows.map((r) => r.symbol), ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  assert.ok(rows.every((r) => r.betting === 0n && r.compact && r.bettingText !== null && /^0(\.0+)? [A-Z]+$/.test(r.bettingText)), JSON.stringify(rows.map((r) => r.bettingText)));
});

// ---- AFIX1: the page is loading, empty, or a list -- never a fake list first, never "empty" from a failed read ----
test("AFIX1 view: loading until money AND bets resolve; then exactly one of empty / list", () => {
  const zero = balanceMap({ betting: { USDC: 0n, USDT: 0n, NEAR: 0n, BTC: 0n, ETH: 0n, ZEC: 0n }, stray: [], nearAccount: {}, inBets: {}, payouts: [], inFlight: [] });
  const ok = { map: zero, report: report(), inFlightRead: true };
  assert.equal(accountView(null, "loading"), "loading");
  assert.equal(accountView(null, NO_BETS), "loading", "money still loading");
  assert.equal(accountView(ok, "loading"), "loading", "bets still loading");
  assert.equal(accountView(ok, NO_BETS), "empty");
  assert.equal(accountView({ ...ok, map: balanceMap() }, NO_BETS), "list");
  assert.equal(accountView({ ...ok, map: balanceMap() }, "error"), "list", "a failed bet read shows what was read + its notice");
});

test("AFIX1 each source failing on an otherwise all-zero account -> never 'empty', and the page says it can't read", () => {
  const zero = balanceMap({ betting: { USDC: 0n, USDT: 0n, NEAR: 0n, BTC: 0n, ETH: 0n, ZEC: 0n }, stray: [], nearAccount: {}, inBets: {}, payouts: [], inFlight: [] });
  const ok: MoneyRead = { map: zero, report: report(), inFlightRead: true };
  const cases: [string, typeof ok, BetsSection | "error", boolean][] = [
    ["intents betting balances (B1)", { ...ok, map: { ...zero, betting: "error" } }, NO_BETS, true],
    ["stray intents tokens (B2: own notice)", { ...ok, map: { ...zero, stray: "error" } }, NO_BETS, false],
    ["NEAR account wholly unread (B3)", { ...ok, map: { ...zero, nearAccount: "error" }, report: null }, NO_BETS, true],
    ["one NEAR-account token unread (B3: per-row line)", { ...ok, report: report({ readFailed: ["BTC"] }) }, NO_BETS, false],
    ["native NEAR unread (B3: per-row line)", { ...ok, report: report({ native: { state: "unreadable", yocto: "0" }, readFailed: ["NEAR"] }) }, NO_BETS, false],
    ["in-flight deposits (B7-B10)", { ...ok, inFlightRead: false }, NO_BETS, true],
    ["bets (B4-B6: its own notice)", ok, "error", false],
  ];
  for (const [name, money, bets, pageNotice] of cases) {
    assert.equal(accountView(money, bets), "list", name);
    assert.equal(moneyUnread(money), pageNotice, `${name}: balance-error notice`);
  }
  assert.equal(moneyUnread(ok), false);
});

test("AFIX1 loadMoney: an in-flight list that failed, or a funding server that didn't answer, is unread (not 'nothing in flight')", async () => {
  const deps = { network: "testnet" as const, mainnetReads: false, view: async (_c: string, m: string, a: any) => (m === "mt_batch_balance_of" ? a.token_ids.map(() => "0") : "0"), report: async () => report() };
  const read = await loadMoney(ME, { ...deps, inFlight: async () => ({ records: [], serverOk: false, serverExpected: false }) });
  assert.equal(read.inFlightRead, true, "no server on this network: this device's list is the whole list");
  const serverDown = await loadMoney(ME, { ...deps, inFlight: async () => ({ records: [], serverOk: false, serverExpected: true }) });
  assert.equal(serverDown.inFlightRead, false, "server configured but didn't answer (timeout / 429 / 5xx)");
  const threw = await loadMoney(ME, { ...deps, inFlight: async () => { throw new Error("storage"); } });
  assert.equal(threw.inFlightRead, false);
  const nearDown = await loadMoney(ME, { ...deps, report: async () => { throw new Error("rpc"); }, inFlight: async () => ({ records: [], serverOk: true, serverExpected: true }) });
  assert.equal(nearDown.report, null);
  assert.equal(nearDown.map.nearAccount, "error");
  assert.equal(accountView(nearDown, NO_BETS), "list");
});

test("stray tokens: '<symbol> (<network>)' + amount + Convert into one of the 6; unknown ids shown with Contact support; dust can't convert", () => {
  const dust = { ...STRAY_ETH_USDC, assetId: ID.BASE_USDC, units: 10n, token: { ...STRAY_ETH_USDC.token!, assetId: ID.BASE_USDC, blockchain: "base" }, dust: true };
  const rows = strayRows([STRAY_ETH_USDC, STRAY_UNKNOWN, dust]);
  assert.equal(rows[0].title, "USDC (Ethereum)");
  assert.equal(rows[0].amountText, "1.00 USDC");
  assert.equal(rows[0].convertTo, "USDC");
  assert.equal(rows[0].note, null);
  assert.match(rows[1].title, /^Unknown token \(.+\)\. Contact support\.$/);
  assert.equal(rows[1].convertTo, null);
  assert.equal(rows[1].amountText, "7 units");
  assert.equal(rows[2].title, "USDC (Base)");
  assert.equal(rows[2].convertTo, null);
  assert.equal(rows[2].note, "Too small to convert");
});

// ---- B4/B5/B6 + record from the user's bets ----
const DAY_NS = 86_400n * 1_000_000_000n;
const NOW_NS = 1_800_000_000_000n * 1_000_000n;
function bet(o: { id: number; status: string; maker: string; taker?: string | null; asset?: string; sm?: string; st?: string; outcome?: string | null; bonds?: Bet["bonds"]; created?: number }): Bet {
  const asset = o.asset ?? "nep141:usdc.testnet";
  return {
    envelope: {
      bet_id: o.id, version: 1, maker: o.maker, taker_allow: "Any", terms_hash: "", models_snapshot_hash: "", outcomes: ["YES", "NO"], maker_side: "YES",
      maker_asset: asset, taker_asset: asset, stake_maker: o.sm ?? "10000000", stake_taker: o.st ?? "10000000", taker_options: [], fee_bps: 100,
      reserve_per_side: "0", storage_charge_per_side: "0", keep_terms: false, terms: null, run_price: "0", max_paid_runs: 3, tier: 1, arbiter: null,
      arbiter_fee: "0", funding_deadline: Number(NOW_NS + DAY_NS), early_settle_outcome: null, finality_delay: 0, settlement_period: Number(DAY_NS),
      resolve_deadline: Number(NOW_NS + 30n * DAY_NS), consent_party_controlled: false, referee: null,
    },
    status: o.status, taker: o.taker ?? null, created_at: o.created ?? 0, taken_at: null, proposed_at: null, outcome: o.outcome ?? null,
    reserve_remaining: "0", bonds: o.bonds ?? [], exhibits: [], challenged_by: null, window_extension_ns: 0,
  } as Bet;
}

test("in bets: my own stake per token, open offers (maker) + taken/resolving/challenged bets, plus my bonds; settled and others' bets excluded", () => {
  const items = [
    { bet: bet({ id: 1, status: "Open", maker: ME }), pending: null },
    { bet: bet({ id: 2, status: "Taken", maker: "bob.testnet", taker: ME, st: "5000000" }), pending: null },
    { bet: bet({ id: 3, status: "Challenged", maker: ME, taker: "bob.testnet", bonds: [{ holder: ME, amount: "1000000", round: 1, pre_challenge_outcome: "NO", asset: "nep141:usdc.testnet" }] }), pending: null },
    { bet: bet({ id: 4, status: "Settled", maker: ME, taker: "bob.testnet", outcome: "YES" }), pending: null },
    { bet: bet({ id: 5, status: "Taken", maker: "x.testnet", taker: "y.testnet" }), pending: null },
    { bet: bet({ id: 6, status: "Open", maker: ME, asset: "nep141:wrap.testnet", sm: "3000000000000000000000000" }), pending: null },
  ];
  assert.deepEqual(lockedInBets(items, ME, Number(NOW_NS), "escrow.testnet", "testnet"), {
    USDC: { units: 10000000n + 5000000n + 10000000n + 1000000n, bets: 3 },
    NEAR: { units: 3000000000000000000000000n, bets: 1 },
  });
});

test("AFIX1 loadBets: a Finalized bet whose payout lines can't be read is 'payouts unread' (not 'nothing being paid out') -> never empty", async () => {
  const fin = bet({ id: 7, status: "Finalized", maker: ME, taker: "bob.testnet", outcome: "YES" });
  const base = { history: async () => [{ bet_id: 7 }], getBet: async () => fin, nowNs: () => Number(NOW_NS), network: "testnet" as const, contractId: "escrow.testnet" };
  const ok = await loadBets(ME, { ...base, pendingPayouts: async () => [] });
  assert.equal(ok.payoutsUnread, false);
  const down = await loadBets(ME, { ...base, pendingPayouts: async () => { throw new Error("429"); } });
  assert.equal(down.payoutsUnread, true);
  const zero = balanceMap({ betting: { USDC: 0n, NEAR: 0n }, stray: [], nearAccount: {}, inBets: {}, payouts: [], inFlight: [] });
  const money: MoneyRead = { map: zero, report: report(), inFlightRead: true };
  assert.equal(accountView(money, ok), "empty");
  assert.equal(accountView(money, down), "list");
  await assert.rejects(loadBets(ME, { ...base, getBet: async () => { throw new Error("rpc down"); } }), "a bet that can't be read fails the whole list (bets-error), never skipped");
});

test("being paid out: my unfinished payout lines of a Finalized bet; record counts won/lost; member since = my first bet", () => {
  const line = (id: number, receiver: string, done: boolean, amount = "18200000") => ({ id, bet_id: 7, token_id: "nep141:usdc.testnet", receiver, amount, reason: "win", attempts: 1, done, in_flight: false });
  const items = [
    { bet: bet({ id: 7, status: "Finalized", maker: ME, taker: "bob.testnet", outcome: "YES", created: 2_000_000 }), pending: [line(1, ME, false), line(2, "bob.testnet", false), line(3, ME, true)] },
    { bet: bet({ id: 8, status: "Settled", maker: ME, taker: "bob.testnet", outcome: "YES", created: 1_000_000 }), pending: null },
    { bet: bet({ id: 9, status: "Settled", maker: "bob.testnet", taker: ME, outcome: "YES", created: 3_000_000 }), pending: null },
  ];
  assert.deepEqual(payoutsFromBets(items, ME, "testnet"), [{ betId: 7, symbol: "USDC", units: 18200000n }]);
  assert.deepEqual(betRecord(items, ME), { won: 2, lost: 1 }, "7 (Finalized, mine) and 8 won; 9 (I took NO) lost");
  assert.equal(recordText({ won: 1, lost: 1 }), "1 won · 1 lost");
  assert.equal(recordText({ won: 0, lost: 0 }), "No bets settled yet");
  assert.equal(memberSince(items), 1, "ns on chain -> ms");
  assert.equal(memberSince([]), null);
});

test("in flight: one compact line per open transfer (token units, no raw ids); finished ones are not listed", () => {
  const lines = inFlightLines([fundRecord({ state: "converting" }), withdrawRecord({ state: "waiting" }), fundRecord({ id: "done", state: "credited" })]);
  assert.equal(lines.length, 2);
  assert.match(lines[0].text, /^Adding .+ USDT \(Tron\) → USDC$/);
  assert.equal(lines[0].state, "Converting");
  assert.match(lines[1].text, /^Cashing out /);
  assert.ok(lines.every((l) => !/[0-9a-f]{64}|\.near\b/.test(l.text)));
});

test("?need hand-off headline: balance and what's missing, token units (money.formatMoney, needed rounded up)", () => {
  assert.equal(needHeadline("USDC", 0n, { symbol: "USDC", amount: "10" }), "Your balance: 0.00 USDC. You need 10.00 USDC more.");
  assert.equal(needHeadline("USDC", 12_000_000n, { symbol: "USDC", amount: "10" }), "Your balance: 12.00 USDC. You have enough for this bet.");
  assert.equal(needHeadline("USDC", 0n, { symbol: "USDC", amount: "12.551" }), "Your balance: 0.00 USDC. You need 12.56 USDC more.");
  assert.equal(needHeadline("USDC", null, { symbol: "USDC", amount: "10" }), null);
});

// ---- MON-3 ----
test("MON-3: BTC/ETH/ZEC left on the NEAR account are read and can be moved back (ft_transfer_call to intents); never cashed out to it", async () => {
  assert.deepEqual([...MOVABLE_SYMBOLS], ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  const calls: string[] = [];
  const rep = await movableReport(ME, "mainnet", async (c) => { calls.push(c); return c === "btc.omft.near" ? "1500" : "0"; }, async () => 0n);
  for (const c of ["btc.omft.near", "eth.omft.near", "zec.omft.near"]) assert.ok(calls.includes(c), c);
  assert.deepEqual(rep.holdings, [{ symbol: "BTC", source: "token", amountUnits: "1500" }]);
  const [step] = buildMoveSteps({ symbol: "BTC", account: ME, amountUnits: "1500", source: "token", network: "mainnet" });
  assert.equal(step.receiverId, "btc.omft.near");
  assert.equal(step.methodName, "ft_transfer_call");
  assert.deepEqual(step.args, { receiver_id: "intents.near", amount: "1500", msg: JSON.stringify({ receiver_id: ME }) });
  assert.deepEqual(WALLET_ASSETS.filter(canCashOutToNear), ["USDC", "USDT", "NEAR"]);
  const testnet = await movableReport(ME, "testnet", async () => "0", async () => 0n);
  assert.deepEqual(testnet.readFailed, []);
});

test("B3 map from the NEAR-account report: per token, native NEAR included; a failed read of one token marks the section per token, not 0", () => {
  const rep = report({ holdings: [{ symbol: "BTC", source: "token", amountUnits: "7" }], native: { state: "too-small", yocto: "9" } });
  assert.deepEqual(nearAccountFrom(rep), { BTC: 7n, NEAR: 9n });
  assert.equal(nearAccountFrom(null), "error");
});

test("B1 batch read falls back to one mt_balance_of per token when the RPC has no batch method (mocked RPCs, older nodes)", async () => {
  const calls: string[] = [];
  const base = async (_c: string, m: string, a: any) => { calls.push(m); if (m === "mt_batch_balance_of") return null; return a.token_id === "t1" ? "5" : "0"; };
  const v = batchFallbackView(base);
  assert.deepEqual(await v("intents", "mt_batch_balance_of", { account_id: ME, token_ids: ["t1", "t2"] }), ["5", "0"]);
  assert.deepEqual(calls, ["mt_batch_balance_of", "mt_balance_of", "mt_balance_of"]);
  const good = batchFallbackView(async () => ["1", "2"]);
  assert.deepEqual(await good("intents", "mt_batch_balance_of", { account_id: ME, token_ids: ["a", "b"] }), ["1", "2"]);
  const down = batchFallbackView(async () => { throw new Error("rpc down"); });
  await assert.rejects(down("intents", "mt_batch_balance_of", { account_id: ME, token_ids: ["a"] }));
  // AFIX1: a per-token answer that is not a number (empty / null body) is a failed read, never "0".
  const blank = batchFallbackView(async (_c, m) => (m === "mt_batch_balance_of" ? null : null));
  await assert.rejects(blank("intents", "mt_batch_balance_of", { account_id: ME, token_ids: ["a"] }));
});

// ---- SM2 gap F3-1 + the /account route ----
test("SM2 F3-1: the app state carries the user's username (Account reads it, never the registry)", () => {
  assert.equal(appCtx({ auth: "ready", account: "has", username: "alice" }).username, "alice");
  assert.equal(appCtx({}).username, null);
});

test("Account route: /account; /wallet, /add-money (funding hand-off query kept) and /settings land on it", () => {
  assert.deepEqual(matchRoute("/account"), { name: "account" });
  assert.equal(legacyRedirect("/wallet", "?asset=USDC&need=10&return=%2Fnew", ""), "/account?asset=USDC&need=10&return=%2Fnew");
  assert.equal(legacyRedirect("/wallet", "", ""), "/account");
  assert.equal(legacyRedirect("/add-money", "?asset=USDC&need=12.55", ""), "/account?asset=USDC&need=12.55");
  assert.equal(legacyRedirect("/settings", "", ""), "/account");
  assert.equal(legacyRedirect("/account", "", ""), null);
  assert.equal(loginPageLine({ name: "account" }), "Log in to open your account. You will come back to this page.");
});

test("SM2 F3-4: 'Shown in referee search' is read from the registry search (it lists only discoverable users), unknown when it can't be asked", async () => {
  const { refereeListed } = await import("../lib/accountBalances");
  const reply = (rows: unknown, status = 200) => (async () => new Response(JSON.stringify(rows), { status })) as unknown as typeof fetch;
  assert.equal(await refereeListed("http://reg", "alice", ME, reply([{ username: "alice", account_tail: ME.slice(-8) }])), true);
  assert.equal(await refereeListed("http://reg", "alice", ME, reply([{ username: "alice2", account_tail: "x" }])), false);
  assert.equal(await refereeListed("http://reg", "alice", ME, reply({ error: "busy" }, 429)), null);
  assert.equal(await refereeListed("", "alice", ME), null);
  assert.equal(await refereeListed("http://reg", null, ME), null);
});

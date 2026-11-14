// F2: the balance map (lib/funding/balances.ts), fetchIntentsBalances on mt_batch_balance_of, and the ≈ $ total helper.
import test from "node:test";
import assert from "node:assert/strict";
import { readBetting, readStray, loadBalanceMap, payoutsFor, createSequence, bettingTotalUsd, PAGE, DUST_USD_CENTS } from "../../lib/funding/balances";
import { fetchIntentsBalances } from "../../lib/intentsBalance";
import { approxUsdTotal, displayAmount, exactAmount, holdingUsdCents, shortAddress, etaText } from "../../lib/funding/format";
import { mapTokens } from "../../lib/funding/tokens";
import { assetId, listEnabledAssets } from "../../lib/assets";
import { INTENTS_CONTRACT_ID } from "../../lib/config";
import { ACCOUNT, ID, ONECLICK_TOKENS, mockIntentsView, BALANCES, fundRecord, balanceMap } from "./fixtures";

const TOKENS = mapTokens(ONECLICK_TOKENS);
const BET6 = [ID.USDC, ID.USDT, ID.NEAR, ID.BTC, ID.ETH, ID.ZEC];

test("B1: ONE mt_batch_balance_of on intents.near for the 6 bet tokens, every symbol present (0 included)", async () => {
  const m = mockIntentsView();
  const b = await readBetting(ACCOUNT, m.view, "mainnet");
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].method, "mt_batch_balance_of");
  assert.equal(m.calls[0].contract, "intents.near");
  assert.deepEqual(m.calls[0].args, { account_id: ACCOUNT, token_ids: BET6 });
  assert.deepEqual(b, { USDC: 42100000n, USDT: 50000000n, NEAR: 5000000000000000000000000n, BTC: 98500n, ETH: 0n, ZEC: 0n });
});

test("B1 rejects a malformed answer (wrong length / not digits) instead of showing 0", async () => {
  await assert.rejects(readBetting(ACCOUNT, async () => ["1", "2"], "mainnet"));
  await assert.rejects(readBetting(ACCOUNT, async () => ["1", "2", "3", "4", "5", "-6"], "mainnet"));
  await assert.rejects(readBetting(ACCOUNT, async () => null, "mainnet"));
});

test("B2: mt_tokens_for_owner (paginated), drop the 6, one batch read, non-zero only, unknown ids kept as Unknown", async () => {
  const m = mockIntentsView();
  const s = await readStray(ACCOUNT, m.view, TOKENS, "mainnet");
  assert.deepEqual(m.calls.map((c) => c.method), ["mt_tokens_for_owner", "mt_batch_balance_of"]);
  assert.deepEqual(m.calls[0].args, { account_id: ACCOUNT, from_index: "0", limit: PAGE });
  assert.deepEqual(m.calls[1].args.token_ids, [ID.ETH_USDC, ID.UNKNOWN, ID.TRON_USDT]);
  assert.deepEqual(s.map((x) => x.assetId), [ID.ETH_USDC, ID.UNKNOWN], "zero Tron USDT is not listed");
  const eth = s[0];
  assert.equal(eth.token!.symbol, "USDC");
  assert.equal(eth.token!.blockchain, "eth");
  assert.equal(eth.priceUsd, 0.999527);
  assert.equal(eth.dust, false);
  assert.equal(s[1].token, null, "an id 1Click doesn't list is shown as Unknown token, never hidden");
});

test("B2 paginates while a full page comes back; no stray -> no balance read; dust flagged", async () => {
  const owned = Array.from({ length: PAGE + 3 }, (_, i) => ({ token_id: `nep141:t${i}.near` }));
  const balances = Object.fromEntries(owned.map((o) => [o.token_id, "1"]));
  const m = mockIntentsView({ owned, balances });
  const s = await readStray(ACCOUNT, m.view, TOKENS, "mainnet");
  assert.deepEqual(m.calls.filter((c) => c.method === "mt_tokens_for_owner").map((c) => c.args.from_index), ["0", String(PAGE)]);
  assert.equal(s.length, PAGE + 3);
  const none = mockIntentsView({ owned: BET6.map((token_id) => ({ token_id })) });
  assert.deepEqual(await readStray(ACCOUNT, none.view, TOKENS, "mainnet"), []);
  assert.deepEqual(none.calls.map((c) => c.method), ["mt_tokens_for_owner"]);
  const dust = mockIntentsView({ owned: [{ token_id: ID.ETH_USDC }], balances: { [ID.ETH_USDC]: "1000" } });
  assert.equal((await readStray(ACCOUNT, dust.view, TOKENS, "mainnet"))[0].dust, true, `0.001 USDC is under ${DUST_USD_CENTS} cent(s)`);
});

test("B2 is mainnet-only (the testnet intents mock has no mt_tokens_for_owner): testnet reads nothing", async () => {
  const m = mockIntentsView();
  assert.deepEqual(await readStray(ACCOUNT, m.view, TOKENS, "testnet"), []);
  assert.equal(m.calls.length, 0);
});

test("loadBalanceMap: one failing section shows 'error' and never hides or zeroes the others", async () => {
  const m = mockIntentsView({ fail: (method) => method === "mt_tokens_for_owner" });
  const map = await loadBalanceMap(ACCOUNT, {
    view: m.view, network: "mainnet", tokens: TOKENS,
    nearAccount: async () => { throw new Error("rpc"); },
    inBets: async () => ({ BTC: { units: 20000n, bets: 1 } }),
    payouts: async () => [],
    inFlight: async () => [fundRecord()],
  });
  assert.equal(map.stray, "error");
  assert.equal(map.nearAccount, "error");
  assert.deepEqual(map.inBets, { BTC: { units: 20000n, bets: 1 } });
  assert.equal((map.betting as any).USDC, 42100000n);
  assert.equal(map.inFlight.length, 1);
  const noLoaders = await loadBalanceMap(ACCOUNT, { view: mockIntentsView().view, network: "mainnet", tokens: TOKENS });
  assert.equal(noLoaders.inBets, "error", "a section we were not given is unread, not 0");
  assert.deepEqual(noLoaders.inFlight, []);
});

test("sequence guard: an older read never overwrites a newer one (MON-7)", () => {
  const seq = createSequence();
  const a = seq.next(), b = seq.next();
  assert.equal(seq.isCurrent(a), false);
  assert.equal(seq.isCurrent(b), true);
});

test("payoutsFor: my unfinished payout lines per bet, by symbol", () => {
  const lines = [
    { id: 1, bet_id: 7, token_id: ID.USDC, receiver: ACCOUNT, amount: "18200000", reason: "win", attempts: 1, done: false, in_flight: false },
    { id: 2, bet_id: 7, token_id: ID.USDC, receiver: "fee.near", amount: "1", reason: "fee", attempts: 1, done: false, in_flight: false },
    { id: 3, bet_id: 8, token_id: ID.BTC, receiver: ACCOUNT, amount: "5", reason: "win", attempts: 1, done: true, in_flight: false },
  ];
  assert.deepEqual(payoutsFor(lines, ACCOUNT), [{ betId: 7, symbol: "USDC", units: 18200000n }]);
});

test("fetchIntentsBalances: one mt_batch_balance_of on the intents contract for every enabled asset", async () => {
  const calls: any[] = [];
  const ids = listEnabledAssets().map((a) => assetId(a.symbol)!);
  const out = await fetchIntentsBalances("me.testnet", async (c: string, m: string, a: any) => { calls.push({ c, m, a }); return a.token_ids.map((id: string) => (id === assetId("USDC") ? "12550000" : "0")); });
  assert.deepEqual(calls, [{ c: INTENTS_CONTRACT_ID, m: "mt_batch_balance_of", a: { account_id: "me.testnet", token_ids: ids } }]);
  assert.equal(out.USDC, "12550000");
  assert.equal(Object.keys(out).length, ids.length);
});

test("fetchIntentsBalances falls back to per-token mt_balance_of when the batch read fails or is malformed", async () => {
  for (const batch of [async () => { throw new Error("batch down"); }, async () => null, async () => ["1"]]) {
    const calls: string[] = [];
    const out = await fetchIntentsBalances("me.testnet", async (_c: string, m: string, a: any) => {
      calls.push(m);
      if (m === "mt_batch_balance_of") return batch();
      return a.token_id === assetId("USDC") ? "7" : "0";
    });
    assert.equal(out.USDC, "7");
    assert.deepEqual(calls, ["mt_batch_balance_of", ...listEnabledAssets().map(() => "mt_balance_of")]);
  }
  await assert.rejects(fetchIntentsBalances("me.testnet", async () => { throw new Error("rpc"); }), "both reads failing still throws");
});

// ---- amounts and ≈ $ ----
test("displayAmount: stables 2 dp (down when received, up when needed), others <= 6 significant, NEAR < 0.01", () => {
  assert.equal(displayAmount("12559999", 6, "USDC"), "12.55 USDC");
  assert.equal(displayAmount("12550001", 6, "USDT", { round: "up" }), "12.56 USDT");
  assert.equal(displayAmount("0", 6, "USDC"), "0.00 USDC");
  assert.equal(displayAmount("5000", 6, "USDC"), "< 0.01 USDC");
  assert.equal(displayAmount("98500", 8, "BTC"), "0.000985 BTC");
  assert.equal(displayAmount("123456789", 8, "BTC"), "1.23456 BTC");
  assert.equal(displayAmount("123456789", 8, "BTC", { round: "up" }), "1.23457 BTC");
  assert.equal(displayAmount(1234567n * 10n ** 24n, 24, "NEAR"), "1234567 NEAR", "integer digits are never dropped");
  assert.equal(displayAmount("5000000000000000000000000", 24, "NEAR"), "5 NEAR");
  assert.equal(displayAmount("1250000000000000000000", 24, "NEAR"), "< 0.01 NEAR");
  assert.equal(displayAmount("1", 18, "ETH"), "0.000000000000000001 ETH");
  assert.equal(displayAmount("15000000", 6, "USDT", { plain: true }), "15.00");
  assert.equal(exactAmount("1250000000000000000000", 24, "NEAR"), "0.00125 NEAR");
});

test("approxUsdTotal: sums with 1Click prices, hidden (null) when any non-zero holding has no price", () => {
  assert.equal(approxUsdTotal([{ units: 42100000n, decimals: 6, priceUsd: 1 }, { units: 98500n, decimals: 8, priceUsd: 73747 }]), "114.74");
  assert.equal(approxUsdTotal([{ units: 1000000000n, decimals: 6, priceUsd: 1 }, { units: 0n, decimals: 8, priceUsd: null }]), "1,000.00", "a zero row needs no price");
  assert.equal(approxUsdTotal([{ units: 1n, decimals: 6, priceUsd: null }]), null);
  assert.equal(approxUsdTotal([]), "0.00");
  assert.equal(holdingUsdCents({ units: 5n * 10n ** 24n, decimals: 24, priceUsd: 3.65 }), 1825n);
});

test("bettingTotalUsd: the B1 total from the token list's prices; hidden when B1 is unread or a price is missing", () => {
  assert.equal(bettingTotalUsd(balanceMap(), TOKENS, "mainnet"), "182.92");
  assert.equal(bettingTotalUsd(balanceMap({ betting: "error" }), TOKENS, "mainnet"), null);
  const noBtcPrice = TOKENS.map((t) => (t.assetId === ID.BTC ? { ...t, priceUsd: null } : t));
  assert.equal(bettingTotalUsd(balanceMap(), noBtcPrice, "mainnet"), null);
  assert.equal(bettingTotalUsd(balanceMap({ betting: { USDC: 1000000n, BTC: 0n } }), noBtcPrice, "mainnet"), "0.99");
  void BALANCES;
});

test("shortAddress and etaText", () => {
  assert.equal(shortAddress("T9yDqk2ce4vX9YnFQHwKENnHjoxbuWwb"), "T9yD…uWwb");
  assert.equal(shortAddress("abc"), "abc");
  assert.equal(etaText(10), "10 s");
  assert.equal(etaText(82), "1 min");
  assert.equal(etaText(805), "13 min");
  assert.equal(etaText(3900), "1 h 5 min");
});

// F2: the landing-token rule (lib/funding/landing.ts) and the token list (lib/funding/tokens.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { betSymbolOf, defaultBetWith, resolveBetWith, betWithChoices, betTokenId, isBetTokenId, convertTargets } from "../../lib/funding/landing";
import { mapTokens, searchTokens, popularTokens, toTokenOption, loadTokens, resetTokenCache, priceMap, NETWORKS, TOKENS_STORAGE_KEY, TOKENS_MEMORY_TTL_MS, TOKENS_STORAGE_TTL_MS } from "../../lib/funding/tokens";
import { ONECLICK_TOKENS, ID } from "./fixtures";
import { readFileSync } from "node:fs";

test("same token when the origin IS a bet token (any network), else USDC", () => {
  const cases: [string, string][] = [["USDT", "USDT"], ["USDC", "USDC"], ["wNEAR", "NEAR"], ["NEAR", "NEAR"], ["BTC", "BTC"], ["ETH", "ETH"], ["ZEC", "ZEC"],
    ["TRX", "USDC"], ["SOL", "USDC"], ["WETH", "USDC"], ["WBTC", "USDC"], ["cbBTC", "USDC"], ["USDT0", "USDC"], ["USDC(DEPRECATED)", "USDC"]];
  for (const [sym, want] of cases) assert.equal(defaultBetWith({ symbol: sym }, "mainnet"), want, sym);
  assert.equal(betSymbolOf({ symbol: "XRP" }), null);
});

test("the Bet with picker offers only the 6 (only the live ones on testnet), and a ?need hand-off locks it", () => {
  assert.deepEqual(betWithChoices("mainnet"), ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  assert.deepEqual(betWithChoices("testnet"), ["USDC", "NEAR"]);
  assert.deepEqual(betWithChoices("mainnet", "USDT"), ["USDT"]);
});

test("resolveBetWith: default, pick, lock, and refusals (never lands outside the 6)", () => {
  const tronUsdt = { symbol: "USDT" };
  assert.deepEqual(resolveBetWith({ origin: tronUsdt, network: "mainnet" }), { ok: true, symbol: "USDT", destinationAsset: ID.USDT, locked: false, sameToken: true });
  assert.deepEqual(resolveBetWith({ origin: { symbol: "SOL" }, network: "mainnet" }), { ok: true, symbol: "USDC", destinationAsset: ID.USDC, locked: false, sameToken: false });
  assert.deepEqual(resolveBetWith({ origin: { symbol: "SOL" }, picked: "BTC", network: "mainnet" }), { ok: true, symbol: "BTC", destinationAsset: ID.BTC, locked: false, sameToken: false });
  assert.deepEqual(resolveBetWith({ origin: { symbol: "SOL" }, locked: "ZEC", network: "mainnet" }), { ok: true, symbol: "ZEC", destinationAsset: ID.ZEC, locked: true, sameToken: false });
  assert.deepEqual(resolveBetWith({ origin: tronUsdt, picked: "SOL", network: "mainnet" }), { ok: false, reason: "not_a_bet_token" });
  assert.deepEqual(resolveBetWith({ origin: tronUsdt, picked: "USDC", locked: "USDT", network: "mainnet" }), { ok: false, reason: "locked_to_other" });
  assert.deepEqual(resolveBetWith({ origin: tronUsdt, network: "testnet" }), { ok: true, symbol: "USDC", destinationAsset: "nep141:usdc.testnet", locked: false, sameToken: false }, "USDT isn't live on testnet: default USDC");
  assert.deepEqual(resolveBetWith({ origin: tronUsdt, picked: "BTC", network: "testnet" }), { ok: false, reason: "not_on_network" });
});

test("bet token ids are the escrow's whitelist; a bridged look-alike id is not a bet token", () => {
  assert.equal(betTokenId("USDC", "mainnet"), ID.USDC);
  assert.equal(betTokenId("BTC", "testnet"), null);
  assert.equal(isBetTokenId(ID.ETH_USDC, "mainnet"), false);
  assert.equal(isBetTokenId(ID.TRON_USDT, "mainnet"), false);
  assert.equal(isBetTokenId(ID.NEAR, "mainnet"), true);
});

test("Convert lands only in the 6: a stray USDC (Ethereum) defaults to USDC; a bet token can't convert to itself", () => {
  assert.deepEqual(convertTargets({ assetId: ID.ETH_USDC, symbol: "USDC" }, "mainnet"), { choices: ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"], default: "USDC" });
  assert.deepEqual(convertTargets({ assetId: ID.USDT, symbol: "USDT" }, "mainnet"), { choices: ["USDC", "NEAR", "BTC", "ETH", "ZEC"], default: "USDC" });
  assert.equal(convertTargets({ assetId: ID.XRP, symbol: "XRP" }, "mainnet").default, "USDC");
});

// ---- tokens ----
test("token list: 1cs_v1 pseudo-assets, DEPRECATED rows and unknown chains are hidden; wNEAR shows as NEAR; memo chains flagged", () => {
  const list = mapTokens([...ONECLICK_TOKENS, { assetId: "nep141:x.near", decimals: 6, blockchain: "martian", symbol: "MRS", price: 1 }, { assetId: "nep245:v2_1.omni.hot.tg:56_x", decimals: 18, blockchain: "bsc", symbol: "USDC(DEPRECATED)", price: 1 }]);
  assert.ok(!list.some((t) => t.assetId === ID.PSEUDO));
  assert.ok(!list.some((t) => t.blockchain === "martian"));
  assert.ok(!list.some((t) => /DEPRECATED/.test(t.symbol)));
  const near = list.find((t) => t.assetId === ID.NEAR)!;
  assert.equal(near.symbol, "NEAR");
  assert.equal(near.betSymbol, "NEAR");
  assert.equal(list.find((t) => t.assetId === ID.XRP)!.memoChain, true);
  assert.equal(list.find((t) => t.assetId === ID.TRON_USDT)!.exchangeNetworkName, "Tron (TRC-20)");
  assert.equal(list.find((t) => t.assetId === ID.TRON_USDT)!.betSymbol, "USDT");
  assert.equal(list.find((t) => t.assetId === ID.TRX)!.betSymbol, null);
  assert.equal(toTokenOption({ assetId: "nep141:z.near", decimals: 6, blockchain: "near", symbol: "Z", price: 0 })!.priceUsd, null, "a 0 price is no price");
});

test("popular order follows the SPEC list; Tron USDT first", () => {
  const pop = popularTokens(mapTokens(ONECLICK_TOKENS)).map((t) => `${t.symbol}@${t.blockchain}`);
  assert.deepEqual(pop, ["USDT@tron", "USDC@eth", "USDC@base", "USDC@sol", "USDT@eth", "BTC@btc", "ETH@eth", "ETH@base", "SOL@sol", "NEAR@near", "USDC@near", "ZEC@zec"]);
  assert.equal(mapTokens(ONECLICK_TOKENS)[0].assetId, ID.TRON_USDT, "the full list also leads with the popular ones");
});

test("search: symbol, network, exchange aliases (trc20, erc20, bep20), multi-word, and ?need preference", () => {
  const list = mapTokens(ONECLICK_TOKENS);
  assert.deepEqual(searchTokens(list, "trc20").map((t) => t.assetId).sort(), [ID.TRON_USDT, ID.TRX].sort());
  assert.ok(searchTokens(list, "erc20").every((t) => t.blockchain === "eth"));
  assert.deepEqual(searchTokens(list, "usdt tron").map((t) => t.assetId), [ID.TRON_USDT]);
  assert.deepEqual(searchTokens(list, "ARBITRUM").map((t) => t.assetId), [ID.ARB_USDC]);
  assert.equal(searchTokens(list, "nothing-like-this").length, 0);
  const pref = searchTokens(list, "", "USDT");
  assert.ok(pref.slice(0, 3).every((t) => t.symbol === "USDT"), "every USDT network first for a USDT bet");
});

test("every chain 1Click lists (FUND3 evidence, 39) has a network name, so nothing real is hidden", () => {
  const live = JSON.parse(readFileSync(new URL("../../../../spikes/fund3/evidence/oneclick/tokens.json", import.meta.url), "utf8"));
  const chains = [...new Set(live.map((t: any) => t.blockchain))] as string[];
  assert.equal(chains.length, 39);
  for (const c of chains) assert.ok(NETWORKS[c], `no name for ${c}`);
  const hidden = live.filter((t: any) => t.assetId.startsWith("1cs_v1:") || /DEPRECATED/.test(t.symbol)).length;
  assert.equal(hidden, 43, "27 1cs_v1 pseudo-assets + 16 DEPRECATED rows in the 2026-11-11 list");
  assert.equal(mapTokens(live).length, live.length - hidden, "only those are hidden");
});

class MemStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }

test("loadTokens: 5 min memory cache, then network, then the 24 h localStorage copy when the network fails", async () => {
  resetTokenCache();
  const s = new MemStorage();
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, status: 200, json: async () => ONECLICK_TOKENS }; };
  const fail = async () => { calls++; throw new Error("offline"); };
  const t0 = 1_000_000;
  const a = await loadTokens({ fetch: ok, storage: s, now: () => t0 });
  assert.equal(a.stale, false);
  assert.ok(s.getItem(TOKENS_STORAGE_KEY));
  await loadTokens({ fetch: ok, storage: s, now: () => t0 + 1000 });
  assert.equal(calls, 1, "served from memory");
  const b = await loadTokens({ fetch: fail, storage: s, now: () => t0 + TOKENS_MEMORY_TTL_MS + 1 });
  assert.equal(b.stale, true);
  assert.equal(b.list.length, a.list.length);
  await assert.rejects(loadTokens({ fetch: fail, storage: s, now: () => t0 + TOKENS_STORAGE_TTL_MS + 1 }), "a day-old copy is not used");
  await assert.rejects(loadTokens({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), storage: null, now: () => t0 + TOKENS_STORAGE_TTL_MS * 2 }));
  resetTokenCache();
  assert.equal(priceMap(a.list).get(ID.BTC), 73747);
});

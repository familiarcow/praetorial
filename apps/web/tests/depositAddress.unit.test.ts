// FE2c / D-FUND1: per-asset deposit address (NEAR Intents POA deposit API), the "Move to betting balance" tx builder, rule (1).
import { NETWORKS } from "../lib/network";
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEPOSIT_API_URL, DEPOSIT_ROUTES, depositWording, fetchDepositOption, fetchAllDepositOptions, depositApiEnabled, isNearAccountLike,
} from "../lib/depositAddress";
import { buildMoveSteps, movableHoldings, NEAR_SPENDABLE_RESERVE_YOCTO } from "../lib/moveToBetting";
import { INTENTS_CONTRACT_ID } from "../lib/config";
import { assetId } from "../lib/assets";
import { readFileSync } from "node:fs";

const ME = "11".repeat(32);
const TOKENS = { result: { tokens: [
  { defuse_asset_identifier: "btc:mainnet:native", asset_name: "BTC", min_deposit_amount: "5000", decimals: 8, intents_token_id: "nep141:btc.omft.near" },
  { defuse_asset_identifier: "zec:mainnet:native", asset_name: "ZEC", min_deposit_amount: "1000000", decimals: 8, intents_token_id: "nep141:zec.omft.near" },
  { defuse_asset_identifier: "eth:1:native", asset_name: "ETH", min_deposit_amount: "100000000000", decimals: 18, intents_token_id: "nep141:eth.omft.near" },
  { defuse_asset_identifier: "eth:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", asset_name: "USDC", min_deposit_amount: "1000", decimals: 6, intents_token_id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near" },
  { defuse_asset_identifier: "eth:1:0xdac17f958d2ee523a2206206994597c13d831ec7", asset_name: "USDT", min_deposit_amount: "1000", decimals: 6, intents_token_id: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near" },
  { defuse_asset_identifier: "near:mainnet:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", asset_name: "USDC", min_deposit_amount: "1", decimals: 6, intents_token_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" },
  { defuse_asset_identifier: "near:mainnet:usdt.tether-token.near", asset_name: "USDT", min_deposit_amount: "1", decimals: 6, intents_token_id: "nep141:usdt.tether-token.near" },
  { defuse_asset_identifier: "near:mainnet:native", asset_name: "NEAR", min_deposit_amount: "100000000000000000000", decimals: 24, intents_token_id: "nep141:wrap.near" },
] } };
const ADDR: Record<string, string> = {
  "btc:mainnet": "bc1qvymvh8l7a5esd3mx69m2p0fnm8qyz64ljt8ugs", "zec:mainnet": "t1fCTLPgx2SHS6gjg42LPE2FJnxPykb1d83",
  "eth:1": "0x" + "ab".repeat(20), "near:mainnet": "e7bfbcdd109c023535a272d7ebf09f1faddfdaf96dd91f64b26bf021506c2a11",
};

type Call = { url: string; method: string; body: any };
function mockFetch(opts: { calls?: Call[]; depositResp?: (p: any) => any; tokensResp?: any; status?: number } = {}) {
  return (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    opts.calls?.push({ url, method: init.method, body });
    const status = opts.status ?? 200;
    let json: any;
    if (body.method === "supported_tokens") json = opts.tokensResp ?? TOKENS;
    else if (body.method === "deposit_address") json = opts.depositResp ? opts.depositResp(body.params[0]) : { result: { address: ADDR[body.params[0].chain], chain: body.params[0].chain } };
    else json = { error: "nope" };
    return { ok: status === 200, status, json: async () => json };
  }) as any;
}

test("six launch assets each have a route (chain + asset), no testnet ids", () => {
  assert.deepEqual(Object.keys(DEPOSIT_ROUTES).sort(), ["BTC", "ETH", "NEAR", "USDC", "USDT", "ZEC"]);
  assert.equal(DEPOSIT_API_URL, "https://bridge.chaindefuser.com/rpc");
});

test("success: posts deposit_address with the USER's intents account + chain, returns address, chain label and min deposit", async () => {
  const calls: Call[] = [];
  const o = await fetchDepositOption("BTC", ME, mockFetch({ calls }));
  assert.equal(o.ok, true);
  if (!o.ok) return;
  assert.equal(o.address, ADDR["btc:mainnet"]);
  assert.equal(o.chainLabel, "Bitcoin");
  assert.equal(o.minDepositUnits, "5000");
  assert.equal(o.minDepositLabel, "0.00005 BTC");
  const dep = calls.find((c) => c.body.method === "deposit_address")!;
  assert.equal(dep.method, "POST");
  assert.equal(dep.url, DEPOSIT_API_URL);
  assert.deepEqual(dep.body.params, [{ account_id: ME, chain: "btc:mainnet" }]);
});

test("every asset resolves with its own chain and min (DEPFIX1: USDC/USDT come in on NEAR, never Ethereum)", async () => {
  const all = await fetchAllDepositOptions(ME, mockFetch());
  assert.deepEqual(Object.keys(all).sort(), ["BTC", "ETH", "NEAR", "USDC", "USDT", "ZEC"]);
  for (const [sym, o] of Object.entries(all)) { assert.equal(o.ok, true, sym); }
  for (const sym of ["USDC", "USDT"]) {
    const o = all[sym]; if (!o.ok) throw new Error(sym);
    assert.equal(o.chain, "near:mainnet");
    assert.equal(o.chainLabel, "NEAR");
    assert.equal(o.minDepositLabel, `0.000001 ${sym}`);
    assert.equal(o.creditedTokenId, assetId(sym, "mainnet"));
  }
});

// DEPFIX1 (FUND3 F1, LIVE P0): the Ethereum USDC/USDT addresses credited eth-0x….omft.near bridged tokens the escrow rejects.
const MAINNET_ARGS = JSON.parse(readFileSync(new URL("../../../release/mainnet-night/args.mainnet.json", import.meta.url), "utf8"));
const ESCROW_TOKENS: string[] = MAINNET_ARGS.asset_limits.map(([id]: [string]) => id);

test("DEPFIX1 F1: USDC and USDT never offer an EVM (or any non-NEAR) route", () => {
  for (const sym of ["USDC", "USDT"]) {
    const r = DEPOSIT_ROUTES[sym];
    assert.notEqual(r.kind, "evm", sym);
    assert.equal(r.chain, "near:mainnet", sym);
    assert.ok(!r.chain.startsWith("eth:") && !r.defuseId.startsWith("eth:"), sym);
    assert.ok(!/omft\.near/.test(r.creditedTokenId), `${sym} must not credit a bridged omft token`);
  }
});

test("DEPFIX1: each route credits exactly the escrow's launch token id (release/mainnet-night/args.mainnet.json)", () => {
  assert.equal(ESCROW_TOKENS.length, 6);
  for (const [sym, r] of Object.entries(DEPOSIT_ROUTES)) {
    assert.ok(ESCROW_TOKENS.includes(r.creditedTokenId), `${sym} credits ${r.creditedTokenId}, which the escrow does not accept`);
    assert.equal(r.creditedTokenId, assetId(sym, "mainnet"), `${sym} credited id differs from the app's mainnet asset id`);
  }
  assert.deepEqual(Object.values(DEPOSIT_ROUTES).map((r) => r.creditedTokenId).sort(), [...ESCROW_TOKENS].sort());
});

test("DEPFIX1: the route table matches the live bridge mapping (FUND3 evidence supported_tokens_all.json)", () => {
  const live = JSON.parse(readFileSync(new URL("../../../spikes/fund3/evidence/poa/supported_tokens_all.json", import.meta.url), "utf8"));
  const tokens: any[] = (live.result ?? live).tokens;
  for (const [sym, r] of Object.entries(DEPOSIT_ROUTES)) {
    const hit = tokens.find((t) => t.defuse_asset_identifier === r.defuseId && t.intents_token_id === r.creditedTokenId);
    assert.ok(hit, `${sym}: bridge does not map ${r.defuseId} -> ${r.creditedTokenId}`);
  }
});

test("DEPFIX1: a bridge entry that credits a different token id than the route expects is refused (fail closed)", async () => {
  const bridged = { result: { tokens: [{ ...TOKENS.result.tokens.find((t) => t.asset_name === "USDC" && t.defuse_asset_identifier.startsWith("near:"))!, intents_token_id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near" }] } };
  const o = await fetchDepositOption("USDC", ME, mockFetch({ tokensResp: bridged }));
  assert.equal(o.ok, false);
  if (!o.ok) assert.equal(o.reason, "unsupported");
});

test("DEPFIX1: with two entries for one source (live BTC: nbtc.bridge.near and btc.omft.near) the one crediting the escrow token is used", async () => {
  const two = { result: { tokens: [
    { defuse_asset_identifier: "btc:mainnet:native", min_deposit_amount: "9999", decimals: 8, intents_token_id: "nep141:nbtc.bridge.near" },
    { defuse_asset_identifier: "btc:mainnet:native", min_deposit_amount: "5000", decimals: 8, intents_token_id: "nep141:btc.omft.near" },
  ] } };
  const o = await fetchDepositOption("BTC", ME, mockFetch({ tokensResp: two }));
  assert.equal(o.ok, true);
  if (o.ok) { assert.equal(o.minDepositUnits, "5000"); assert.equal(o.creditedTokenId, "nep141:btc.omft.near"); }
});

test("DEPFIX1 F2/F6/F7: deposit wording per asset: network badge, only-this-network warning, minimum warning, EVM note only for EVM", () => {
  const usdc = depositWording("USDC", "NEAR", "evm" === DEPOSIT_ROUTES.USDC.kind, "0.000001 USDC");
  assert.equal(usdc.badge, "NEAR network");
  assert.equal(usdc.send, "Send USDC on NEAR to this address. It lands in your betting balance.");
  assert.equal(usdc.onlyNetwork, "Only send USDC on the NEAR network. Other networks won't reach your betting balance.");
  assert.equal(usdc.minimum, "Minimum 0.000001 USDC — smaller deposits are not credited.");
  assert.equal(usdc.evmNote, null);
  const eth = depositWording("ETH", "Ethereum", true, "0.0000001 ETH");
  assert.equal(eth.onlyNetwork, "Only send ETH on the Ethereum network. Other networks won't reach your betting balance.");
  assert.match(eth.evmNote!, /Base, Arbitrum, BNB/);
  assert.match(eth.evmNote!, /only ETH sent on Ethereum/);
  for (const sym of ["BTC", "ZEC", "NEAR", "USDT"]) assert.equal(depositWording(sym, DEPOSIT_ROUTES[sym].chainLabel, DEPOSIT_ROUTES[sym].kind === "evm", "1 " + sym).evmNote, null, sym);
  // ETH is the only EVM route left.
  assert.deepEqual(Object.entries(DEPOSIT_ROUTES).filter(([, r]) => r.kind === "evm").map(([s]) => s), ["ETH"]);
});

test("wrong recipient: a response that names a different account is refused (fail closed)", async () => {
  const o = await fetchDepositOption("ZEC", ME, mockFetch({ depositResp: (p) => ({ result: { address: ADDR[p.chain], chain: p.chain, account_id: "attacker.near" } }) }));
  assert.equal(o.ok, false);
  if (o.ok) return;
  assert.equal(o.reason, "wrong_recipient");
});
test("wrong chain in the response is refused", async () => {
  const o = await fetchDepositOption("BTC", ME, mockFetch({ depositResp: () => ({ result: { address: ADDR["eth:1"], chain: "eth:1" } }) }));
  assert.equal(o.ok, false);
  if (!o.ok) assert.equal(o.reason, "wrong_recipient");
});
test("rule 1: an address equal to the user's own NEAR account id is never accepted as a deposit address", async () => {
  const o = await fetchDepositOption("NEAR", ME, mockFetch({ depositResp: () => ({ result: { address: ME, chain: "near:mainnet" } }) }));
  assert.equal(o.ok, false);
  if (!o.ok) assert.equal(o.reason, "wrong_recipient");
});
test("malformed address for the chain (e.g. a .near name for BTC) is refused", async () => {
  const o = await fetchDepositOption("BTC", ME, mockFetch({ depositResp: () => ({ result: { address: "alice.near", chain: "btc:mainnet" } }) }));
  assert.equal(o.ok, false);
});
test("error: API error body, http failure and a thrown fetch all fail closed with a plain message", async () => {
  for (const f of [
    mockFetch({ depositResp: () => ({ error: "boom" }) }),
    mockFetch({ status: 500 }),
    (async () => { throw new Error("net"); }) as any,
  ]) {
    const o = await fetchDepositOption("ETH", ME, f);
    assert.equal(o.ok, false);
    if (!o.ok) { assert.equal(o.reason, "error"); assert.match(o.message, /can't get a deposit address/i); }
  }
});
test("unsupported: 'Chain not supported' or an asset missing from supported_tokens -> unsupported, no address shown", async () => {
  const a = await fetchDepositOption("ETH", ME, mockFetch({ depositResp: () => ({ error: "Chain not supported" }) }));
  assert.equal(a.ok, false); if (!a.ok) assert.equal(a.reason, "unsupported");
  const b = await fetchDepositOption("ZEC", ME, mockFetch({ tokensResp: { result: { tokens: [] } } }));
  assert.equal(b.ok, false); if (!b.ok) assert.equal(b.reason, "unsupported");
});
test("a missing min deposit also fails closed (we always show the minimum)", async () => {
  const o = await fetchDepositOption("BTC", ME, mockFetch({ tokensResp: { result: { tokens: [{ ...TOKENS.result.tokens[0], min_deposit_amount: undefined }] } } }));
  assert.equal(o.ok, false);
});

test("D-FUND1 (4): the deposit API is mainnet-only (testnet has no deposit addresses: bridge answers 'Chain not supported' for near:testnet)", () => {
  assert.equal(depositApiEnabled("mainnet"), true);
  assert.equal(depositApiEnabled("testnet"), false);
});

test("rule 1: the Wallet page (NAV1, was AddMoney) never labels a NEAR account id as a deposit address; the old account-as-address copy is gone", () => {
  const src = readFileSync(new URL("../src/components/WalletPage.tsx", import.meta.url), "utf8");
  assert.ok(!/\{account\}<\/code>/.test(src), "account id rendered in a <code> block");
  assert.ok(!/writeText\(account\)/.test(src), "account id copied as an address");
  assert.ok(!/Send money to your Praetorial address/.test(src));
  // F3 (familiarcow UX-37 / SM2 F3-5): the account id is shown and copyable only in the collapsed "Account details" row, labelled as the
  // account ID (never as a deposit address).
  const head = readFileSync(new URL("../src/components/wallet/AccountHeader.tsx", import.meta.url), "utf8");
  const details = head.slice(head.indexOf("<Disclosure title={COPY.account.accountDetails}"), head.indexOf("</Disclosure>"));
  assert.ok(details.includes("writeText(account)") === false && details.includes("onClick={copyId}") && details.includes("Copy account ID"));
  assert.equal(head.split("{account}</code>").length - 1, 1, "the id is rendered exactly once, inside Account details");
  assert.ok(head.indexOf("{account}</code>") > head.indexOf("<Disclosure title={COPY.account.accountDetails}"));
  assert.ok(!/deposit address/i.test(head));
  assert.ok(isNearAccountLike(ME) && isNearAccountLike("alice.near") && isNearAccountLike("bob.testnet"));
  assert.ok(!isNearAccountLike("bc1qvymvh8l7a5esd3mx69m2p0fnm8qyz64ljt8ugs") && !isNearAccountLike("0x" + "ab".repeat(20)));
});

// ---- path 3: Move to betting balance ----
const USDC = assetId("USDC", "mainnet")!.replace("nep141:", "");
test("buildMoveSteps USDC/USDT/NEAR(wNEAR): exact receiver, method, args, 1 yocto deposit", () => {
  for (const [sym, net] of [["USDC", "mainnet"], ["USDT", "mainnet"], ["NEAR", "mainnet"], ["USDC", "testnet"], ["NEAR", "testnet"]] as const) {
    const tok = assetId(sym, net)!.replace("nep141:", "");
    const steps = buildMoveSteps({ symbol: sym, account: ME, amountUnits: "1234567", source: "token", network: net });
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0], {
      receiverId: tok, methodName: "ft_transfer_call",
      args: { receiver_id: NETWORKS[net].intents /* INTENTS1: the intents contract OF that network */, amount: "1234567", msg: JSON.stringify({ receiver_id: ME }) },
      depositYocto: "1", gasTgas: 100,
    });
  }
});
test("native NEAR is wrapped first: near_deposit on the wrap contract with the amount attached, then the ft_transfer_call", () => {
  const steps = buildMoveSteps({ symbol: "NEAR", account: ME, amountUnits: "2000000000000000000000000", source: "native", network: "mainnet" });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { receiverId: "wrap.near", methodName: "near_deposit", args: {}, depositYocto: "2000000000000000000000000", gasTgas: 30 });
  assert.equal(steps[1].receiverId, "wrap.near");
  assert.equal(steps[1].methodName, "ft_transfer_call");
  assert.equal(steps[1].args.amount, "2000000000000000000000000");
  assert.equal(steps[1].depositYocto, "1");
});
// F3 / SM1 MON-3: BTC/ETH/ZEC omft tokens left on the NEAR account CAN be moved back on mainnet (tests/account.unit.test.ts); where a
// token has no NEAR id (testnet) or isn't a launch asset, the move is still refused.
test("buildMoveSteps refuses assets with no NEAR token on the network, non-launch assets, zero/invalid amounts, and native source for non-NEAR", () => {
  for (const s of ["BTC", "ETH", "ZEC"]) assert.throws(() => buildMoveSteps({ symbol: s, account: ME, amountUnits: "1", source: "token", network: "testnet" }));
  assert.throws(() => buildMoveSteps({ symbol: "SOL", account: ME, amountUnits: "1", source: "token", network: "mainnet" }));
  assert.throws(() => buildMoveSteps({ symbol: "BTC", account: ME, amountUnits: "1", source: "native", network: "mainnet" }));
  assert.throws(() => buildMoveSteps({ symbol: "USDC", account: ME, amountUnits: "0", source: "token", network: "mainnet" }));
  assert.throws(() => buildMoveSteps({ symbol: "USDC", account: ME, amountUnits: "1.5", source: "token", network: "mainnet" }));
  assert.throws(() => buildMoveSteps({ symbol: "USDC", account: ME, amountUnits: "1", source: "native", network: "mainnet" }));
  void USDC;
});

test("movableHoldings: shown only for launch assets actually held in the NEAR account (native NEAR minus the reserve)", async () => {
  const net = "mainnet" as const;
  const bal: Record<string, string> = { [USDC]: "7000000", "usdt.tether-token.near": "0", "wrap.near": "0" };
  const view = async (c: string, m: string, a: any) => { assert.equal(m, "ft_balance_of"); assert.equal(a.account_id, ME); return bal[c] ?? "0"; };
  const reserve = NEAR_SPENDABLE_RESERVE_YOCTO;
  const none = await movableHoldings(ME, net, async () => "0", async () => reserve);
  assert.deepEqual(none, []);
  const some = await movableHoldings(ME, net, view, async () => reserve + 3_000_000_000_000_000_000_000_000n);
  assert.deepEqual(some.map((h) => [h.symbol, h.source, h.amountUnits]), [["USDC", "token", "7000000"], ["NEAR", "native", "3000000000000000000000000"]]);
  const wn = await movableHoldings(ME, net, async (c) => (c === "wrap.near" ? "5" : "0"), async () => null);
  assert.deepEqual(wn.map((h) => [h.symbol, h.source, h.amountUnits]), [["NEAR", "token", "5"]]);
});
test("movableHoldings: a failed read hides the section instead of guessing", async () => {
  const r = await movableHoldings(ME, "mainnet", async () => { throw new Error("rpc"); }, async () => 0n);
  assert.deepEqual(r, []);
});

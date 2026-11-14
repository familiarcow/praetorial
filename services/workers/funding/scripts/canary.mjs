#!/usr/bin/env node
// F1 dry-quote canary (SPEC §7.5 "Live (no money)"): asks 1Click DIRECTLY for dry quotes on the popular Add money / Cash out routes
// with the exact request shape the funding Worker sends (recipient/refundTo = a placeholder implicit id, INTENTS). No key, nothing
// submitted, no address issued. Manual / CI only (no cron). Exit 1 if a route stops quoting.
// Usage: node services/workers/funding/scripts/canary.mjs
const BASE = process.env.ONECLICK_BASE_URL || "https://1click.chaindefuser.com";
const UA = `praetorial-funding/canary-${process.env.GIT_SHA || "local"}`;
const ACC = "0000000000000000000000000000000000000000000000000000000000000001";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const deadline = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const fund = (name, originAsset, destinationAsset, amount, h = 1) => ({ name, body: { dry: true, swapType: "FLEX_INPUT", slippageTolerance: 100, originAsset, depositType: "ORIGIN_CHAIN", destinationAsset, amount, refundTo: ACC, refundType: "INTENTS", recipient: ACC, recipientType: "INTENTS", deadline: deadline(h), referral: "praetorial" } });
const ROUTES = [
  fund("Tron USDT -> USDC", "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", USDC, "20000000"),
  fund("Tron USDT -> USDT", "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", "nep141:usdt.tether-token.near", "20000000"),
  fund("Base USDC -> USDC", "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", USDC, "20000000"),
  fund("SOL -> USDC", "nep141:sol.omft.near", USDC, "200000000"),
  fund("BTC -> BTC", "nep141:btc.omft.near", "nep141:btc.omft.near", "100000", 3),
  { name: "Cash out USDC -> USDT on Tron", body: { dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: USDC, depositType: "INTENTS", destinationAsset: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", amount: "20000000", refundTo: ACC, refundType: "INTENTS", recipient: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", recipientType: "DESTINATION_CHAIN", deadline: deadline(0.5), referral: "praetorial" } },
];
let bad = 0;
for (const r of ROUTES) {
  try {
    const res = await fetch(`${BASE}/v0/quote`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA }, body: JSON.stringify(r.body), signal: AbortSignal.timeout(20_000) });
    const j = await res.json().catch(() => ({}));
    if (res.status !== 201 && res.status !== 200) { bad++; console.log(`FAIL ${r.name}: HTTP ${res.status} ${j.message ?? ""}`); continue; }
    console.log(`PASS ${r.name}: in ${j.quote.amountIn} -> out ${j.quote.amountOut} (min ${j.quote.minAmountOut}), ~${j.quote.timeEstimate}s`);
  } catch (e) { bad++; console.log(`FAIL ${r.name}: ${e?.name ?? e}`); }
}
process.exit(bad ? 1 : 0);

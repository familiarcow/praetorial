// F1 x F2 contract: the web's REAL client (apps/web/lib/funding/fundingClient.ts, landed by F2) talks to this Worker's real handler
// (mocked 1Click). Every response shape the web parses is produced by the Worker: quotes, list records, status, intent/submit,
// error codes (+ minUnits), health. If either side drifts, this fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { hashNep413Payload } from "../../../common/src/funding/intentCheck.js";
import { handleFunding } from "../src/core.js";
import { ACCOUNT, IP, NOW, ORIGIN, TRON_USDT, USDC, USER_KEYS, genFor, harness, throwing, type Harness } from "./helpers.js";

// runtime import (outside the services tsconfig rootDir, so not type-checked here; the web's own tsc covers it)
const WEB_CLIENT = new URL("../../../../apps/web/lib/funding/fundingClient.ts", import.meta.url).href;
const { createFundingClient, FundingError } = (await import(WEB_CLIENT)) as any;

const clientFor = (h: Harness) => createFundingClient({
  baseUrl: "https://funding.test",
  now: () => h.deps.nowMs(), // F4 (SM2 F4-2): the web maps lastStatus itself, expiry on the same (fake) clock as the Worker
  fetch: (url: string, init?: any) => handleFunding(new Request(url, { ...init, headers: { ...(init?.headers ?? {}), origin: ORIGIN, "cf-connecting-ip": IP } }), h.deps),
});

test("fund: dry + real quote parse; list returns a web SwapRecord; status parses into the web StatusView", async () => {
  const h = harness(); const c = clientFor(h);
  const dry = await c.fundQuote({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "50000000", dry: true } as any);
  assert.equal(dry.depositAddress, null);
  assert.equal(dry.amountOut, "49950000");
  const real = await c.fundQuote({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "50000000", dry: false } as any);
  assert.ok(real.depositAddress);
  const list = await c.list(ACCOUNT);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.state, "waiting");
  assert.equal(list[0]!.origin.symbol, "USDT");
  h.fake.statusOf.set(real.depositAddress!, { correlationId: "c", quoteResponse: {}, status: "SUCCESS", updatedAt: new Date(NOW).toISOString(), swapDetails: { amountOut: "49950000", depositedAmount: "50000000", destinationChainTxHashes: [{ hash: "h", explorerUrl: "https://e" }] } });
  const st = await c.status(real.depositAddress!, null);
  assert.equal(st.status, "SUCCESS");
  assert.equal(st.amountOut, "49950000");
  assert.equal(st.depositedAmount, "50000000");
  assert.equal(st.destinationTxs.length, 1);
  assert.equal((await c.list(ACCOUNT))[0]!.state, "credited");
});

test("errors reach the web as its codes: too_low (+ minUnits), no_route, rate_limited (+ retryAfter), not_found", async () => {
  const h = harness(); const c = clientFor(h);
  h.fake.onQuote = () => throwing(400, "Amount is too low for bridge, try at least 1867652");
  await assert.rejects(c.fundQuote({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "10000", dry: true } as any), (e: any) => e instanceof FundingError && e.code === "too_low" && (e as any).minUnits === "1867652");
  h.fake.onQuote = () => throwing(400, "Quoting for this pair is not available");
  await assert.rejects(c.fundQuote({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "10000", dry: true } as any), (e: any) => e.code === "no_route");
  await assert.rejects(c.status("not-ours", null), (e: any) => e.code === "not_found");
  const h2 = harness(); const c2 = clientFor(h2);
  for (let i = 0; i < 60; i++) await c2.fundQuote({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "50000000", dry: true } as any);
  await assert.rejects(c2.fundQuote({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "50000000", dry: true } as any), (e: any) => e.code === "rate_limited" && (e as any).retryAfterSec > 0);
});

test("cash out: quote -> intent -> sign -> submit with the web client's request shapes (submit sends no account)", async () => {
  const h = harness(); const c = clientFor(h);
  h.balances.set(`${ACCOUNT}|${USDC}`, 50_000_000n);
  const q = await c.withdrawQuote({ account: ACCOUNT, kind: "withdraw", originAsset: USDC, amountIn: "20000000", destinationAsset: TRON_USDT, recipient: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", dry: false } as any);
  genFor.set(q.depositAddress!, { originAsset: USDC, amountIn: "20000000" });
  const i = await c.withdrawIntent(ACCOUNT, q.depositAddress!);
  const payload = (i.intent as any).payload;
  const signed = { standard: "nep413", payload, public_key: `ed25519:${bs58.encode(USER_KEYS.publicKey)}`, signature: `ed25519:${bs58.encode(nacl.sign.detached(hashNep413Payload(payload), USER_KEYS.secretKey))}` };
  assert.equal((await c.withdrawSubmit(q.depositAddress!, signed)).intentHash, "IntentHash111");
  assert.equal((await c.list(ACCOUNT))[0]!.signed, true);
});

test("health: keyConfigured reaches the web client", async () => {
  // /health is answered by index.ts, not the core: check the field name the web reads is the one index.ts emits
  const src = (await import("node:fs")).readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /keyConfigured: !!str\(env\.ONECLICK_API_KEY\)/);
});

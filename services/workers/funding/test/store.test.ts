// F1: FundingState (records + limiter) and the Durable Object RPC shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FundingState, memoryKv, type SwapRecord } from "../src/store.js";
import { FundingStoreDO } from "../src/index.js";
import { doStore } from "../src/env.js";
import { nsOf } from "../../common/test/healthAssert.js";

const NOW = 1_800_000_000_000;
const rec = (o: Partial<SwapRecord> = {}): SwapRecord => ({
  depositAddress: "addr1", depositMemo: null, account: "a".repeat(64), kind: "fund", originAsset: "x", destinationAsset: "y", amountIn: "1", minAmountIn: "1",
  amountOut: "1", minAmountOut: "1", recipient: "a".repeat(64), deadline: new Date(NOW + 3_600_000).toISOString(), createdAt: NOW, updatedAt: NOW,
  status: "PENDING_DEPOSIT", correlationId: "c", signedQuote: {}, intentPayload: null, intentHash: null, submittedAt: null, lastError: null, ...o,
});

test("consume is atomic: a refusal on one rule consumes nothing on the others; windows reset", async () => {
  const s = new FundingState(memoryKv());
  const rules = [{ key: "a", limit: 5, windowMs: 60_000 }, { key: "b", limit: 1, windowMs: 60_000 }];
  assert.equal((await s.consume(rules, NOW)).ok, true);
  const r = await s.consume(rules, NOW);
  assert.equal(r.ok, false);
  assert.equal((r as any).key, "b");
  for (let i = 0; i < 4; i++) assert.equal((await s.consume([rules[0]!], NOW)).ok, true, "a was not charged by the refused call");
  assert.equal((await s.consume([rules[0]!], NOW)).ok, false);
  assert.equal((await s.consume(rules, NOW + 60_000)).ok, true);
});

test("insert refuses a reused address; patch cannot change owner/kind/address; list hides old terminal records", async () => {
  const s = new FundingState(memoryKv());
  assert.equal(await s.insert(rec()), true);
  assert.equal(await s.insert(rec({ account: "b".repeat(64) })), false);
  const p = await s.patch("addr1", { account: "b".repeat(64), kind: "withdraw", status: "SUCCESS", updatedAt: NOW } as any);
  assert.equal(p!.account, "a".repeat(64));
  assert.equal(p!.kind, "fund");
  assert.equal((await s.listAccount("a".repeat(64), NOW + 29 * 86_400_000)).length, 1);
  assert.equal((await s.listAccount("a".repeat(64), NOW + 31 * 86_400_000)).length, 0);
  assert.equal(await s.patch("nope", {}), null);
});

test("FundingStoreDO answers the store ops through doStore (and refuses unknown ops)", async () => {
  const m = new Map<string, unknown>();
  const storage = { get: async (k: string) => m.get(k) as any, put: async (k: string, v: unknown) => { m.set(k, v); }, list: async ({ prefix, limit }: { prefix: string; limit: number }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).slice(0, limit)) as any };
  const obj = new FundingStoreDO({ storage });
  const store = doStore(nsOf(obj) as any);
  assert.equal(await store.insertCapped(rec(), 5, NOW), "ok");
  assert.equal((await store.get("addr1"))!.account, "a".repeat(64));
  assert.equal(await store.get("nope"), null);
  assert.equal((await store.listAccount("a".repeat(64), NOW)).length, 1);
  assert.equal((await store.consume([{ key: "k", limit: 1, windowMs: 1000 }], NOW)).ok, true);
  assert.equal((await obj.fetch(new Request("https://x/op", { method: "POST", body: JSON.stringify({ op: "constructor", args: [] }) }))).status, 400);
});

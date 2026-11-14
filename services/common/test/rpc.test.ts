// TDD RED (queue item 7b / D-RPC1): shared NEAR RPC config + pacing.
// All of this exercises services/common/src/rpc.ts against a mock
// fetch -- no real RPC, no testnet/mainnet, ever.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TESTNET_RPC_URL,
  DEFAULT_MAINNET_RPC_URL,
  RATE_LIMIT_PER_SEC,
  MAX_IN_FLIGHT,
  TX_POLL_INTERVAL_MS,
  resolveRpcUrls,
  PacedRpcClient,
  RateLimiter,
  get429Count,
  reset429Count,
  pollTxStatus,
} from "../src/rpc.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("defaults are the two FastNEAR URLs", () => {
  assert.equal(DEFAULT_TESTNET_RPC_URL, "https://test.rpc.fastnear.com");
  assert.equal(DEFAULT_MAINNET_RPC_URL, "https://free.rpc.fastnear.com");
  const testnet = withEnv({ NEAR_RPC_URL: undefined, NEAR_RPC_FALLBACKS: undefined }, () => resolveRpcUrls("testnet"));
  assert.equal(testnet.primary, DEFAULT_TESTNET_RPC_URL);
  assert.deepEqual(testnet.fallbacks, []);
  const mainnet = withEnv({ NEAR_RPC_URL: undefined, NEAR_RPC_FALLBACKS: undefined }, () => resolveRpcUrls("mainnet"));
  assert.equal(mainnet.primary, DEFAULT_MAINNET_RPC_URL);
});

test("NEAR_RPC_URL overrides the default", () => {
  const resolved = withEnv({ NEAR_RPC_URL: "https://custom.example.com", NEAR_RPC_FALLBACKS: undefined }, () =>
    resolveRpcUrls("testnet"),
  );
  assert.equal(resolved.primary, "https://custom.example.com");
});

test("NEAR_RPC_FALLBACKS is empty by default and parses as a comma list", () => {
  const empty = withEnv({ NEAR_RPC_FALLBACKS: undefined }, () => resolveRpcUrls("testnet"));
  assert.deepEqual(empty.fallbacks, []);
  const withFallbacks = withEnv({ NEAR_RPC_URL: "https://a.example.com", NEAR_RPC_FALLBACKS: "https://b.example.com, https://c.example.com" }, () =>
    resolveRpcUrls("testnet"),
  );
  assert.deepEqual(withFallbacks.all, ["https://a.example.com", "https://b.example.com", "https://c.example.com"]);
});

// ---------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test("retries with backoff then succeeds on 429", async () => {
  reset429Count();
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async () => {
    calls++;
    if (calls < 3) return jsonResponse(429, { error: "rate limited" });
    return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { ok: true } });
  }) as unknown as typeof fetch;
  const client = new PacedRpcClient({
    urls: ["https://mock.example.com"],
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await client.sendJsonRpc("status", []);
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.equal((result as any).result.ok, true);
  assert.equal(get429Count(), 2);
});

test("honors Retry-After header on 429", async () => {
  reset429Count();
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return jsonResponse(429, { error: "rate limited" }, { "retry-after": "2" });
    return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { ok: true } });
  }) as unknown as typeof fetch;
  const client = new PacedRpcClient({
    urls: ["https://mock.example.com"],
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  await client.sendJsonRpc("status", []);
  assert.equal(sleeps[0], 2000);
});

test("gives up after max retries with a clear error", async () => {
  reset429Count();
  const fetchImpl = (async () => jsonResponse(429, { error: "rate limited" })) as unknown as typeof fetch;
  const client = new PacedRpcClient({
    urls: ["https://mock.example.com"],
    maxRetries: 3,
    fetchImpl,
    sleepImpl: async () => {},
  });
  await assert.rejects(
    () => client.sendJsonRpc("status", []),
    (err: any) => {
      assert.match(err.message, /mock\.example\.com/);
      assert.match(err.message, /giving up after 3 retries/);
      return true;
    },
  );
});

test("429 counter increments across calls", async () => {
  reset429Count();
  assert.equal(get429Count(), 0);
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 2) return jsonResponse(429, {});
    return jsonResponse(200, { result: {} });
  }) as unknown as typeof fetch;
  const client = new PacedRpcClient({ urls: ["https://mock.example.com"], fetchImpl, sleepImpl: async () => {} });
  await client.sendJsonRpc("status", []);
  assert.equal(get429Count(), 2);
});

test("fails over to NEAR_RPC_FALLBACKS entry after primary's retries are exhausted", async () => {
  reset429Count();
  const calledUrls: string[] = [];
  const fetchImpl = (async (url: any) => {
    calledUrls.push(String(url));
    if (String(url).includes("primary")) return jsonResponse(429, {});
    return jsonResponse(200, { result: { from: "fallback" } });
  }) as unknown as typeof fetch;
  const client = new PacedRpcClient({
    urls: ["https://primary.example.com", "https://fallback.example.com"],
    maxRetries: 2,
    fetchImpl,
    sleepImpl: async () => {},
  });
  const result: any = await client.sendJsonRpc("status", []);
  assert.equal(result.result.from, "fallback");
  assert.ok(calledUrls.filter((u) => u.includes("primary")).length >= 3); // 1 + maxRetries attempts on primary
  assert.ok(calledUrls.some((u) => u.includes("fallback")));
});

test("retries on 5xx and network errors too, not just 429", async () => {
  reset429Count();
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNRESET");
    if (calls === 2) return jsonResponse(503, {});
    return jsonResponse(200, { result: { ok: true } });
  }) as unknown as typeof fetch;
  const client = new PacedRpcClient({ urls: ["https://mock.example.com"], fetchImpl, sleepImpl: async () => {} });
  const result: any = await client.sendJsonRpc("status", []);
  assert.equal(result.result.ok, true);
  assert.equal(calls, 3);
});

test("rate limiter never exceeds 3 req/s or 4 in-flight concurrently", async () => {
  assert.equal(RATE_LIMIT_PER_SEC, 3);
  assert.equal(MAX_IN_FLIGHT, 4);
  const limiter = new RateLimiter(3, 4);
  let concurrent = 0;
  let maxConcurrent = 0;
  const starts: number[] = [];

  async function run(): Promise<void> {
    const release = await limiter.acquire();
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    starts.push(Date.now());
    await new Promise((r) => setTimeout(r, 10));
    concurrent--;
    release();
  }

  await Promise.all(Array.from({ length: 8 }, () => run()));

  assert.ok(maxConcurrent <= 4, `max concurrent in-flight exceeded 4: ${maxConcurrent}`);
  starts.sort((a, b) => a - b);
  // No 4 starts may land inside the same rolling 1000ms window.
  for (let i = 0; i + 3 < starts.length; i++) {
    assert.ok(
      starts[i + 3] - starts[i] >= 950,
      `4 requests started within <1s of each other (rate cap violated): ${starts.slice(i, i + 4)}`,
    );
  }
});

test("tx status poll interval is 1.5s", async () => {
  assert.equal(TX_POLL_INTERVAL_MS, 1500);
  const intervals: number[] = [];
  let calls = 0;
  const result = await pollTxStatus(
    async () => {
      calls++;
      return calls >= 3 ? { done: true } : null;
    },
    {
      sleepImpl: async (ms) => {
        intervals.push(ms);
      },
    },
  );
  assert.deepEqual(result, { done: true });
  assert.deepEqual(intervals, [1500, 1500]);
});

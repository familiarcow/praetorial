// RLY1 / D-RLY1: GLOBAL daily sponsored-gas cap with a reserved share for
// existing bettors. Open share (1 - RESERVED_SHARE) of the global budget is
// available to any sender; once spent only bettors (maker/taker on the
// escrow) may draw from the reserved share. Lookup failure => non-bettor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as borsh from "borsh";
import { KeyPair } from "near-api-js";
import { SCHEMA, actionCreators, buildDelegateAction, encodeDelegateAction, Signature } from "@near-js/transactions";
import { Relayer, GuardViolation, GlobalCapViolation, type ChainPort, type RelayerConfig } from "../src/relayer.js";
import { GuardStore } from "../src/guardStore.js";
import { createRelayHandler } from "../src/http.js";
import { makeBettorChecker } from "../src/bettor.js";

const ESCROW = "escrow3.praetorial-dev-1101.testnet";
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const EST = 5_000_000_000_000_000_000_000n;
const DAY = 24 * 60 * 60 * 1000;

function cfgOf(o: Partial<RelayerConfig> = {}): RelayerConfig {
  return {
    escrowContract: ESCROW,
    intentsContract: INTENTS,
    usdcTokenId: "usdc.fakes.testnet",
    maxTransferAmount: 1_000_000_000n,
    maxBlockHeightFuture: 1200n,
    perCallSponsorshipYocto: EST,
    maxRequestsPerWindow: 1000,
    windowMs: 60_000,
    dailyBudgetYocto: EST * 20n,
    globalDailyBudgetYocto: EST * 10n, // 5 open + 5 reserved
    reservedShare: 0.5,
    ...o,
  };
}

function chainOf(opts: { cost?: bigint; fail?: "onchain" | "network" } = {}): ChainPort & { calls: number } {
  const port: any = {
    calls: 0,
    async currentBlockHeight() {
      return 4000n;
    },
    async broadcastSignedDelegate() {
      port.calls += 1;
      if (opts.fail === "onchain") throw Object.assign(new Error("executed but failed"), { transaction_outcome: {} });
      if (opts.fail === "network") throw new Error("rpc down");
      await new Promise((r) => setTimeout(r, 1));
      return { transactionHash: "H" + port.calls, actualCostYocto: opts.cost ?? EST, raw: {} };
    },
  };
  return port;
}

function build(senderId: string, nonce = 1n) {
  const kp = KeyPair.fromRandom("ed25519");
  const da = buildDelegateAction({
    senderId,
    receiverId: ESCROW,
    actions: [actionCreators.functionCall("cancel", { bet_id: 1 }, 30_000_000_000_000n, 0n)],
    nonce,
    maxBlockHeight: 5000n,
    publicKey: kp.getPublicKey() as any,
  });
  const hash = createHash("sha256").update(Buffer.from(encodeDelegateAction(da))).digest();
  const signature = new Signature({ keyType: 0, data: kp.sign(hash).signature });
  return Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, { delegateAction: da, signature })).toString("base64");
}

const never = async () => false;
const bettors = (...ids: string[]) => async (id: string) => ids.includes(id);
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "rly1-")), "g.sqlite3");

// ------------------------------------------------------------------ store level

function storeCfg(o: Record<string, unknown> = {}) {
  return {
    maxRequestsPerWindow: 1000,
    windowMs: 60_000,
    dailyBudgetYocto: EST * 20n,
    globalDailyBudgetYocto: EST * 10n,
    reservedShare: 0.5,
    ...o,
  };
}

test("store: fresh senders exhaust the open share; next fresh sender refused (GlobalCapViolation); bettor served from reserve; reserve exhausted -> bettor refused", () => {
  const s = new GuardStore(":memory:", storeCfg());
  for (let i = 0; i < 5; i++) s.reserveBudget(`fresh${i}.testnet`, EST);
  assert.throws(() => s.reserveBudget("fresh5.testnet", EST), GlobalCapViolation);
  for (let i = 0; i < 5; i++) s.reserveBudget(`bettor${i}.testnet`, EST, { isBettor: true });
  assert.throws(() => s.reserveBudget("bettor5.testnet", EST, { isBettor: true }), GlobalCapViolation);
  const st = s.globalBudgetStatus();
  assert.equal(st.capYocto, EST * 10n);
  assert.equal(st.usedYocto, EST * 10n);
  assert.equal(st.openUsedYocto, EST * 5n);
  assert.equal(st.reservedUsedYocto, EST * 5n);
  s.close();
});

test("store: GlobalCapViolation is a GuardViolation and says whether a reserve exists for bettors", () => {
  const s = new GuardStore(":memory:", storeCfg());
  for (let i = 0; i < 5; i++) s.reserveBudget(`f${i}.testnet`, EST);
  try {
    s.reserveBudget("x.testnet", EST);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof GlobalCapViolation);
    assert.ok(e instanceof GuardViolation);
    assert.equal((e as GlobalCapViolation).reserveAvailable, true);
    assert.match((e as Error).message, /global/i);
  }
  for (let i = 0; i < 5; i++) s.reserveBudget(`b${i}.testnet`, EST, { isBettor: true });
  try {
    s.reserveBudget("y.testnet", EST, { isBettor: true });
    assert.fail("should throw");
  } catch (e) {
    assert.equal((e as GlobalCapViolation).reserveAvailable, false);
  }
  s.close();
});

test("store: per-user violation still wins and does not touch global accounting", () => {
  const s = new GuardStore(":memory:", storeCfg({ dailyBudgetYocto: EST }));
  s.reserveBudget("u.testnet", EST);
  assert.throws(() => s.reserveBudget("u.testnet", EST), (e: unknown) => e instanceof GuardViolation && !(e instanceof GlobalCapViolation));
  assert.equal(s.globalBudgetStatus().usedYocto, EST);
  s.close();
});

test("store: release frees global capacity; on-chain-failure charge (settle at estimate) keeps it consumed", () => {
  const s = new GuardStore(":memory:", storeCfg({ globalDailyBudgetYocto: EST * 2n, reservedShare: 0.5 }));
  const a = s.reserveBudget("a.testnet", EST); // open 1
  assert.throws(() => s.reserveBudget("b.testnet", EST), GlobalCapViolation);
  s.releaseBudget("a.testnet", a.reservationId);
  assert.equal(s.globalBudgetStatus().usedYocto, 0n);
  const b = s.reserveBudget("b.testnet", EST);
  s.settleBudget("b.testnet", b.reservationId, EST); // charged
  assert.equal(s.globalBudgetStatus().usedYocto, EST);
  assert.throws(() => s.reserveBudget("c.testnet", EST), GlobalCapViolation);
  // settling to a lower real cost frees the difference
  const s2 = new GuardStore(":memory:", storeCfg({ globalDailyBudgetYocto: EST * 2n }));
  const r = s2.reserveBudget("a.testnet", EST);
  s2.settleBudget("a.testnet", r.reservationId, EST / 5n);
  assert.equal(s2.globalBudgetStatus().usedYocto, EST / 5n);
  s.close();
  s2.close();
});

test("store: defaults -- global cap is 50x the per-user daily budget, reserved share 0.5", () => {
  const s = new GuardStore(":memory:", { maxRequestsPerWindow: 10, windowMs: 1000, dailyBudgetYocto: EST * 4n });
  const st = s.globalBudgetStatus();
  assert.equal(st.capYocto, EST * 200n);
  assert.equal(st.openCapYocto, EST * 100n);
  assert.equal(st.reservedCapYocto, EST * 100n);
  s.close();
});

test("store: restart keeps global totals (pools and window)", () => {
  const db = tmpDb();
  const s1 = new GuardStore(db, storeCfg());
  for (let i = 0; i < 3; i++) {
    const r = s1.reserveBudget(`f${i}.testnet`, EST);
    s1.settleBudget(`f${i}.testnet`, r.reservationId, EST);
  }
  const before = s1.globalBudgetStatus();
  s1.close();
  const s2 = new GuardStore(db, storeCfg());
  const after = s2.globalBudgetStatus();
  assert.equal(after.usedYocto, EST * 3n);
  assert.equal(after.windowStartMs, before.windowStartMs);
  s2.reserveBudget("g0.testnet", EST);
  s2.reserveBudget("g1.testnet", EST);
  assert.throws(() => s2.reserveBudget("g2.testnet", EST), GlobalCapViolation);
  s2.close();
});

test("store: window rollover resets the global budget; stale pre-rollover reservation does not erase new holds", () => {
  let now = 1_000_000;
  const s = new GuardStore(":memory:", storeCfg(), () => now);
  const old = s.reserveBudget("old.testnet", EST); // outstanding, never settled yet
  for (let i = 0; i < 4; i++) s.reserveBudget(`f${i}.testnet`, EST);
  assert.throws(() => s.reserveBudget("x.testnet", EST), GlobalCapViolation);
  now += DAY + 1;
  for (let i = 0; i < 5; i++) s.reserveBudget(`n${i}.testnet`, EST); // fresh window: open share again available
  assert.throws(() => s.reserveBudget("n5.testnet", EST), GlobalCapViolation);
  assert.equal(s.globalBudgetStatus().openUsedYocto, EST * 5n);
  // the pre-rollover reservation finally settles: must not subtract from the new window's holds
  s.settleBudget("old.testnet", old.reservationId, EST);
  assert.equal(s.globalBudgetStatus().openUsedYocto, EST * 5n);
  assert.throws(() => s.reserveBudget("n6.testnet", EST), GlobalCapViolation);
  s.close();
});

test("store: 60 racing reservations never exceed the cap", async () => {
  const s = new GuardStore(":memory:", storeCfg());
  const results = await Promise.allSettled(
    Array.from({ length: 60 }, async (_, i) => s.reserveBudget(`r${i}.testnet`, EST, { isBettor: i % 2 === 0 })),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  assert.ok(ok <= 10, `granted ${ok}`);
  assert.ok(s.globalBudgetStatus().usedYocto <= EST * 10n);
  s.close();
});

// ------------------------------------------------------------------ relayer level

test("relayer: open share exhausted -> fresh sender refused, existing bettor still served from the reserve", async () => {
  const chain = chainOf();
  const r = new Relayer(chain, cfgOf(), undefined, { bettorLookup: bettors("bettor.testnet") });
  for (let i = 0; i < 5; i++) await r.relay(build(`fresh${i}.testnet`));
  await assert.rejects(() => r.relay(build("fresh5.testnet")), GlobalCapViolation);
  assert.equal(chain.calls, 5);
  for (let i = 0; i < 5; i++) await r.relay(build("bettor.testnet", BigInt(i + 1)));
  assert.equal(chain.calls, 10);
  // reserve exhausted -> even the bettor is refused
  await assert.rejects(() => r.relay(build("bettor.testnet", 99n)), GlobalCapViolation);
  assert.equal(chain.calls, 10);
  r.close();
});

test("relayer: bettor lookup failure (throw) and hang (timeout) are treated as NOT a bettor", async () => {
  const exhaust = async (lookup: (id: string) => Promise<boolean>) => {
    const chain = chainOf();
    const r = new Relayer(chain, cfgOf({ bettorLookupTimeoutMs: 50 }), undefined, { bettorLookup: lookup });
    for (let i = 0; i < 5; i++) await r.relay(build(`fresh${i}.testnet`));
    await assert.rejects(() => r.relay(build("maybe.testnet")), GlobalCapViolation);
    assert.equal(chain.calls, 5);
    r.close();
  };
  await exhaust(async () => { throw new Error("indexer down"); });
  await exhaust(() => new Promise<boolean>(() => {}));
});

test("relayer: no lookup configured => nobody is a bettor (never unlimited)", async () => {
  const chain = chainOf();
  const r = new Relayer(chain, cfgOf());
  for (let i = 0; i < 5; i++) await r.relay(build(`fresh${i}.testnet`));
  await assert.rejects(() => r.relay(build("any.testnet")), GlobalCapViolation);
  r.close();
});

test("relayer: 60 racing requests (mixed fresh/bettor) never exceed the global cap", async () => {
  const chain = chainOf();
  const ids = Array.from({ length: 60 }, (_, i) => `racer${i}.testnet`);
  const r = new Relayer(chain, cfgOf(), undefined, { bettorLookup: async (id) => Number(id.slice(5, id.indexOf("."))) % 2 === 0 });
  const res = await Promise.allSettled(ids.map((id) => r.relay(build(id))));
  const ok = res.filter((x) => x.status === "fulfilled").length;
  assert.equal(ok, 10);
  assert.equal(chain.calls, 10);
  assert.ok(r.globalBudgetStatus().usedYocto <= EST * 10n);
  r.close();
});

test("relayer: on-chain failure is charged globally; network failure is released", async () => {
  const c1 = chainOf({ fail: "onchain" });
  const r1 = new Relayer(c1, cfgOf({ globalDailyBudgetYocto: EST * 2n }));
  await assert.rejects(() => r1.relay(build("a.testnet")));
  assert.equal(r1.globalBudgetStatus().usedYocto, EST);
  r1.close();
  const c2 = chainOf({ fail: "network" });
  const r2 = new Relayer(c2, cfgOf({ globalDailyBudgetYocto: EST * 2n }));
  await assert.rejects(() => r2.relay(build("a.testnet")));
  assert.equal(r2.globalBudgetStatus().usedYocto, 0n);
  r2.close();
});

test("relayer: restart (new Relayer on same DB) keeps the global total", async () => {
  const db = tmpDb();
  const cfg = cfgOf({ guardDbPath: db });
  const r1 = new Relayer(chainOf(), cfg);
  for (let i = 0; i < 5; i++) await r1.relay(build(`f${i}.testnet`));
  r1.close();
  const c2 = chainOf();
  const r2 = new Relayer(c2, cfg);
  await assert.rejects(() => r2.relay(build("g.testnet")), GlobalCapViolation);
  assert.equal(c2.calls, 0);
  r2.close();
});

// ------------------------------------------------------------------ bettor checker

test("bettor checker: caches within TTL, re-queries after; failures are not cached and map to false", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const check = makeBettorChecker(async () => { calls++; if (fail) throw new Error("x"); return true; }, { ttlMs: 1000, now: () => now });
  assert.equal(await check("a"), true);
  assert.equal(await check("a"), true);
  assert.equal(calls, 1);
  now = 1001;
  assert.equal(await check("a"), true);
  assert.equal(calls, 2);
  fail = true;
  assert.equal(await check("b"), false);
  fail = false;
  assert.equal(await check("b"), true); // failure was not cached
});

test("bettor checker: cache is bounded", async () => {
  let calls = 0;
  const check = makeBettorChecker(async () => { calls++; return false; }, { ttlMs: 10_000, maxEntries: 3 });
  for (let i = 0; i < 10; i++) await check(`u${i}`);
  await check("u0"); // evicted -> looked up again
  assert.equal(calls, 11);
});

// ------------------------------------------------------------------ HTTP

test("http: global cap -> 429 with the standard { ok:false, error } body; per-user budget stays 400", async () => {
  const r = new Relayer(chainOf(), cfgOf({ globalDailyBudgetYocto: EST * 2n }));
  const server = http.createServer(createRelayHandler(r));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  const post = (body: string) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/relay", method: "POST" }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(t) }));
      });
      req.on("error", reject);
      req.end(body);
    });
  try {
    const ok = await post(JSON.stringify({ signedDelegate: build("a.testnet") }));
    assert.equal(ok.status, 200);
    const capped = await post(JSON.stringify({ signedDelegate: build("b.testnet") }));
    assert.equal(capped.status, 429);
    assert.equal(capped.json.ok, false);
    assert.match(capped.json.error, /global/i);
    assert.deepEqual(Object.keys(capped.json).sort(), ["error", "ok"]);
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    r.close();
  }
});

test("http: GET /budget/global exposes spend vs cap for the monitor", async () => {
  const r = new Relayer(chainOf(), cfgOf());
  const server = http.createServer(createRelayHandler(r));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  try {
    await r.relay(build("a.testnet"));
    const body: any = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/budget/global" }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, ...JSON.parse(t) }));
      }).on("error", reject);
    });
    assert.equal(body.status, 200);
    assert.equal(body.capYocto, (EST * 10n).toString());
    assert.equal(body.usedYocto, EST.toString());
    assert.equal(typeof body.windowStartMs, "number");
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    r.close();
  }
});

// CF1b2 RED: the relayer Worker resolves bettors like the node relayer (RLY1): indexer first, escrow get_bet
// scan when the indexer is absent/failing, bounded per request (Worker subrequest budget), cached in the
// RelayerDO's SQLite storage, ANY failure => non-bettor and never cached. Parity runs drive the node relayer
// with escrowBettorLookup over a fake client holding the same bets, and the Worker DO over mocked RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayerDO } from "../src/index.js";
import { escrowBettorLookup } from "../../../relayer/src/bettor.js";
import { Relayer, type ChainPort } from "../../../relayer/src/relayer.js";
import { errorResponse } from "../../../relayer/src/httpMap.js";
import { buildDelegate, fakeDoStorage, outboundFetch, rpcWorld, workerBindings, nodeConfig, EST, type Rpc } from "./helpers.js";

const realFetch = globalThis.fetch;
const GLOBAL = { RELAYER_GLOBAL_DAILY_BUDGET_YOCTO: (EST * 10n).toString(), RELAYER_RESERVED_SHARE: "0.99" }; // open share < 1 call: every sender needs the bettor reserve
const bet = (maker: string, taker: string | null = null) => ({ envelope: { maker }, taker });
let nonce = 1n;
const send = (d: RelayerDO, sender: string) => d.fetch(new Request("https://relayer.do/relay", { method: "POST", body: JSON.stringify({ signedDelegate: buildDelegate({ senderId: sender, nonce: nonce++ }).base64 }) })).then((r) => r.status);
async function withWorld<T>(w: Rpc, fn: () => Promise<T>): Promise<T> { globalThis.fetch = outboundFetch(w) as any; try { return await fn(); } finally { globalThis.fetch = realFetch; } }
const mk = (extra: Record<string, string> = {}, st = fakeDoStorage()) => ({ st, make: () => new RelayerDO(st.ctx as any, workerBindings({ ...GLOBAL, ...extra }) as any) });

async function nodeStatus(bets: Map<number, any>, senders: string[]): Promise<number[]> {
  const chain: ChainPort = { async currentBlockHeight() { return 4000n; }, async broadcastSignedDelegate() { return { transactionHash: "N", actualCostYocto: 3_000_000_000_000_000_000_000n, raw: {} }; } };
  const client: any = { async view(_c: string, _m: string, a: any) { return bets.get(a.bet_id) ?? null; } };
  const relayer = new Relayer(chain, nodeConfig({ globalDailyBudgetYocto: EST * 10n, reservedShare: 0.99 }) as any, undefined, { bettorLookup: escrowBettorLookup(client, "escrow") });
  const out: number[] = [];
  for (const s of senders) {
    try { await relayer.relay(buildDelegate({ senderId: s, nonce: nonce++ }).base64); out.push(200); } catch (e: any) { out.push(errorResponse(e).status); }
  }
  relayer.close();
  return out;
}

test("indexer ok: indexer answers, no escrow get_bet RPC is made", async () => {
  const w = rpcWorld(); w.indexerBettors.add("bettor.testnet"); w.bets.set(1, bet("someoneelse.testnet"));
  const { make, st } = mk(); const d = make();
  const r = await withWorld(w, async () => [await send(d, "bettor.testnet"), await send(d, "stranger.testnet")]);
  assert.deepEqual(r, [200, 429]); assert.equal(w.views, 0); st.close();
});

test("indexer down (HTTP 503): falls back to the get_bet scan; maker and taker are bettors, strangers are not (node parity)", async () => {
  const w = rpcWorld(); w.indexerDown = true;
  w.bets.set(1, bet("maker.testnet", "taker.testnet")); w.bets.set(2, bet("maker2.testnet"));
  const senders = ["maker.testnet", "taker.testnet", "maker2.testnet", "stranger.testnet"];
  const { make, st } = mk(); const d = make();
  const worker = await withWorld(w, async () => { const o = []; for (const s of senders) o.push(await send(d, s)); return o; });
  assert.deepEqual(worker, [200, 200, 200, 429]);
  assert.deepEqual(worker, await nodeStatus(w.bets, senders), "same decisions as node escrowBettorLookup");
  assert.ok(w.views > 0); st.close();
});

test("no INDEXER_URL: the scan is used (node runner behaviour without an indexer)", async () => {
  const w = rpcWorld(); w.bets.set(1, bet("maker.testnet"));
  const { make, st } = mk({ INDEXER_URL: "" }); const d = make();
  assert.deepEqual(await withWorld(w, async () => [await send(d, "maker.testnet"), await send(d, "stranger.testnet")]), [200, 429]); st.close();
});

test("scan fails (get_bet RPC errors) => non-bettor (429), and the failure is NOT cached", async () => {
  const w = rpcWorld(); w.indexerDown = true; w.bets.set(1, bet("maker.testnet")); w.viewsFail = true;
  const { make, st } = mk(); const d = make();
  const r = await withWorld(w, async () => {
    const first = await send(d, "maker.testnet");
    w.viewsFail = false;
    const second = await send(d, "maker.testnet");
    return [first, second];
  });
  assert.deepEqual(r, [429, 200], "recovered RPC must be honoured immediately"); st.close();
});

test("cache hit avoids RPC: scan result persists in DO SQLite across requests AND a restarted DO", async () => {
  const w = rpcWorld(); w.indexerDown = true; w.bets.set(1, bet("maker.testnet")); w.bets.set(2, bet("m2.testnet", "t2.testnet"));
  const { make, st } = mk();
  await withWorld(w, async () => {
    assert.equal(await send(make(), "maker.testnet"), 200);
    const afterScan = w.views; assert.ok(afterScan >= 2);
    assert.equal(await send(make(), "t2.testnet"), 200, "different account, brand-new DO instance on same storage");
    assert.equal(await send(make(), "stranger.testnet"), 429);
    assert.equal(w.views, afterScan, "no get_bet RPC while the SQLite cache is fresh");
  });
  st.close();
});

test("cache expires after RELAYER_BETTOR_CACHE_TTL_MS: a bet taken later is picked up on refresh", async () => {
  const w = rpcWorld(); w.indexerDown = true; w.bets.set(1, bet("maker.testnet"));
  const { make, st } = mk({ RELAYER_BETTOR_CACHE_TTL_MS: "20" });
  await withWorld(w, async () => {
    assert.equal(await send(make(), "late.testnet"), 429);
    w.bets.set(1, bet("maker.testnet", "late.testnet"));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(await send(make(), "late.testnet"), 200);
  });
  st.close();
});

test("bounded: one request never exceeds the 44-subrequest budget; a 100-bet history converges over several requests", async () => {
  const w = rpcWorld(); w.indexerDown = true;
  for (let i = 1; i <= 100; i++) w.bets.set(i, bet(`m${i}.testnet`));
  const { make, st } = mk({ INDEXER_URL: "https://indexer.test" }); const d = make();
  await withWorld(w, async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = w.outbound; statuses.push(await send(d, "m95.testnet"));
      assert.ok(w.outbound - before <= 44, `request used ${w.outbound - before} outbound calls > 44`);
      if (statuses.at(-1) === 200) break;
    }
    assert.equal(statuses.at(-1), 200, `bettor at id 95 never found: ${statuses}`);
    assert.ok(statuses.length > 1 && statuses[0] === 429, "first (incomplete) scan fails closed for an unscanned bettor");
  });
  st.close();
});

test("a stranger is never a bettor even on a partial scan", async () => {
  const w = rpcWorld(); w.indexerDown = true;
  for (let i = 1; i <= 100; i++) w.bets.set(i, bet(`m${i}.testnet`));
  const { make, st } = mk(); const d = make();
  const r = await withWorld(w, async () => { const o = []; for (let i = 0; i < 4; i++) o.push(await send(d, "stranger.testnet")); return o; });
  assert.deepEqual(r, [429, 429, 429, 429]); st.close();
});

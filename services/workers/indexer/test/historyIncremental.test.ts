// IDX1 (D-PM3): the governance tick fetches the escrow history INCREMENTALLY. Before IDX1 every 5-min run re-fetched the whole
// history (1 + ceil(N/5) subrequests), so past ~240 txs a run hit the Workers Free cap of 50 and governance events + /bet/txs froze.
// Now a cursor in indexer_state (k = "histcursor:<contract>") resumes the listing and a pending detail queue across runs, and
// every run stays under a fixed subrequest budget whatever the history size. Results are merged by tx hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { indexGovernance } from "../../../indexer/src/governance.js";
import { indexBetTxs, type BetTx } from "@praetorial/common/betTxIndex.js";
import { fakeD1, world, outboundFetch, baseEnv, type World } from "./helpers.js";

const E = "escrow.testnet";
const BASE_NS = 1_700_000_000_000_000_000n; // synthetic history: one tx every 20 s from here (a very busy escrow)
const STEP_NS = 20_000_000_000n;
const MAX_SUBREQUESTS = 40;
const b64 = (s: string) => btoa(s);
const gov = (i: number) => `EVENT_JSON:{"standard":"praetorial-escrow","version":"1.0.0","event":"guardian_proposed","data":[{"guardian":"g${i}.testnet"}]}`;

/** Tx i: a `finalize` call on bet (i % 300) + 1 by user i % 17 (bet action), every 10th also logs a governance event; every 7th has a
 *  second receipt (the escrow's payout) half a second later. Unique timestamps, so block order is total. */
function synthTx(i: number, tsNs: bigint = BASE_NS + BigInt(i) * STEP_NS): { hash: string; rc: any }[] {
  const hash = `tx${String(i).padStart(5, "0")}`;
  const bet = (i % 300) + 1;
  const out = [{
    hash,
    rc: {
      receipt: { receipt_id: `${hash}-r0`, receiver_id: E, predecessor_id: `u${i % 17}.testnet`, receipt: { Action: { signer_id: `u${i % 17}.testnet`, actions: [{ FunctionCall: { method_name: "finalize", args: b64(JSON.stringify({ bet_id: bet })), deposit: "0" } }] } } },
      execution_outcome: { block_timestamp: tsNs.toString(), outcome: { logs: i % 10 === 0 ? [`finalize bet_id=${bet}`, gov(i)] : [`finalize bet_id=${bet}`], status: { SuccessValue: "" } } },
    },
  }];
  if (i % 7 === 0) out.push({
    hash,
    rc: {
      receipt: { receipt_id: `${hash}-r1`, receiver_id: "intents.testnet", predecessor_id: E, receipt: { Action: { signer_id: E, actions: [{ FunctionCall: { method_name: "mt_transfer", args: b64(JSON.stringify({ receiver_id: `u${i % 17}.testnet`, token_id: "nep141:usdc", amount: String(1000 + i) })), deposit: "1" } }] } } },
      execution_outcome: { block_timestamp: (tsNs + 500_000_000n).toString(), outcome: { logs: [], status: { SuccessValue: "" } } },
    },
  });
  return out;
}
const synth = (n: number, from = 0) => Array.from({ length: n }, (_, k) => synthTx(from + k)).flat();

const clock = { ms: 1_800_000_000_000 }; // far past the synthetic txs: all are settled
const get = async (env: any, p: string) => JSON.parse(await (await handle(new Request(`https://indexer.test${p}`), env, () => clock.ms)).text());
async function run(w: World, env: any): Promise<{ json: any; calls: number }> {
  clock.ms += 300_000;
  const before = w.outbound;
  const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any;
  try {
    const r = await handle(new Request("https://indexer.test/tick/governance", { method: "POST" }), env, () => clock.ms);
    const json = await r.json() as any;
    assert.equal(r.status, 200, JSON.stringify(json));
    return { json, calls: w.outbound - before };
  } finally { globalThis.fetch = real; }
}

/** What a full, unlimited fetch of the whole history would serve (the pre-IDX1 result). */
function full(w: World) {
  const hist = [...w.history[E]!].sort((a, b) => (BigInt(a.rc.execution_outcome.block_timestamp) < BigInt(b.rc.execution_outcome.block_timestamp) ? -1 : 1));
  const byBet = new Map<number, BetTx[]>();
  for (const t of indexBetTxs(E, hist)) { const l = byBet.get(t.bet_id) ?? []; l.push(t); byBet.set(t.bet_id, l); }
  return { gov: indexGovernance(E, hist), byBet };
}
async function assertServesFull(w: World, env: any, label: string) {
  const want = full(w);
  assert.ok(want.gov.length > 0 && want.byBet.size > 0, "fixture self-check");
  assert.deepEqual(await get(env, "/governance"), want.gov, `${label}: /governance`);
  for (const [bet, txs] of want.byBet) assert.deepEqual(await get(env, `/bet/txs?bet_id=${bet}`), txs, `${label}: /bet/txs?bet_id=${bet}`);
}
/** Runs until the served index stops changing AND the cursor says synced; asserts the per-run cap on every run. */
async function converge(w: World, env: any, maxRuns: number): Promise<{ runs: number; perRun: number[] }> {
  const perRun: number[] = [];
  for (let i = 0; i < maxRuns; i++) {
    const r = await run(w, env);
    perRun.push(r.calls);
    assert.ok(r.calls < MAX_SUBREQUESTS, `run ${i + 1}: ${r.calls} outbound subrequests (cap ${MAX_SUBREQUESTS})`);
    assert.equal(r.json.subrequests, r.calls, "the tick reports its own subrequest count");
    if (r.json.history?.[E]?.synced) return { runs: i + 1, perRun };
  }
  assert.fail(`not converged after ${maxRuns} runs: ${JSON.stringify(perRun)}`);
}
const setup = (n: number) => {
  const w = world({ [E]: {} });
  w.history[E] = synth(n);
  const f = fakeD1();
  return { w, f, env: baseEnv(f.d1, { ESCROW_CONTRACT_ID: E, ESCROW_CONTRACTS: `${E}@v1` }) };
};

test("2,000-tx history: every governance run stays under 40 subrequests and the index converges to the full history", async () => {
  const { w, f, env } = setup(2000);
  const naive = 1 + Math.ceil(2000 / 200) + Math.ceil(2000 / 5);
  assert.ok(naive > 50, `the pre-IDX1 full fetch would need ${naive} subrequests`);
  const { runs, perRun } = await converge(w, env, 25);
  assert.ok(runs > 1, "a 2,000-tx backfill is spread over several runs");
  await assertServesFull(w, env, "after backfill");
  // steady state: nothing new -> one listing page, no detail fetch
  const idle = await run(w, env);
  assert.equal(idle.calls, 1, `idle run: ${idle.calls}`);
  assert.equal(idle.json.history[E].synced, true);
  await assertServesFull(w, env, "idle");
  console.log(`IDX1 2000-tx backfill: ${runs} runs, subrequests per run ${JSON.stringify(perRun)}`);
  f.close();
});

test("new txs after the backfill are served on the next run, at a cost bounded by the new txs (not the history)", async () => {
  const { w, f, env } = setup(2000);
  await converge(w, env, 25);
  w.history[E]!.push(...synth(12, 2000));
  const r = await run(w, env);
  assert.ok(r.calls <= 1 + Math.ceil(12 / 5), `${r.calls} ${JSON.stringify(r.json.history)}`);
  assert.equal(r.json.history[E].synced, true);
  await assertServesFull(w, env, "after 12 new txs");
  // a burst larger than one run's budget still converges, each run under the cap
  w.history[E]!.push(...synth(700, 2012));
  await converge(w, env, 10);
  await assertServesFull(w, env, "after a 700-tx burst");
  f.close();
});

test("cursor reset (row deleted, or corrupt) re-backfills over several runs, each under the cap, to the same full index", async () => {
  const { w, f, env } = setup(2000);
  await converge(w, env, 25);
  // 1. PM reset: delete the cursor row; the served rows are kept and the re-backfill merges into them idempotently
  f.d1.prepare("DELETE FROM indexer_state WHERE k = ?").bind(`histcursor:${E}`)._exec();
  const a = await converge(w, env, 25);
  assert.ok(a.runs > 1, "re-backfill spans several runs");
  await assertServesFull(w, env, "after cursor delete");
  // 2. reset AND wiped derived rows (fresh D1 for the index): rebuilt from scratch
  f.d1.prepare("DELETE FROM indexer_state")._exec();
  f.d1.prepare("DELETE FROM indexer_governance")._exec();
  assert.deepEqual(await get(env, "/governance"), []);
  const b = await converge(w, env, 25);
  assert.ok(b.runs > 1);
  await assertServesFull(w, env, "after wipe");
  // 3. a corrupt cursor is a reset, never a crash
  f.d1.prepare("UPDATE indexer_state SET v = '{not json' WHERE k = ?").bind(`histcursor:${E}`)._exec();
  await converge(w, env, 25);
  await assertServesFull(w, env, "after corrupt cursor");
  f.close();
});

test("a tx still executing when first fetched (receipts missing) is re-fetched once settled; a tx indexed late (below the head) is still picked up", async () => {
  const { w, f, env } = setup(50);
  await converge(w, env, 5);
  // a fresh tx (block time = now) whose payout receipt is not there yet
  const nowNs = BigInt(clock.ms + 300_000) * 1_000_000n;
  const fresh = synthTx(7000, nowNs);
  w.history[E]!.push(...fresh);
  w.hiddenReceipts = new Set([`${fresh[0]!.hash}-r1`]);
  await run(w, env);
  const betOf = (7000 % 300) + 1;
  const partial = (await get(env, `/bet/txs?bet_id=${betOf}`)).find((t: any) => t.hash === fresh[0]!.hash);
  assert.ok(partial && partial.moved_out.length === 0, "first fetch: payout not executed yet");
  w.hiddenReceipts = undefined; // the payout receipt executes
  await converge(w, env, 3);
  await run(w, env);
  await assertServesFull(w, env, "after settle");
  // a tx the tx indexer lists only after the head moved past its block
  const late = synthTx(7001, nowNs - 120_000_000_000n); // 2 min older than `fresh`
  w.history[E]!.push(...late);
  w.hiddenTxs = new Set([late[0]!.hash]);
  w.history[E]!.push(...synthTx(7002, nowNs + 60_000_000_000n));
  await run(w, env);
  w.hiddenTxs = undefined;
  await converge(w, env, 3);
  await assertServesFull(w, env, "after late-indexed tx");
  f.close();
});

test("a tx-indexer outage mid-backfill keeps the progress made and the served index; the next runs resume", async () => {
  const { w, f, env } = setup(600);
  await run(w, env);
  const govBefore = await get(env, "/governance");
  assert.ok(govBefore.length > 0, "first run already serves some events");
  w.historyDown = true;
  const down = await run(w, env);
  assert.ok(down.calls < MAX_SUBREQUESTS);
  assert.deepEqual(down.json.failed.map((x: any) => x.contractId), [E]);
  assert.deepEqual(await get(env, "/governance"), govBefore);
  w.historyDown = false;
  await converge(w, env, 10);
  await assertServesFull(w, env, "after outage");
  f.close();
});

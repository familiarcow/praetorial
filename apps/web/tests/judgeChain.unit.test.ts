// JC1w (D-JUDGECHAIN1 point 9): the public "Judge models" page's pure data function + the long-bet builder note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadJudgeChain, judgeChainDisplay, longBetJudgeNote, JUDGE_MODELS_HREF, LONG_BET_NOTE_MS } from "../lib/judgeChain";

const DAY_NS = 86_400n * 1_000_000_000n;
const pair = (i: number) => ({ model_a: `org/model-a${i}`, model_b: `org/model-b${i}` });
const views = (chain: any[], pending: any) => async (method: string) => (method === "judge_chain" ? chain : method === "pending_judge_pair" ? pending : (() => { throw new Error("unexpected view " + method); })());

test("JC1w (a): empty pending -> ordered chain, first pair primary, rest backups in order", async () => {
  const d = judgeChainDisplay(await loadJudgeChain(views([pair(0), pair(1), pair(2)], null)));
  assert.equal(d.pending, null);
  assert.deepEqual(d.pairs.map((p) => [p.position, p.role, p.modelA, p.modelB]), [
    [1, "primary", "org/model-a0", "org/model-b0"],
    [2, "backup", "org/model-a1", "org/model-b1"],
    [3, "backup", "org/model-a2", "org/model-b2"],
  ]);
});

test("JC1w (b): one pending pair shows its effective date (contract field) and not yet active", async () => {
  const proposed = 1_800_000_000n * 1_000_000_000n;
  const pending = { pair: pair(9), proposed_at_ns: proposed.toString(), effective_at_ns: (proposed + 7n * DAY_NS).toString() };
  const d = judgeChainDisplay(await loadJudgeChain(views([pair(0), pair(1)], pending)));
  assert.equal(d.pairs.length, 2);
  assert.ok(d.pending);
  assert.equal(d.pending!.modelA, "org/model-a9");
  assert.equal(d.pending!.modelB, "org/model-b9");
  assert.equal(d.pending!.effectiveAtIso, new Date(Number((proposed + 7n * DAY_NS) / 1_000_000n)).toISOString());
  assert.equal(d.pending!.active, false);
  assert.match(d.pending!.label, /not yet active/i);
});

test("JC1w (b2): a pending pair is never listed in the chain", async () => {
  const d = judgeChainDisplay(await loadJudgeChain(views([pair(0), pair(1)], { pair: pair(2), proposed_at_ns: 1, effective_at_ns: 2 })));
  assert.ok(!d.pairs.some((p) => p.modelA === "org/model-a2"));
});

test("JC1w (c): 12 pairs render in order, no truncation", async () => {
  const chain = Array.from({ length: 12 }, (_, i) => pair(i));
  const d = judgeChainDisplay(await loadJudgeChain(views(chain, null)));
  assert.equal(d.pairs.length, 12);
  assert.deepEqual(d.pairs.map((p) => p.modelA), chain.map((p) => p.model_a));
  assert.deepEqual(d.pairs.map((p) => p.position), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(d.pairs.filter((p) => p.role === "primary").length, 1);
});

test("JC1w (d): builder note for a bet resolving beyond the horizon, linking to the judge models page", () => {
  const now = Date.UTC(2026, 10, 8);
  assert.equal(LONG_BET_NOTE_MS, 7 * 86_400_000);
  const n = longBetJudgeNote(now + 8 * 86_400_000, now);
  assert.ok(n);
  assert.match(n!.text, /judge may move to a later pair in the chain/i);
  assert.equal(n!.href, JUDGE_MODELS_HREF);
});

test("JC1w (d2): no note at or within the horizon, or for an unparseable deadline", () => {
  const now = Date.UTC(2026, 10, 8);
  assert.equal(longBetJudgeNote(now + 7 * 86_400_000, now), null);
  assert.equal(longBetJudgeNote(now + 86_400_000, now), null);
  assert.equal(longBetJudgeNote(NaN, now), null);
});

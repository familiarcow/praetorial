// MODAL1c1: pure logic added for the create-bet FlowModal (goTo, stay, draft codec, step mapping).
import test from "node:test";
import assert from "node:assert/strict";
import { initFlow, goTo, finishStay, startBusy, type FlowStep } from "../lib/flowModal";
import { CREATE_STEPS, stepIndexFor, stepForIndex, encodeCreateDraft, decodeCreateDraft } from "../lib/createBetFlow";

const steps: FlowStep[] = CREATE_STEPS;

test("create steps are type, fill, resolver, review", () => {
  assert.deepEqual(CREATE_STEPS.map((s) => s.id), ["type", "fill", "resolver", "review"]);
  assert.equal(stepIndexFor("resolver"), 2);
  assert.equal(stepForIndex(0), "type");
  assert.equal(stepForIndex(3), "review");
  assert.equal(stepForIndex(9), "review");
});

test("goTo moves to any valid step, marks dirty, clamps, and does nothing while busy", () => {
  const s = initFlow(steps);
  const t = goTo(steps, s, 2);
  assert.equal(t.index, 2); assert.equal(t.dirty, true);
  assert.equal(goTo(steps, s, 99).index, 3);
  assert.equal(goTo(steps, s, -4).index, 0);
  const b = startBusy(t);
  assert.equal(goTo(steps, b, 0), b);
});

test("finishStay returns to editing on the same step with values kept", () => {
  const s = goTo(steps, initFlow(steps, { v: 1, index: 3, values: { draft: "{}" } }), 3);
  const r = finishStay(startBusy(s));
  assert.equal(r.phase, "editing"); assert.equal(r.index, 3); assert.deepEqual(r.values, { draft: "{}" });
});

test("draft codec round-trips and rejects junk", () => {
  const d = { step: "fill", fill: { typeId: "custom" }, referee: { mode: "ai" } } as never;
  assert.deepEqual(decodeCreateDraft(encodeCreateDraft(d)), d);
  assert.equal(decodeCreateDraft(undefined), null);
  assert.equal(decodeCreateDraft("not json"), null);
  assert.equal(decodeCreateDraft("{\"step\":\"bogus\"}"), null);
});

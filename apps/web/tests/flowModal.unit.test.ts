// MODAL1a: pure logic behind Modal / FlowModal / ConfirmDialog (no React, no DOM).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initFlow, setValue, goNext, goBack, startBusy, finishSuccess, finishPending, finishFailure, retryFlow,
  progressOf, closeDecision, saveDraft, loadDraft, clearDraft, isTerminal, type FlowStep, type DraftStorage,
} from "../lib/flowModal";
import { dismissAction, returnFocus, txExplorerUrl, harnessEnabled, HARNESS_PATH } from "../lib/modalLogic";

const steps: FlowStep[] = [
  { id: "amount", title: "Amount", validate: (v) => (Number(v.amount) > 0 ? null : "Enter an amount above zero.") },
  { id: "review", title: "Review" },
  { id: "send", title: "Send" },
];

function memStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

test("starts on step 0, editing, not dirty", () => {
  const s = initFlow(steps);
  assert.equal(s.index, 0); assert.equal(s.phase, "editing"); assert.equal(s.dirty, false);
});

test("validation gate blocks next and sets the plain-words error", () => {
  let s = initFlow(steps);
  s = goNext(steps, s);
  assert.equal(s.index, 0);
  assert.equal(s.error, "Enter an amount above zero.");
  s = setValue(s, "amount", "5");
  assert.equal(s.error, null);
  s = goNext(steps, s);
  assert.equal(s.index, 1);
});

test("a step without validate always passes; next stops at the last step; back stops at 0", () => {
  let s = setValue(initFlow(steps), "amount", "5");
  s = goNext(steps, goNext(steps, goNext(steps, s)));
  assert.equal(s.index, 2);
  s = goBack(goBack(goBack(goBack(s))));
  assert.equal(s.index, 0);
});

test("back clears the error and keeps values", () => {
  let s = setValue(initFlow(steps), "amount", "5");
  s = goNext(steps, s);
  s = goBack(s);
  assert.equal(s.values.amount, "5"); assert.equal(s.error, null);
});

test("progress indicator counts steps from 1 and gives a percent", () => {
  let s = initFlow(steps);
  assert.deepEqual(progressOf(steps, s), { current: 1, total: 3, percent: 33 });
  s = goNext(steps, setValue(s, "amount", "1"));
  assert.deepEqual(progressOf(steps, s), { current: 2, total: 3, percent: 67 });
  s = finishSuccess(s, "H1");
  assert.equal(progressOf(steps, s).percent, 100);
});

test("closeDecision: pristine closes, dirty asks to discard, busy is blocked, terminal closes", () => {
  let s = initFlow(steps);
  assert.equal(closeDecision(s), "close");
  s = setValue(s, "amount", "5");
  assert.equal(closeDecision(s), "confirm-discard");
  const busy = startBusy(s);
  assert.equal(busy.phase, "busy");
  assert.equal(closeDecision(busy), "blocked");
  assert.equal(closeDecision(finishSuccess(busy, "H")), "close");
  assert.equal(closeDecision(finishFailure(busy, "Not enough balance.")), "close");
  assert.equal(closeDecision(finishPending(busy, "H")), "close");
});

test("moving to step 2 without typing still counts as mid-flow", () => {
  const two: FlowStep[] = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
  const s = goNext(two, initFlow(two));
  assert.equal(closeDecision(s), "confirm-discard");
});

test("success / pending keep the tx hash; failure keeps a reason and retry returns to editing without losing values", () => {
  let s = setValue(initFlow(steps), "amount", "5");
  s = startBusy(s);
  const ok = finishSuccess(s, "HASH1"); assert.equal(ok.phase, "success"); assert.equal(ok.txHash, "HASH1");
  const pend = finishPending(s, "HASH2"); assert.equal(pend.phase, "pending"); assert.equal(pend.txHash, "HASH2");
  const bad = finishFailure(s, "The network was busy. Nothing was spent."); assert.equal(bad.phase, "failure"); assert.equal(bad.reason, "The network was busy. Nothing was spent.");
  assert.equal(isTerminal(bad), true); assert.equal(isTerminal(s), false);
  const again = retryFlow(steps, bad);
  assert.equal(again.phase, "editing"); assert.equal(again.reason, null); assert.equal(again.values.amount, "5");
});

test("busy state ignores next/back/setValue (no edits mid-send)", () => {
  const s = startBusy(setValue(goNext(steps, setValue(initFlow(steps), "amount", "5")), "x", "1"));
  assert.equal(goBack(s).index, s.index);
  assert.equal(goNext(steps, s).index, s.index);
  assert.equal(setValue(s, "amount", "9").values.amount, "5");
});

test("draft: save then restore step + values; restore marks dirty", () => {
  const st = memStorage();
  let s = goNext(steps, setValue(initFlow(steps), "amount", "5"));
  saveDraft(st, "create-bet", s);
  const d = loadDraft(st, "create-bet");
  assert.ok(d);
  const r = initFlow(steps, d);
  assert.equal(r.index, 1); assert.equal(r.values.amount, "5"); assert.equal(r.dirty, true);
});

test("draft: only editing state is saved; success/failure/busy never persist; clear removes it", () => {
  const st = memStorage();
  const s = setValue(initFlow(steps), "amount", "5");
  saveDraft(st, "k", startBusy(s)); assert.equal(st.map.size, 0);
  saveDraft(st, "k", finishSuccess(s, "H")); assert.equal(st.map.size, 0);
  saveDraft(st, "k", s); assert.equal(st.map.size, 1);
  clearDraft(st, "k"); assert.equal(loadDraft(st, "k"), null);
});

test("draft: corrupt JSON, wrong shape and out-of-range index are survived", () => {
  const st = memStorage();
  st.setItem("flowdraft:k", "{not json"); assert.equal(loadDraft(st, "k"), null);
  st.setItem("flowdraft:k", JSON.stringify({ index: "x" })); assert.equal(loadDraft(st, "k"), null);
  st.setItem("flowdraft:k", JSON.stringify({ v: 1, index: 99, values: { amount: "1" } }));
  assert.equal(initFlow(steps, loadDraft(st, "k")).index, 2);
  assert.equal(loadDraft(null, "k"), null); // sessionStorage missing (privacy mode)
  assert.doesNotThrow(() => saveDraft(null, "k", initFlow(steps)));
});

test("dismissAction: Esc / overlay / close button close unless busy", () => {
  for (const why of ["esc", "overlay", "button"] as const) {
    assert.equal(dismissAction(why, { busy: false }), "close");
    assert.equal(dismissAction(why, { busy: true }), "ignore");
  }
});

test("returnFocus focuses the opener when still on the page, else the fallback", () => {
  const calls: string[] = [];
  const mk = (name: string, connected: boolean) => ({ isConnected: connected, focus: () => void calls.push(name) });
  assert.equal(returnFocus(mk("opener", true), mk("fb", true)), true);
  assert.equal(returnFocus(mk("opener2", false), mk("fb2", true)), true);
  assert.equal(returnFocus(null, null), false);
  assert.deepEqual(calls, ["opener", "fb2"]);
});

test("txExplorerUrl: per-network explorer, hash is encoded, empty hash gives null", () => {
  assert.equal(txExplorerUrl("testnet", "AbC123"), "https://testnet.nearblocks.io/txns/AbC123");
  assert.equal(txExplorerUrl("mainnet", "AbC123"), "https://nearblocks.io/txns/AbC123");
  assert.equal(txExplorerUrl("testnet", "a/b?c"), "https://testnet.nearblocks.io/txns/a%2Fb%3Fc");
  assert.equal(txExplorerUrl("testnet", ""), null);
});

test("harness is dev-only: off in production, on only for DEV + its exact path", () => {
  assert.equal(harnessEnabled({ DEV: false }, HARNESS_PATH), false);
  assert.equal(harnessEnabled({}, HARNESS_PATH), false);
  assert.equal(harnessEnabled({ DEV: true }, "/"), false);
  assert.equal(harnessEnabled({ DEV: true }, HARNESS_PATH), true);
});

test("harness is only reachable through a DEV-guarded dynamic import (never a static import)", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /import\.meta\.env\.DEV[\s\S]*import\(["']\.\/modal\/Harness["']\)/);
  assert.doesNotMatch(main, /^import .*modal\/Harness/m);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /modal\/Harness/);
});

// C1 (UIR1 §3.4, familiarcow UX-37 #5, SM2 gap C1-2): every decision the create review makes lives in lib/createFlow.ts, not in App.tsx
// useStates: the automatic source check on entering Review (at most ONE automatic paid AI check per reviewed offer, REVIEW1's
// binding + no-loop rules kept), what the source-check line and its ONE button say, the Open button, the progress line and the
// Open result mapping (mirrors take's takeFlowResult).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoCheckOnEnter, onApprovalExpired, preflightView, openButton, openProgress, openFlowResult, closingTooSoon, checkedLine,
} from "../lib/createFlow";
import { MAX_AUTO_RECHECKS } from "../lib/openApproval";
import type { PlainFailure } from "../lib/sourcePreflight";

const fresh = { approved: false, checking: false, triedKeys: new Set<string>(), key: "k1" };

test("AI mode: entering Review runs the source check by itself, once per reviewed offer (no button press)", () => {
  assert.equal(autoCheckOnEnter({ ...fresh, human: false }), true);
  // already checked (same offer back from Edit), or a check for it is running: nothing new
  assert.equal(autoCheckOnEnter({ ...fresh, human: false, approved: true }), false);
  assert.equal(autoCheckOnEnter({ ...fresh, human: false, checking: true }), false);
  // the automatic check for THIS offer was already used (it failed, ran out, or the user came back): the user presses the button
  assert.equal(autoCheckOnEnter({ ...fresh, human: false, triedKeys: new Set(["k1"]) }), false);
  // an edited offer is a different offer: it gets its own one automatic check
  assert.equal(autoCheckOnEnter({ ...fresh, human: false, triedKeys: new Set(["k0"]) }), true);
});

test("person-decides: the silent attestation still runs on entering Review (REVIEW1 / D-FE6B1 unchanged)", () => {
  assert.equal(autoCheckOnEnter({ ...fresh, human: true }), true);
  assert.equal(autoCheckOnEnter({ ...fresh, human: true, approved: true }), false);
  assert.equal(autoCheckOnEnter({ ...fresh, human: true, checking: true }), false);
});

test("an approval that runs out: AI mode never re-checks by itself (button); person-decides keeps REVIEW1's one re-check", () => {
  assert.equal(onApprovalExpired({ human: false, autoRechecksUsed: 0 }), "button");
  assert.equal(onApprovalExpired({ human: true, autoRechecksUsed: 0 }), "auto");
  assert.equal(onApprovalExpired({ human: true, autoRechecksUsed: MAX_AUTO_RECHECKS }), "button");
});

const fail = (o: Partial<PlainFailure> = {}): PlainFailure => ({ headline: "The check is taking too long. Retry.", lines: [], retry: true, ...o } as PlainFailure);

test("source-check line: 'Checking sources…' while it runs, '✓' when done, never a button while running or done", () => {
  const c = preflightView({ state: "checking", failure: null, waiting: false });
  assert.equal(c.line, "Checking sources…");
  assert.equal(c.button, null);
  const ok = preflightView({ state: "ok", failure: null, waiting: false });
  assert.equal(ok.line, "Checking sources… ✓");
  assert.equal(ok.tone, "good");
  assert.equal(ok.button, null);
});

test("failed: exactly ONE retry button (no 'Retry Retry'), disabled while a rate limit wait runs; Fix / person offered", () => {
  const f = preflightView({ state: "failed", failure: fail(), waiting: false });
  assert.deepEqual(f.button, { label: "Retry", disabled: false });
  assert.equal(f.offerFix, true);
  const w = preflightView({ state: "failed", failure: fail({ state: "rate-limited" } as any), waiting: true });
  assert.deepEqual(w.button, { label: "Retry", disabled: true });
  // the sources can't be read (a source can be down for a minute): still exactly one Retry, plus Fix / person
  const n = preflightView({ state: "failed", failure: fail({ retry: false, headline: "The AI can't settle this as written:" }), waiting: false });
  assert.deepEqual(n.button, { label: "Retry", disabled: false });
  assert.equal(n.offerFix, true);
});

test("expired / waiting for a press: one 'Check again' button, never automatic", () => {
  assert.deepEqual(preflightView({ state: "expired", failure: null, waiting: false }).button, { label: "Check again", disabled: false });
  assert.deepEqual(preflightView({ state: "idle", failure: null, waiting: false }).button, { label: "Check the sources", disabled: false });
});

test("checked line: minutes left, no ticking seconds until the last minute", () => {
  assert.equal(checkedLine(59 * 60_000 + 30_000), "Good to open for 59 min.");
  assert.equal(checkedLine(90_000), "Good to open for 1 min.");
  assert.equal(checkedLine(42_000), "Good to open for 42 s.");
  assert.equal(checkedLine(0), null);
  assert.equal(checkedLine(null), null);
});

const base = { checkState: "ok" as const, hasAttestation: true, leftMs: 60_000, address: "me.near", gateAllowed: true, relay: "idle" as const, busy: null, flags: 0, payNow: "10.00 USDC" };

test("Open button: one primary 'Open the bet · <you pay now>'; enabled only with a live approval for this offer and the gate open", () => {
  assert.deepEqual(openButton(base), { label: "Open the bet · 10.00 USDC", disabled: false });
  assert.equal(openButton({ ...base, payNow: null }).label, "Open the bet");
  for (const bad of [
    { checkState: "checking" as const }, { checkState: "failed" as const }, { checkState: "expired" as const }, { hasAttestation: false }, { leftMs: 0 },
    { address: null }, { gateAllowed: false }, { relay: "signing" as const }, { relay: "relaying" as const }, { busy: "confirming" as const }, { flags: 1 },
  ]) assert.equal(openButton({ ...base, ...bad }).disabled, true, JSON.stringify(bad));
});

test("progress line: signing / sending / confirming, nothing otherwise (no raw relay status words on screen)", () => {
  assert.equal(openProgress(null, "idle"), null);
  assert.equal(openProgress(null, "signing"), "Waiting for your approval…");
  assert.equal(openProgress(null, "relaying"), "Sending…");
  assert.equal(openProgress("confirming", "done"), "Confirming…");
  assert.equal(openProgress(null, "error"), null);
  assert.equal(openProgress(null, "done"), null);
});

test("Open result mapping (was App.tsx 517-533): opened / refused / send failed / pending", () => {
  const bet: any = { envelope: {} };
  assert.deepEqual(openFlowResult({ kind: "opened", betId: 7, bet }, { ok: true, txHash: "TX" }), { flow: { kind: "success", txHash: "TX" }, shared: { betId: 7, bet }, result: null });
  const refused = openFlowResult({ kind: "refused", reason: "x", known: true, refunded: true, sentence: "Refused. Refunded." }, { ok: true, txHash: "TX" });
  assert.deepEqual(refused.flow, { kind: "failure", reason: "Refused. Refunded." });
  assert.deepEqual(refused.result, { kind: "refused", message: "Refused. Refunded." });
  const setup = openFlowResult({ kind: "pending", message: "p" }, { ok: false, error: "We couldn't set up your account (x)." });
  assert.deepEqual(setup.flow, { kind: "failure", reason: "We couldn't set up your account (x)." });
  const down = openFlowResult({ kind: "pending", message: "p" }, { ok: false, error: "relayer 503" });
  assert.equal(down.result?.kind, "failed");
  assert.match((down.flow as any).reason, /^The bet couldn't be sent, so nothing was opened\. Try again in a moment\. Details: relayer 503$/);
  const pend = openFlowResult({ kind: "pending", message: "Still checking." }, { ok: true, txHash: "TX" });
  assert.deepEqual(pend.flow, { kind: "pending", txHash: "TX" });
  assert.deepEqual(pend.result, { kind: "pending", message: "Still checking." });
});

test("closing time must still be 2 min away by chain time when the Open lands (REVIEW1 CRT-11, was App.tsx:455)", () => {
  const now = 1_800_000_000_000;
  assert.equal(closingTooSoon((now + 120_000) * 1e6, now), true);
  assert.equal(closingTooSoon((now + 121_000) * 1e6, now), false);
});

import { copiedRefereeName, COPIED_REFEREE_UNREGISTERED, stakeAmountText, dateInputValue } from "../lib/createFlow";

test("SM2 C1-1: a copied bet's referee is resolved to their @username in lib (the screen never calls the registry); no raw id in the message", async () => {
  const reg = (u: any) => ({ byAccount: async () => u }) as any;
  assert.deepEqual(await copiedRefereeName(reg({ username: "kim", account: "k.near" }), "k.near"), { kind: "named", username: "kim" });
  const none = await copiedRefereeName(reg(null), "a".repeat(64));
  assert.deepEqual(none, { kind: "unregistered", message: COPIED_REFEREE_UNREGISTERED });
  assert.ok(!COPIED_REFEREE_UNREGISTERED.includes("a".repeat(64)));
  const down = await copiedRefereeName({ byAccount: async () => { throw new Error("503"); } } as any, "k.near");
  assert.deepEqual(down, { kind: "unknown" }); // the registry being down is caught by the form's own checks, not guessed here
});

test("SM2 C1-3: amounts on the form use the lib/money rule (no float toFixed); the date input gets YYYY-MM-DD", () => {
  assert.equal(stakeAmountText("USDC", 10), "10.00");
  assert.equal(stakeAmountText("NEAR", 2.5), "2.5");
  assert.equal(stakeAmountText("USDC", 0.1 + 0.2), "0.30");
  assert.equal(dateInputValue(Date.UTC(2027, 11, 8, 23, 0) / 1000), "2027-12-08");
});

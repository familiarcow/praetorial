// F2: lib/funding/tracker.ts (SPEC §4.6 state machine + poll policy) and lib/funding/store.ts (in-flight persistence, §7.4).
import test from "node:test";
import assert from "node:assert/strict";
import { advance, pollIntervalMs, refundLands, refundReasonKind, needsConfirm, isTerminal, EXPIRE_GRACE_MS, CHECKING_AFTER_FAILURES } from "../../lib/funding/tracker";
import { loadLocal, saveLocal, upsertLocal, mergeRecords, syncInFlight, inFlightOnly, storageKey, MAX_RECORDS, RECORD_TTL_MS } from "../../lib/funding/store";
import { createFundingClient } from "../../lib/funding/fundingClient";
import { fundRecord, withdrawRecord, STATUS, status, T0, ACCOUNT, OTHER_ACCOUNT, ID, ref, createMockFundingWorker, FUNDING_URL, DEPOSIT_ADDRESS } from "./fixtures";

const DEADLINE = Date.parse(fundRecord().deadline!);

test("every 1Click status maps to its tracker state", () => {
  const r = fundRecord();
  assert.equal(advance(r, STATUS.waiting, T0).state, "waiting");
  assert.equal(advance(r, STATUS.confirming, T0).state, "confirming");
  assert.equal(advance(r, STATUS.converting, T0).state, "converting");
  const short = advance(r, STATUS.short, T0);
  assert.equal(short.state, "short");
  assert.equal(short.received, "15000000");
  const ok = advance(r, STATUS.credited, T0);
  assert.equal(ok.state, "credited");
  assert.equal(ok.delivered, "19977493");
  const back = advance(r, STATUS.refunded, T0);
  assert.equal(back.state, "refunded");
  assert.equal(back.refunded, "15000000");
  assert.equal(back.refundReason, "PARTIAL_DEPOSIT");
  assert.equal(advance(r, STATUS.failed, T0).state, "failed");
  assert.equal(ok.lastStatus, "SUCCESS");
  assert.equal(ok.updatedAt, T0);
});

test("short -> credited when the user tops up the same address", () => {
  const r = advance(advance(fundRecord(), STATUS.short, T0), STATUS.converting, T0 + 1000);
  assert.equal(r.state, "converting");
  assert.equal(advance(r, STATUS.credited, T0 + 2000).state, "credited");
});

test("deadline: still PENDING_DEPOSIT 30 min after the deadline -> expired; before that, waiting", () => {
  const r = fundRecord();
  assert.equal(advance(r, STATUS.waiting, DEADLINE + EXPIRE_GRACE_MS - 1).state, "waiting");
  assert.equal(advance(r, STATUS.waiting, DEADLINE + EXPIRE_GRACE_MS).state, "expired");
  // a late deposit after expiry is still tracked (it gets refunded to the user's account)
  const exp = advance(r, STATUS.waiting, DEADLINE + EXPIRE_GRACE_MS);
  assert.equal(advance(exp, STATUS.refunded, DEADLINE + EXPIRE_GRACE_MS + 1).state, "refunded");
});

test("a failing status check becomes 'checking' (never 'failed') and recovers on the next answer", () => {
  let r = fundRecord({ state: "confirming" });
  r = advance(r, null, T0);
  assert.equal(r.state, "confirming", "one blip keeps the last state");
  for (let i = 1; i < CHECKING_AFTER_FAILURES; i++) r = advance(r, null, T0);
  assert.equal(r.state, "checking");
  for (let i = 0; i < 50; i++) r = advance(r, null, T0);
  assert.equal(r.state, "checking", "never turns into failed");
  r = advance(r, STATUS.converting, T0);
  assert.equal(r.state, "converting");
  assert.equal(r.checkFailures, 0);
});

test("credited and refunded are final: a stale earlier status never moves them back", () => {
  const ok = advance(fundRecord(), STATUS.credited, T0);
  assert.equal(advance(ok, STATUS.converting, T0 + 1).state, "credited");
  assert.equal(advance(ok, null, T0 + 1).state, "credited");
  const back = advance(fundRecord(), STATUS.refunded, T0);
  assert.equal(advance(back, STATUS.waiting, T0 + 1).state, "refunded");
  assert.ok(isTerminal(ok) && isTerminal(back) && !isTerminal(fundRecord()));
});

test("refunds land in the betting balance for a bet-token origin, else under 'Not usable for bets yet'", () => {
  assert.equal(refundLands(fundRecord()), "stray", "Tron USDT is not a bet token id");
  assert.equal(refundLands(fundRecord({ origin: ref(ID.BTC) })), "betting");
  assert.equal(refundLands(withdrawRecord()), "betting", "a cash out refunds the bet token it took");
  assert.equal(refundReasonKind("PARTIAL_DEPOSIT"), "partial");
  assert.equal(refundReasonKind("SLIPPAGE_EXCEEDED"), "price");
  assert.equal(refundReasonKind(null), "unknown");
});

test("poll policy: 5 s waiting/confirming with the sheet open, 10 s converting, 30 s card only, paused when hidden or final", () => {
  assert.equal(pollIntervalMs("waiting", { sheetOpen: true, hidden: false }), 5000);
  assert.equal(pollIntervalMs("confirming", { sheetOpen: true, hidden: false }), 5000);
  assert.equal(pollIntervalMs("short", { sheetOpen: true, hidden: false }), 5000);
  assert.equal(pollIntervalMs("converting", { sheetOpen: true, hidden: false }), 10000);
  assert.equal(pollIntervalMs("waiting", { sheetOpen: false, hidden: false }), 30000);
  assert.equal(pollIntervalMs("waiting", { sheetOpen: true, hidden: true }), null);
  for (const s of ["credited", "refunded", "failed", "expired"] as const) assert.equal(pollIntervalMs(s, { sheetOpen: true, hidden: false }), null);
});

test("an unsigned cash out before its deadline asks to Confirm / Cancel", () => {
  const r = withdrawRecord();
  assert.equal(needsConfirm(r, T0), true);
  assert.equal(needsConfirm({ ...r, signed: true }, T0), false);
  assert.equal(needsConfirm(r, Date.parse(r.deadline!) + 1), false);
  assert.equal(needsConfirm(fundRecord(), T0), false);
});

// ---- store ----
class MemStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }

test("local store: per-account key, bigint-free JSON round trip, other accounts and garbage ignored", () => {
  const s = new MemStorage();
  saveLocal(ACCOUNT, [fundRecord()], s, T0);
  assert.ok(s.getItem(storageKey(ACCOUNT)));
  assert.deepEqual(loadLocal(ACCOUNT, s, T0), [fundRecord()]);
  assert.deepEqual(loadLocal(OTHER_ACCOUNT, s, T0), []);
  s.setItem(storageKey(OTHER_ACCOUNT), "{not json");
  assert.deepEqual(loadLocal(OTHER_ACCOUNT, s, T0), []);
  s.setItem(storageKey(OTHER_ACCOUNT), JSON.stringify([fundRecord()]));
  assert.deepEqual(loadLocal(OTHER_ACCOUNT, s, T0), [], "a record for another account under my key is dropped");
});

test("local store: upsert before the address is shown, max 30 records, finished ones expire after 30 days", () => {
  const s = new MemStorage();
  upsertLocal(fundRecord(), s, T0);
  upsertLocal(fundRecord({ state: "converting" }), s, T0);
  assert.equal(loadLocal(ACCOUNT, s, T0).length, 1);
  assert.equal(loadLocal(ACCOUNT, s, T0)[0].state, "converting");
  const many = Array.from({ length: 40 }, (_, i) => fundRecord({ id: `a${i}`, depositAddress: `a${i}`, state: i < 3 ? "waiting" : "credited", createdAt: T0 + i }));
  saveLocal(ACCOUNT, many, s, T0);
  const kept = loadLocal(ACCOUNT, s, T0);
  assert.equal(kept.length, MAX_RECORDS);
  assert.ok(["a0", "a1", "a2"].every((id) => kept.some((r) => r.id === id)), "in-flight records are never pushed out");
  saveLocal(ACCOUNT, [fundRecord({ id: "old", state: "credited", createdAt: T0 }), fundRecord({ id: "oldbutopen", createdAt: T0 })], s, T0);
  const later = loadLocal(ACCOUNT, s, T0 + RECORD_TTL_MS + 1);
  assert.deepEqual(later.map((r) => r.id), ["oldbutopen"]);
});

test("merge: server wins on state, local keeps needReturn, finished never regresses, both sides' extra records kept", () => {
  const local = [fundRecord({ needReturn: "/bet/7", state: "waiting" }), fundRecord({ id: "localonly", depositAddress: "localonly" }), fundRecord({ id: "done", depositAddress: "done", state: "credited" })];
  const server = [fundRecord({ state: "converting", lastStatus: "PROCESSING", updatedAt: T0 + 5 }), fundRecord({ id: "other-device", depositAddress: "other-device" }), fundRecord({ id: "done", depositAddress: "done", state: "waiting" }), fundRecord({ id: "foreign", depositAddress: "foreign", account: OTHER_ACCOUNT })];
  const m = mergeRecords(ACCOUNT, local, server);
  const by = (id: string) => m.find((r) => r.id === id);
  assert.equal(by(DEPOSIT_ADDRESS)!.state, "converting");
  assert.equal(by(DEPOSIT_ADDRESS)!.needReturn, "/bet/7");
  assert.ok(by("localonly") && by("other-device"));
  assert.equal(by("done")!.state, "credited");
  assert.equal(by("foreign"), undefined);
  assert.deepEqual(inFlightOnly(m).map((r) => r.id).sort(), [DEPOSIT_ADDRESS, "localonly", "other-device"].sort());
});

test("syncInFlight: local + /fund/list merged and saved; a server outage keeps the local records (never hides them)", async () => {
  const s = new MemStorage();
  upsertLocal(fundRecord({ needReturn: "/bet/7" }), s, T0);
  const w = createMockFundingWorker({ records: [fundRecord({ state: "confirming", lastStatus: "KNOWN_DEPOSIT_TX" }), fundRecord({ id: "x", depositAddress: "x" })] });
  const r = await syncInFlight(ACCOUNT, { client: createFundingClient({ baseUrl: FUNDING_URL, fetch: w.fetch }), storage: s, now: T0 });
  assert.equal(r.serverOk, true);
  assert.equal(r.records.length, 2);
  assert.equal(loadLocal(ACCOUNT, s, T0).find((x) => x.id === DEPOSIT_ADDRESS)!.needReturn, "/bet/7");
  assert.equal(loadLocal(ACCOUNT, s, T0).find((x) => x.id === DEPOSIT_ADDRESS)!.state, "confirming");
  const down = await syncInFlight(ACCOUNT, { client: createFundingClient({ baseUrl: FUNDING_URL, fetch: createMockFundingWorker({ down: true }).fetch }), storage: s, now: T0 });
  assert.equal(down.serverOk, false);
  assert.equal(down.records.length, 2);
  const unconfigured = await syncInFlight(ACCOUNT, { client: createFundingClient({ baseUrl: "" }), storage: s, now: T0 });
  assert.equal(unconfigured.records.length, 2);
  void status;
});

test("SECREV1 SR-1: merge marks server-only records as not made here; the server can never mark one as made here; local keeps its mark", () => {
  const local = [withdrawRecord({ createdHere: true })];
  const server = [withdrawRecord({ createdHere: true as any }), withdrawRecord({ id: "planted", depositAddress: "planted", createdHere: true as any })];
  const m = mergeRecords(ACCOUNT, local, server);
  assert.equal(m.find((r) => r.id === "planted")!.createdHere, false);
  assert.equal(m.find((r) => r.id !== "planted")!.createdHere, true);
  assert.equal(mergeRecords(ACCOUNT, [withdrawRecord({ createdHere: false })], [withdrawRecord({ createdHere: true as any })])[0]!.createdHere, false);
});

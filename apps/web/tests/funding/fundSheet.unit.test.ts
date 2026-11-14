// F4 (FUND4 SPEC §4, familiarcow UX-37 / D-FUND4a): the Add money sheet's pure view model (lib/fundSheet.ts), the hand-off parsing
// (lib/fundingGate.ts), and SM2 gap F4-2 (the web maps the Worker's raw 1Click status through tracker.advance alone).
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAmountInput, recordFromQuote, addressView, trackerView, toastFor, quoteLines, fundErrorText, needOutUnits, countdown,
  rememberPick, recentPicks, STEP_LABELS, compactLine, nothingToBetWith,
} from "../../lib/fundSheet";
import { isAddMoneyPath, parseAddMoneyPath, addMoneyPath } from "../../lib/fundingGate";
import { createFundingClient, FundingError } from "../../lib/funding/fundingClient";
import { BANNED_WORDS } from "../../lib/funding/copy";
import { fundRecord, fundQuote, ref, ID, ACCOUNT, T0, DEPOSIT_ADDRESS, createMockFundingWorker, FUNDING_URL } from "./fixtures";
import type { SwapRecord, TrackState } from "../../lib/funding/types";

const DEADLINE = Date.parse(fundRecord().deadline!); // T0 + 60 min
const UTC = { timeZone: "UTC" };
const ALL: TrackState[] = ["waiting", "confirming", "converting", "short", "credited", "refunded", "failed", "expired", "checking"];

test("amount input: decimal text -> origin base units; empty / junk / zero / too many decimals refused", () => {
  assert.deepEqual(parseAmountInput("20", 6), { ok: true, units: "20000000" });
  assert.deepEqual(parseAmountInput(" 0.5 ", 6), { ok: true, units: "500000" });
  assert.deepEqual(parseAmountInput("1,5", 6), { ok: true, units: "1500000" });
  assert.deepEqual(parseAmountInput("", 6), { ok: false, reason: "empty" });
  assert.deepEqual(parseAmountInput("abc", 6), { ok: false, reason: "invalid" });
  assert.deepEqual(parseAmountInput("-1", 6), { ok: false, reason: "invalid" });
  assert.deepEqual(parseAmountInput("0", 6), { ok: false, reason: "zero" });
  assert.deepEqual(parseAmountInput("0.0000001", 6), { ok: false, reason: "too-precise" });
  assert.deepEqual(parseAmountInput("0.000000000000000001", 18), { ok: true, units: "1" });
});

test("the record is built from the REAL quote before the address is shown (one-time address, always a fund kind)", () => {
  const q = fundQuote();
  const r = recordFromQuote({ quote: q, account: ACCOUNT, origin: ref(ID.TRON_USDT), destination: ref(ID.USDC), now: T0, needReturn: "/new" });
  assert.equal(r.id, DEPOSIT_ADDRESS);
  assert.equal(r.kind, "fund");
  assert.equal(r.state, "waiting");
  assert.equal(r.recipient, null, "Add money never names a recipient: it is always the user's own balance");
  assert.equal(r.needReturn, "/new");
  assert.equal(r.deadline, q.deadline);
  assert.equal(r.signed, null);
  const memo = recordFromQuote({ quote: fundQuote({ depositMemo: "12345" }), account: ACCOUNT, origin: ref(ID.XRP), destination: ref(ID.USDC), now: T0, needReturn: null });
  assert.equal(memo.id, `${DEPOSIT_ADDRESS}#12345`);
  assert.throws(() => recordFromQuote({ quote: fundQuote({ depositAddress: null }), account: ACCOUNT, origin: ref(ID.TRON_USDT), destination: ref(ID.USDC), now: T0, needReturn: null }));
  assert.throws(() => recordFromQuote({ quote: fundQuote({ deadline: null }), account: ACCOUNT, origin: ref(ID.TRON_USDT), destination: ref(ID.USDC), now: T0, needReturn: null }), /deadline/);
});

test("countdown: mm:ss under an hour, h:mm:ss above, 0:00 at/after the deadline", () => {
  assert.equal(countdown(59 * 60_000 + 1_000), "59:01");
  assert.equal(countdown(5_000), "0:05");
  assert.equal(countdown(3_600_000 + 61_000), "1:01:01");
  assert.equal(countdown(0), "0:00");
});

test("address step: band, deadline + countdown, network warning, exchange hint; no memo line without a memo", () => {
  const v = addressView(fundRecord(), T0 + 60_000, UTC);
  assert.equal(v.usable, true);
  assert.equal(v.title, "Send USDT on Tron");
  assert.equal(v.networkBadge, "Tron network");
  assert.equal(v.address, DEPOSIT_ADDRESS);
  assert.equal(v.band, "Send between 19.80 USDT and 20.00 USDT. More is fine; it's converted too.");
  assert.equal(v.deadline, "Send before 12:39 — 59:00 left");
  assert.equal(v.soon, false);
  assert.equal(v.onlyThis, "Only USDT on Tron. Other tokens or networks are lost.");
  assert.equal(v.exchange, `Sending from an exchange? Pick the "Tron (TRC-20)" network there.`);
  assert.equal(v.memo, null);
  assert.equal(v.memoWarning, null);
  assert.equal(v.expired, null);
});

test("address step: memo chains show the memo and the must-include warning", () => {
  const v = addressView(fundRecord({ origin: ref(ID.XRP), depositMemo: "998877" }), T0, UTC);
  assert.equal(v.memo, "998877");
  assert.equal(v.memoWarning, "You must include this memo, or the deposit is lost.");
  assert.equal(v.title, "Send XRP on XRP Ledger");
});

test("address step: < 10 min left warns; AT the deadline the address is gone (never shown once it can't receive)", () => {
  const soon = addressView(fundRecord(), DEADLINE - 9 * 60_000, UTC);
  assert.equal(soon.soon, true);
  assert.equal(soon.usable, true);
  const gone = addressView(fundRecord(), DEADLINE, UTC);
  assert.equal(gone.usable, false);
  assert.equal(gone.address, null, "no address once the deadline is reached");
  assert.equal(gone.memo, null);
  assert.equal(gone.deadline, null);
  assert.equal(gone.expired, "This address has expired. Don't send to it.");
});

test("tracker: every state renders its SPEC §4.6 copy (no banned words), with the stepper and the right buttons", () => {
  const base = fundRecord();
  const at = T0 + 60_000;
  const v = (over: Partial<SwapRecord>) => trackerView({ ...base, ...over }, at, UTC);

  const waiting = v({ state: "waiting", lastStatus: "PENDING_DEPOSIT" });
  assert.equal(waiting.message, "Waiting for your USDT on Tron. Address valid for 59:00.");
  assert.deepEqual(waiting.steps.map((s) => s.status), ["current", "todo", "todo", "todo"]);
  assert.equal(waiting.showAddress, true);

  const confirming = v({ state: "confirming", lastStatus: "KNOWN_DEPOSIT_TX" });
  assert.equal(confirming.message, "We see your deposit. Waiting for the Tron network to confirm it (usually about 1 min).");
  assert.deepEqual(confirming.steps.map((s) => s.status), ["done", "current", "todo", "todo"]);
  assert.equal(confirming.showAddress, false);

  const btc = trackerView(fundRecord({ origin: ref(ID.BTC), destination: ref(ID.BTC), state: "confirming", lastStatus: "KNOWN_DEPOSIT_TX" }), at, UTC);
  assert.equal(btc.message, "We see your deposit. Bitcoin confirmations take 10–60 min. You can close this page.");

  const converting = v({ state: "converting", lastStatus: "PROCESSING", received: "20000000" });
  assert.equal(converting.message, "Converting 20.00 USDT (Tron) to USDC for betting…");
  assert.deepEqual(converting.steps.map((s) => s.status), ["done", "done", "current", "todo"]);
  const same = trackerView(fundRecord({ origin: ref(ID.ETH_USDT), destination: ref(ID.USDT), state: "converting", lastStatus: "PROCESSING" }), at, UTC);
  assert.equal(same.message, "Moving it into your betting balance…", "same token, other network: no 'converting' wording");

  const short = v({ state: "short", lastStatus: "INCOMPLETE_DEPOSIT", received: "15000000" });
  assert.equal(short.message, "We got 15.00 USDT, but this address needs at least 19.80 USDT. Send 4.80 USDT more before 12:39 to the same address, or we'll return the 15.00 USDT to your account.");
  assert.equal(short.tone, "warn");
  assert.equal(short.showAddress, true, "short: the same address takes the top-up");

  const credited = v({ state: "credited", lastStatus: "SUCCESS", delivered: "19977493" });
  assert.equal(credited.message, "19.97 USDC added to your betting balance.");
  assert.equal(credited.tone, "good");
  assert.deepEqual(credited.steps.map((s) => s.status), ["done", "done", "done", "done"]);
  assert.deepEqual(credited.ctas, ["bet"]);
  assert.deepEqual(v({ state: "credited", lastStatus: "SUCCESS", delivered: "19977493", needReturn: "/bet/7" }).ctas, ["back"]);

  const refundedStray = v({ state: "refunded", lastStatus: "REFUNDED", refunded: "15000000", refundReason: "PARTIAL_DEPOSIT" });
  assert.equal(refundedStray.message, `We couldn't convert it, so we returned 15.00 USDT (Tron) to your account. It's under "Not usable for bets yet".`);
  assert.equal(refundedStray.reason, "You sent less than the minimum.");
  const refundedBet = trackerView(fundRecord({ origin: ref(ID.BTC), destination: ref(ID.USDC), state: "refunded", lastStatus: "REFUNDED", refunded: "98500", refundReason: "SLIPPAGE" }), at, UTC);
  assert.equal(refundedBet.message, "We couldn't convert it, so we returned 0.000985 BTC to your betting balance.");
  assert.equal(refundedBet.reason, "The price moved too much while converting.");
  assert.equal(v({ state: "refunded", lastStatus: "REFUNDED", refunded: "1", refundReason: null }).reason, "The conversion didn't go through.");

  const failed = v({ state: "failed", lastStatus: "FAILED" });
  assert.equal(failed.message, "Something went wrong on the conversion side. Your money is traceable.");
  assert.deepEqual(failed.ctas, ["help"]);
  assert.equal(failed.tone, "bad");

  const expired = v({ state: "expired", lastStatus: "PENDING_DEPOSIT" });
  assert.equal(expired.message, "This address expired and nothing arrived. If you did send, get help.");
  assert.deepEqual(expired.ctas, ["new-address", "help"]);
  assert.equal(expired.showAddress, false);

  const checking = v({ state: "checking", lastStatus: "KNOWN_DEPOSIT_TX" });
  assert.equal(checking.message, "We can't check right now. Your deposit is still being processed. Retrying…");
  assert.notEqual(checking.tone, "bad", "checking is never shown as a failure");
  assert.deepEqual(checking.steps.map((s) => s.status), ["done", "current", "todo", "todo"], "checking keeps the last known step");

  // Waiting past the deadline (inside the 30 min grace): the address is gone, polling continues, and a new address is offered.
  const late = trackerView({ ...base, state: "waiting", lastStatus: "PENDING_DEPOSIT" }, DEADLINE + 60_000, UTC);
  assert.equal(late.showAddress, false);
  assert.equal(late.message, "This address has expired. Don't send to it.");
  assert.deepEqual(late.ctas, ["new-address", "help"]);

  for (const s of ALL) {
    const t = v({ state: s, lastStatus: "PROCESSING", received: "1", delivered: "1", refunded: "1" });
    assert.ok(t.message.length > 0, s);
    for (const w of BANNED_WORDS) assert.ok(!(t.message + (t.reason ?? "")).toLowerCase().includes(w), `${s}: "${w}" in "${t.message}"`);
  }
  assert.deepEqual(STEP_LABELS, ["Sent", "Confirming", "Converting", "In your balance"]);
});

test("compact line (header strip / Account card): token units, the network, the landing token and the state word", () => {
  assert.equal(compactLine(fundRecord({ state: "converting" })), "Adding 20.00 USDT (Tron) → USDC · Converting");
  assert.equal(compactLine(fundRecord({ state: "waiting" })), "Adding 20.00 USDT (Tron) → USDC · Waiting for your deposit");
  assert.equal(compactLine(fundRecord({ origin: ref(ID.NEAR), destination: ref(ID.NEAR), amountIn: "5000000000000000000000000", state: "credited" })), "Adding 5 NEAR (NEAR) → NEAR · In your balance");
});

test("toast on a live change only: a new state, never the first load and never the same state", () => {
  const a = fundRecord({ state: "waiting" });
  assert.equal(toastFor(undefined, a), null);
  assert.equal(toastFor(a, { ...a }), null);
  const c = toastFor(a, { ...a, state: "credited", lastStatus: "SUCCESS", delivered: "19977493" });
  assert.deepEqual(c, { text: "19.97 USDC added to your betting balance.", tone: "good" });
  assert.equal(toastFor(a, { ...a, state: "confirming" })!.text, "We see your USDT deposit (Tron).");
  assert.equal(toastFor(a, { ...a, state: "checking" }), null, "a check that failed is not news");
  assert.equal(toastFor({ ...a, kind: "withdraw" }, { ...a, kind: "withdraw", state: "credited" }), null, "Cash out has its own copy (F5)");
});

test("quote lines: you get (rounded down), eta, fee in the landing token, below-the-smallest-bet note", () => {
  const l = quoteLines(fundQuote(), ref(ID.TRON_USDT), ref(ID.USDC));
  assert.equal(l.youGet, "You'll get ≈ 19.97 USDC in your betting balance");
  assert.equal(l.eta, "in about 1 min");
  assert.equal(l.fee, "fee ≈ 0.02 USDC");
  assert.equal(l.belowBet, null);
  const small = quoteLines(fundQuote({ amountOut: "5000000", amountInUsd: null }), ref(ID.TRON_USDT), ref(ID.USDC));
  assert.equal(small.fee, null, "no ≈ fee without both USD figures");
  assert.equal(small.belowBet, "Smallest bet is 10.00 USDC. You can add more later.");
  const near = quoteLines(fundQuote({ amountOut: "5000000000000000000000000" }), ref(ID.TRON_USDT), ref(ID.NEAR));
  assert.equal(near.youGet, "You'll get ≈ 5 NEAR in your betting balance", "wNEAR lands as NEAR");
});

test("hand-off: the shortfall is the full pay-now minus the live balance (rounded up when shown)", () => {
  assert.equal(needOutUnits({ symbol: "USDC", amount: "10.6" }, "3300000"), "7300000");
  assert.equal(needOutUnits({ symbol: "USDC", amount: "10.6" }, "20000000"), null);
  assert.equal(needOutUnits({ symbol: "USDC", amount: "10.6" }, null), "10600000", "unread balance: ask for the full amount");
});

test("errors map to plain copy: too low names the minimum (rounded up), no route names the token, the Worker down is 'unavailable'", () => {
  const o = ref(ID.TRON_USDT);
  assert.equal(fundErrorText(new FundingError("too_low", "x", "1870001"), o), "That's below the minimum of 1.88 USDT.");
  assert.equal(fundErrorText(new FundingError("no_route", "x"), o), "USDT on Tron can't be converted right now. Pick another token or try later.");
  assert.equal(fundErrorText(new FundingError("network", "x"), o), "Adding money and cashing out are unavailable right now. Your balances are safe.");
  assert.equal(fundErrorText(new FundingError("not_configured", "x"), o), "Adding money and cashing out are unavailable right now. Your balances are safe.");
  assert.equal(fundErrorText(new FundingError("rate_limited", "x"), o), "Too many tries. Wait a minute and try again.");
  assert.equal(fundErrorText(new Error("boom"), o), "We can't get a price right now.");
});

test("recent picks: the last two, newest first, no duplicates", () => {
  const m = new Map<string, string>();
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.deepEqual(recentPicks(s), []);
  rememberPick(ID.TRON_USDT, s);
  rememberPick(ID.BTC, s);
  rememberPick(ID.TRON_USDT, s);
  rememberPick(ID.SOL, s);
  assert.deepEqual(recentPicks(s), [ID.SOL, ID.TRON_USDT]);
});

test("fundingGate: /add-money paths are recognised and parsed (need + safe return only)", () => {
  const p = addMoneyPath({ symbol: "USDC", amount: "10.6" }, "/new");
  assert.equal(isAddMoneyPath(p), true);
  assert.equal(isAddMoneyPath("/add-money"), true);
  assert.equal(isAddMoneyPath("/bet/7"), false);
  assert.equal(isAddMoneyPath("/add-moneyx"), false);
  assert.deepEqual(parseAddMoneyPath(p), { need: { symbol: "USDC", amount: "10.6" }, returnTo: "/new" });
  assert.deepEqual(parseAddMoneyPath("/add-money?asset=USDT&need=3&return=https://evil.example"), { need: { symbol: "USDT", amount: "3" }, returnTo: null });
  assert.deepEqual(parseAddMoneyPath("/add-money"), { need: null, returnTo: null });
});

test("SM2 gap F4-2: the web maps the Worker's raw lastStatus through tracker.advance, never the Worker's own `state`", async () => {
  const mock = createMockFundingWorker({
    records: [
      fundRecord({ id: "A1", depositAddress: "A1", state: "credited" as TrackState, lastStatus: "PROCESSING" }),
      fundRecord({ id: "A2", depositAddress: "A2", state: "waiting", lastStatus: "PENDING_DEPOSIT", deadline: new Date(Date.now() - 3_600_000).toISOString() }),
      fundRecord({ id: "A3", depositAddress: "A3", state: "converting", lastStatus: null, deadline: new Date(Date.now() + 3_600_000).toISOString() }),
      fundRecord({ id: "A4", depositAddress: "A4", state: "waiting", lastStatus: "SUCCESS" }),
    ],
  });
  const c = createFundingClient({ baseUrl: FUNDING_URL, fetch: mock.fetch as any });
  const byId = Object.fromEntries((await c.list(ACCOUNT)).map((r) => [r.id, r.state]));
  assert.deepEqual(byId, { A1: "converting", A2: "expired", A3: "waiting", A4: "credited" });
});

test("SM2 gap F4-3: 'nothing to bet with' reads F3's balance map; an unread balance is never 'empty'", () => {
  assert.equal(nothingToBetWith({ betting: { USDC: 0n, NEAR: 0n } }), true);
  assert.equal(nothingToBetWith({ betting: { USDC: 0n, NEAR: 1n } }), false);
  assert.equal(nothingToBetWith({ betting: "error" }), false);
});

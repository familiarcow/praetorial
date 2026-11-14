// F5 (FUND4 SPEC §5, familiarcow UX-37 / D-FUND4a, SM2 STATES.md M7): the Cash out / Convert view model (lib/cashOut.ts). Every word the
// sheets show comes from here: what you can cash out, the Max, the "in open bets" line, the "Send as" default, the address check
// (per-chain, own deposit addresses, own account id, contracts), the memo-chain block, the review, the error copy, the record
// written before signing, and the tracker for every state (unknown is "checking", never "failed"). Convert lands only in the 6.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cashOutHoldings, parseCashOutAmount, maxAmountText, lockedLine, defaultSendAs, sendAsList, checkAddress, memoChain, reviewView,
  cashOutErrorText, cashOutRecord, priceDropped, cashOutTrackerView, visibleInFlight, dismiss, dismissedIds, convertChoices,
  convertView, convertTrackerView, CASH_OUT_COPY, holdingFromStray, holdingFor,
} from "../../lib/cashOut";
import { mapTokens } from "../../lib/funding/tokens";
import { FundingError } from "../../lib/funding/fundingClient";
import { BANNED_WORDS } from "../../lib/funding/copy";
import {
  ACCOUNT, ID, ONECLICK_TOKENS, balanceMap, STRAY_ETH_USDC, STRAY_UNKNOWN, withdrawQuote, withdrawRecord, fundRecord, T0,
} from "./fixtures";
import type { SwapRecord } from "../../lib/funding/types";

const TOKENS = mapTokens(ONECLICK_TOKENS);
const tok = (id: string) => TOKENS.find((t) => t.assetId === id)!;
const map = balanceMap({ stray: [STRAY_ETH_USDC, STRAY_UNKNOWN] });
const USDC = holdingFor("USDC", 42_100_000n)!;
const TRON = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9";

class MemStore { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }

test("what you can cash out: every non-zero bet token, then known non-bet tokens; never an unknown id or a 0", () => {
  const h = cashOutHoldings(balanceMap({ betting: { USDC: 42_100_000n, USDT: 0n, NEAR: 5n * 10n ** 24n, BTC: 98_500n, ETH: 0n, ZEC: 0n }, stray: [STRAY_ETH_USDC, STRAY_UNKNOWN] }));
  assert.deepEqual(h.map((x) => [x.assetId, x.label, x.amountText]), [
    [ID.USDC, "USDC", "42.10 USDC"],
    [ID.NEAR, "NEAR", "5 NEAR"],
    [ID.BTC, "BTC", "0.000985 BTC"],
    [ID.ETH_USDC, "USDC (Ethereum)", "1.00 USDC"],
  ]);
  assert.equal(h[0]!.kind, "betting");
  assert.equal(h[3]!.kind, "stray");
  assert.deepEqual(cashOutHoldings(balanceMap({ betting: "error", stray: "error" })), []);
  assert.equal(holdingFromStray(STRAY_UNKNOWN), null);
});

test("amount: decimals, more than you have, zero; Max is the whole balance in plain digits", () => {
  assert.deepEqual(parseCashOutAmount("20", USDC), { ok: true, units: "20000000" });
  assert.deepEqual(parseCashOutAmount("42,1", USDC), { ok: true, units: "42100000" });
  assert.equal((parseCashOutAmount("42.11", USDC) as any).message, "That's more than you have (42.10 USDC).");
  assert.equal((parseCashOutAmount("0", USDC) as any).message, "Enter an amount.");
  assert.equal((parseCashOutAmount("1.0000001", USDC) as any).message, "That amount has too many decimals for USDC.");
  assert.equal((parseCashOutAmount("", USDC) as any).ok, false);
  assert.equal(maxAmountText(USDC), "42.1");
  assert.equal(maxAmountText(holdingFor("NEAR", 5n * 10n ** 24n + 1n)!), "5.000000000000000000000001");
});

test("in open bets: one plain line, only when something is locked (it isn't in the balance, so it can't be cashed out)", () => {
  assert.equal(lockedLine({ USDC: { units: 10_000_000n, bets: 1 } }, "USDC"), "10.00 USDC is in open bets and can't be cashed out.");
  assert.equal(lockedLine({}, "USDC"), null);
  assert.equal(lockedLine("error", "USDC"), null);
});

test("Send as default: BTC→Bitcoin, ETH→Ethereum, ZEC→Zcash, NEAR→NEAR; USDC/USDT→the network last added from, else none; a non-bet token→its own network", () => {
  assert.equal(defaultSendAs(holdingFor("BTC", 1n)!, TOKENS, [])?.assetId, ID.BTC);
  assert.equal(defaultSendAs(holdingFor("ETH", 1n)!, TOKENS, [])?.assetId, ID.ETH);
  assert.equal(defaultSendAs(holdingFor("ZEC", 1n)!, TOKENS, [])?.assetId, ID.ZEC);
  assert.equal(defaultSendAs(holdingFor("NEAR", 1n)!, TOKENS, [])?.assetId, ID.NEAR);
  assert.equal(defaultSendAs(USDC, TOKENS, []), null);
  const funded = [fundRecord({ origin: { assetId: ID.BASE_USDC, symbol: "USDC", blockchain: "base", decimals: 6 }, createdAt: T0 + 1 }), fundRecord({ createdAt: T0 })];
  assert.equal(defaultSendAs(USDC, TOKENS, funded)?.assetId, ID.BASE_USDC);
  assert.equal(defaultSendAs(holdingFor("USDT", 1n)!, TOKENS, funded)?.assetId, ID.TRON_USDT); // the USDT one (Tron), not the USDC one
  assert.equal(defaultSendAs(holdingFromStray(STRAY_ETH_USDC)!, TOKENS, [])?.assetId, ID.ETH_USDC);
});

test("Send as list: the same symbol on every network first (\"Popular for USDC\"), cross-symbol allowed after; no pseudo-assets", () => {
  const l = sendAsList(TOKENS, USDC);
  assert.ok(l.length > 5);
  const firstNon = l.findIndex((t) => t.symbol !== "USDC");
  assert.ok(l.slice(0, firstNon).every((t) => t.symbol === "USDC"));
  assert.ok(l.slice(firstNon).some((t) => t.symbol === "USDT" && t.blockchain === "tron"));
  assert.ok(!l.some((t) => t.assetId.startsWith("1cs_v1:")));
});

test("address check: per-chain format/checksum, empty, own deposit address, own account id, contracts, memo chains", () => {
  const ctx = { account: ACCOUNT, ownDeposits: ["TQx9cMHT8hNqMB4x1aP6YbkzjXtRUKk3Lm"] };
  const tron = tok(ID.TRON_USDT);
  assert.deepEqual(checkAddress(tron, "", ctx), { state: "empty" });
  assert.deepEqual(checkAddress(tron, TRON, ctx), { state: "ok" });
  assert.deepEqual(checkAddress(tron, TRON.slice(0, -1) + "8", ctx), { state: "bad", message: "That isn't a valid Tron address." });
  assert.deepEqual(checkAddress(tron, "TQx9cMHT8hNqMB4x1aP6YbkzjXtRUKk3Lm", ctx), { state: "bad", message: "That's one of your deposit addresses. Use your own wallet's address." });
  const base = tok(ID.BASE_USDC);
  assert.deepEqual(checkAddress(base, "0x000000000000000000000000000000000000dEaD", ctx), { state: "bad", message: "That's a contract address, not a wallet." });
  assert.deepEqual(checkAddress(base, "0x52908400098527886E0F7030069857D2E4169EE7", ctx), { state: "ok" }); // EIP-55 vector
  assert.deepEqual(checkAddress(base, "0x52908400098527886E0F7030069857D2E4169Ee7", ctx), { state: "bad", message: "That isn't a valid Base address." });
  assert.deepEqual(checkAddress(base, `0x${ACCOUNT.slice(0, 40)}`, ctx).state, "ok");
  const near = tok(ID.USDC);
  assert.deepEqual(checkAddress(near, "example.near", ctx), { state: "ok" });
  assert.deepEqual(checkAddress(near, ACCOUNT, ctx), { state: "ok" }); // SPEC §5.3/§5.4: your own NEAR account is a fine destination on NEAR
  assert.deepEqual(checkAddress({ ...near, blockchain: "sui", networkName: "Sui" }, `0x${ACCOUNT}`, ctx), { state: "bad", message: "That's your account ID here, not an address on Sui." });
  assert.deepEqual(checkAddress(near, "intents.near", ctx), { state: "bad", message: "That's a contract address, not a wallet." });
  assert.deepEqual(checkAddress(near, "usdc.omft.near", ctx), { state: "bad", message: "That's a contract address, not a wallet." });
  assert.deepEqual(checkAddress(tok(ID.SOL_USDC), "11111111111111111111111111111111", ctx), { state: "bad", message: "That's a contract address, not a wallet." });
  assert.deepEqual(checkAddress(tok(ID.BTC), "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", ctx), { state: "ok" });
  assert.equal(checkAddress(tok(ID.BTC), "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx", ctx).state, "bad");
  assert.equal(checkAddress(tron, ` ${TRON}\n`, ctx).state, "ok"); // pasted with spaces / a newline: trimmed (the trimmed text is what is sent)
  assert.equal(checkAddress(tron, `${TRON.slice(0, 10)} ${TRON.slice(10)}`, ctx).state, "bad");
  assert.equal(memoChain(tok(ID.XRP)), true);
  assert.equal(memoChain(tron), false);
});

test("review: you send (from your betting balance), they receive ≈ (rounded down), at least, to (short), network fee · time", () => {
  const v = reviewView(withdrawQuote(), USDC, tok(ID.TRON_USDT), TRON);
  assert.deepEqual(v.rows.map((r) => [r.label, r.value]), [
    ["You send", "20.00 USDC"],
    ["They receive ≈", "19.80 USDT on Tron"],
    ["At least", "19.60 USDT"],
    ["To", "TN3W…b3m9 (Tron)"],
    ["Network fee", "0.21 USDT · about 1 min"],
  ]);
  assert.equal(v.fullAddress, TRON);
  const stray = reviewView(withdrawQuote({ amountIn: "1000000" }), holdingFromStray(STRAY_ETH_USDC)!, tok(ID.TRON_USDT), TRON);
  assert.equal(stray.rows[0]!.value, "1.00 USDC (Ethereum)");
});

test("errors: too small parses the minimum (origin token, rounded up), bad address, no route, rate limit, Worker down; never 'failed'", () => {
  const tron = tok(ID.TRON_USDT);
  assert.equal(cashOutErrorText(new FundingError("too_low", "x", "1218977"), USDC, tron), "Too small to send to Tron. Minimum is 1.22 USDC.");
  assert.equal(cashOutErrorText(new FundingError("too_low", "x"), USDC, tron), "Too small to send to Tron.");
  assert.equal(cashOutErrorText(new FundingError("bad_recipient", "x"), USDC, tron), "That isn't a valid Tron address.");
  assert.equal(cashOutErrorText(new FundingError("no_route", "x"), USDC, tron), "USDT on Tron isn't available right now. Pick another network or try later.");
  assert.equal(cashOutErrorText(new FundingError("rate_limited", "x"), USDC, tron), "Too many tries. Wait a minute and try again.");
  for (const c of ["network", "upstream_down", "not_configured"] as const) assert.equal(cashOutErrorText(new FundingError(c, "x"), USDC, tron), "Adding money and cashing out are unavailable right now. Your balances are safe.");
  assert.equal(cashOutErrorText(new Error("?"), USDC, tron), "We can't get a price right now.");
});

test("record written BEFORE signing: signed false, the user's address, kind withdraw/convert; convert has no recipient", () => {
  const r = cashOutRecord({ quote: withdrawQuote(), account: ACCOUNT, kind: "withdraw", origin: USDC.token, destination: tok(ID.TRON_USDT), recipient: TRON, now: T0 });
  assert.equal(r.id, withdrawQuote().depositAddress);
  assert.equal(r.signed, false);
  assert.equal(r.state, "waiting");
  assert.equal(r.recipient, TRON);
  assert.equal(r.kind, "withdraw");
  assert.equal(r.destination.assetId, ID.TRON_USDT);
  const c = cashOutRecord({ quote: withdrawQuote(), account: ACCOUNT, kind: "convert", origin: holdingFromStray(STRAY_ETH_USDC)!.token, destination: tok(ID.USDC), recipient: null, now: T0 });
  assert.equal(c.recipient, null);
  assert.throws(() => cashOutRecord({ quote: withdrawQuote({ depositAddress: null }), account: ACCOUNT, kind: "withdraw", origin: USDC.token, destination: tok(ID.TRON_USDT), recipient: TRON, now: T0 }));
});

test("price moved: the real quote's estimate must not be below the 'At least' the user reviewed", () => {
  const seen = withdrawQuote();
  assert.equal(priceDropped(seen, withdrawQuote()), false);
  assert.equal(priceDropped(seen, withdrawQuote({ amountOut: seen.minAmountOut })), false);
  assert.equal(priceDropped(seen, withdrawQuote({ amountOut: (BigInt(seen.minAmountOut) - 1n).toString() })), true);
});

const NOW = T0 + 60_000;
const w = (o: Partial<SwapRecord> = {}) => withdrawRecord({ signed: true, ...o });

test("tracker, cash out: sending → sent / returned / needs help / checking / expired; unsigned → confirm or cancel; never 'failed' for our own outage", () => {
  const v = (r: SwapRecord) => cashOutTrackerView(r, NOW);
  assert.equal(v(w()).message, "Sending 19.80 USDT to TN3W…b3m9…");
  assert.deepEqual(v(w()).steps.map((s) => s.status), ["done", "current", "todo"]);
  assert.equal(v(w({ state: "converting" })).message, "Sending 19.80 USDT to TN3W…b3m9…");
  const sent = v(w({ state: "credited", delivered: "19810000" }));
  assert.equal(sent.message, "Sent: 19.81 USDT is on its way to TN3W…b3m9.");
  assert.equal(sent.tone, "good");
  assert.deepEqual(sent.ctas, ["done"]);
  assert.equal(v(w({ state: "refunded", refunded: "20000000" })).message, "We couldn't send it. 20.00 USDC is back in your betting balance.");
  const strayBack = v(w({ state: "refunded", refunded: "1000000", origin: holdingFromStray(STRAY_ETH_USDC)!.token }));
  assert.equal(strayBack.message, "We couldn't send it. 1.00 USDC (Ethereum) is back in your account.");
  const failed = v(w({ state: "failed" }));
  assert.equal(failed.tone, "bad");
  assert.deepEqual(failed.ctas, ["help"]);
  const checking = v(w({ state: "checking" }));
  assert.equal(checking.message, CASH_OUT_COPY.checking);
  assert.notEqual(checking.tone, "bad");
  assert.equal(v(w({ state: "expired" })).message, CASH_OUT_COPY.expiredSigned);
  // Written before signing and never signed: offer Confirm / Cancel while the quote is valid; after it, nothing was sent.
  const unsigned = v(withdrawRecord({ signed: false }));
  assert.equal(unsigned.message, "You didn't confirm this cash out.");
  assert.deepEqual(unsigned.ctas, ["confirm", "cancel"]);
  const late = cashOutTrackerView(withdrawRecord({ signed: false }), Date.parse(withdrawRecord().deadline!) + 1);
  assert.equal(late.message, CASH_OUT_COPY.expiredUnsigned);
  assert.deepEqual(late.ctas, ["done"]);
});

test("tracker, convert: converting → added to your betting balance; refunds go back to the account", () => {
  const c = (o: Partial<SwapRecord> = {}) => w({ kind: "convert", recipient: null, origin: holdingFromStray(STRAY_ETH_USDC)!.token, destination: { assetId: ID.USDC, symbol: "USDC", blockchain: "near", decimals: 6 }, amountIn: "1000000", amountOut: "999800", ...o });
  assert.equal(convertTrackerView(c(), NOW).message, "Converting 1.00 USDC (Ethereum) to USDC…");
  assert.equal(convertTrackerView(c({ state: "credited", delivered: "999800" }), NOW).message, "0.99 USDC added to your betting balance.");
  assert.equal(cashOutTrackerView(c({ state: "credited", delivered: "999800" }), NOW).message, "0.99 USDC added to your betting balance.");
  assert.equal(convertTrackerView(c({ state: "refunded", refunded: "1000000" }), NOW).message, "We couldn't convert it. 1.00 USDC (Ethereum) is back in your account.");
  assert.equal(convertTrackerView(c({ signed: false }), Date.parse(withdrawRecord().deadline!) + 1).message, CASH_OUT_COPY.expiredUnsignedConvert);
});

test("in-flight list: an unsigned cash out the user cancelled, or whose quote ran out, is not 'in progress'", () => {
  const s = new MemStore();
  const recs = [withdrawRecord({ signed: false }), withdrawRecord({ id: "x", depositAddress: "x", signed: true }), fundRecord()];
  assert.deepEqual(recs.filter((r) => visibleInFlight(r, NOW, dismissedIds(ACCOUNT, s))).map((r) => r.id), recs.map((r) => r.id));
  dismiss(ACCOUNT, recs[0]!.id, s);
  assert.deepEqual(dismissedIds(ACCOUNT, s), [recs[0]!.id]);
  assert.deepEqual(recs.filter((r) => visibleInFlight(r, NOW, dismissedIds(ACCOUNT, s))).map((r) => r.id), ["x", fundRecord().id]);
  const late = Date.parse(withdrawRecord().deadline!) + 1;
  assert.equal(visibleInFlight(withdrawRecord({ signed: false }), late, []), false);
  assert.equal(visibleInFlight(withdrawRecord({ signed: true }), late, []), true);
});

test("Convert: lands only in the 6 (minus itself); default = the same token, else USDC; the estimate line", () => {
  const stray = holdingFromStray(STRAY_ETH_USDC)!;
  assert.deepEqual(convertChoices(stray), { choices: ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"], default: "USDC" });
  assert.deepEqual(convertChoices(USDC), { choices: ["USDT", "NEAR", "BTC", "ETH", "ZEC"], default: "USDT" });
  const v = convertView(stray, withdrawQuote({ amountIn: "1000000", amountOut: "999800", timeEstimateSec: 10 }), "USDC");
  assert.equal(v.title, "Convert 1.00 USDC (Ethereum)");
  assert.equal(v.youGet, "You'll get ≈ 0.99 USDC · about 10 s");
  assert.equal(convertView(USDC, null, "USDT").title, "Convert 42.10 USDC");
});

test("no banned words in the F5 strings", () => {
  const src = readFileSync(new URL("../../lib/cashOut.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("export const CASH_OUT_COPY"), src.indexOf("} as const;", src.indexOf("export const CASH_OUT_COPY")));
  for (const w of BANNED_WORDS) assert.ok(!block.toLowerCase().includes(w), w);
});

test("SECREV1 SR-1: the record written before signing is marked as made on this device; a record from elsewhere gets no Confirm", () => {
  const r = cashOutRecord({ quote: withdrawQuote(), account: ACCOUNT, kind: "withdraw", origin: USDC.token, destination: tok(ID.TRON_USDT), recipient: TRON, now: T0 });
  assert.equal(r.createdHere, true);
  const unsignedHere = cashOutTrackerView(withdrawRecord({ signed: false }), NOW);
  assert.ok(unsignedHere.ctas.includes("confirm"), "own unsigned record: Confirm offered");
  const planted = cashOutTrackerView(withdrawRecord({ signed: false, createdHere: false }), NOW);
  assert.ok(!planted.ctas.includes("confirm"), "server-only unsigned record: no Confirm");
});

test("SECREV1 SR-1: an unsigned cash out this device did not start is not shown as in progress", () => {
  assert.equal(visibleInFlight(withdrawRecord({ signed: false, createdHere: false }), NOW, []), false);
  assert.equal(visibleInFlight(withdrawRecord({ signed: false }), NOW, []), true);
  assert.equal(visibleInFlight(withdrawRecord({ signed: true, createdHere: false }), NOW, []), true, "signed elsewhere: still tracked");
});

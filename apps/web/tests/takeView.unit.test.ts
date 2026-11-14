// FE9 (S10, S11): availability states of the read-only bet page, the race guard, the post-take read-back, the taker review card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { takeAvailability, raceGuard, confirmTake, takerReviewOffer } from "../lib/takeView";
import { buildReviewModel } from "../lib/reviewCard";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000n * 1_000_000_000n;
const FUND = Number(NOW + 86_400n * 1_000_000_000n);
const bet = (over: Record<string, any> = {}, env: Record<string, any> = {}): any => ({
  status: "Open", taker: null, fee_min_taker: "500000", storage_rates: new Proxy({}, { get: () => "457" }),
  envelope: { maker: "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: null,
    maker_asset: "nep141:usdc.testnet", taker_asset: "nep141:usdc.testnet", stake_maker: "10000000", stake_taker: "10000000", taker_options: [],
    fee_bps: 100, funding_deadline: FUND, resolve_deadline: FUND + 86_400_000_000_000, settlement_period: 86_400_000_000_000, referee: null, ...env },
  ...over,
});
const ctx = (o: Record<string, any> = {}) => ({ account: "me.testnet", inviteSig: null, nowNs: NOW, paused: false, shutdown: false, ...o });

test("availability: open and takeable", () => assert.equal(takeAvailability(bet(), ctx()).kind, "available"));
test("availability: not found", () => assert.equal(takeAvailability(null, ctx()).kind, "notfound"));
test("availability: taken / cancelled / expired (by status and by funding deadline)", () => {
  assert.equal(takeAvailability(bet({ status: "Taken", taker: "x.testnet" }), ctx()).kind, "taken");
  assert.equal(takeAvailability(bet({ status: "Resolving" }), ctx()).kind, "taken");
  assert.equal(takeAvailability(bet({ status: "Cancelled" }), ctx()).kind, "cancelled");
  assert.equal(takeAvailability(bet({ status: "Expired" }), ctx()).kind, "expired");
  assert.equal(takeAvailability(bet(), ctx({ nowNs: BigInt(FUND) + 1n })).kind, "expired");
});
test("availability: paused or shut down blocks take, but a terminal fact wins", () => {
  assert.equal(takeAvailability(bet(), ctx({ paused: true })).kind, "paused");
  assert.equal(takeAvailability(bet(), ctx({ shutdown: true })).kind, "shutdown"); // FE16: shut down is its own state (was "paused")
  assert.equal(takeAvailability(bet({ status: "Cancelled" }), ctx({ paused: true })).kind, "cancelled");
});
test("availability: named taker that is not you; logged out stays viewable", () => {
  const b = bet({}, { taker_allow: { Account: "bob.testnet" } });
  const r = takeAvailability(b, ctx());
  assert.equal(r.kind, "not-you");
  assert.match((r as any).message, /bob\.testnet/);
  assert.equal(takeAvailability(b, ctx({ account: "bob.testnet" })).kind, "available");
  assert.equal(takeAvailability(b, ctx({ account: null })).kind, "available");
});
test("availability: invite-only without an invite link; your own bet; you are the referee", () => {
  const inv = bet({}, { taker_allow: { InvitePubkey: "aa".repeat(32) } });
  assert.equal(takeAvailability(inv, ctx()).kind, "invite-needed");
  assert.equal(takeAvailability(bet(), ctx({ account: "maker.testnet" })).kind, "own");
  assert.equal(takeAvailability(bet({}, { referee: { account: "me.testnet", mode: "Human" } }), ctx()).kind, "referee-you");
});

test("race guard: identical terms pass", () => assert.deepEqual(raceGuard(bet(), bet()), { ok: true }));
test("race guard: referee changed -> refuses with the referee message", () => {
  const r: any = raceGuard(bet({}, { referee: { account: "a.testnet", mode: "Human" } }), bet({}, { referee: { account: "b.testnet", mode: "Human" } }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, ["referee"]);
  assert.match(r.message, /referee changed/i);
  assert.match(r.message, /nothing was (sent|signed)/i);
});
test("race guard: AI -> human referee and human -> AI are both a change", () => {
  assert.equal((raceGuard(bet(), bet({}, { referee: { account: "b.testnet", mode: "Human" } })) as any).ok, false);
  assert.equal((raceGuard(bet({}, { referee: { account: "b.testnet", mode: "Human" } }), bet()) as any).ok, false);
});
test("race guard: terms hash, stakes, assets, options, deadlines, fee each refuse", () => {
  const cases: [Record<string, any>, string][] = [
    [{ terms_hash: "ee".repeat(32) }, "terms"], [{ stake_taker: "20000000" }, "stakes"], [{ stake_maker: "20000000" }, "stakes"],
    [{ taker_asset: "nep141:wrap.testnet" }, "stakes"], [{ taker_options: [{ asset: "nep141:wrap.testnet", amount: "5" }] }, "stakes"],
    [{ funding_deadline: FUND + 4096 }, "deadlines"], [{ resolve_deadline: 5 }, "deadlines"], [{ fee_bps: 200 }, "terms"],
  ];
  for (const [env, what] of cases) {
    const r: any = raceGuard(bet(), bet({}, env));
    assert.equal(r.ok, false, JSON.stringify(env));
    assert.ok(r.changed.includes(what), `${JSON.stringify(env)} -> ${r.changed}`);
    assert.match(r.message, /nothing was (sent|signed)/i);
  }
  assert.equal((raceGuard(bet(), bet({}, { taker_allow: { Account: "z.testnet" } })) as any).ok, false);
});

const deps = (script: { bets: any[]; logs?: string[] | null; bal?: bigint }) => {
  let i = 0;
  return { getBet: async () => script.bets[Math.min(i++, script.bets.length - 1)], balance: async () => script.bal ?? 100n, txLogs: async () => script.logs ?? null, sleep: async () => {} };
};
test("confirmTake: taken by me -> success only from get_bet", async () => {
  const r = await confirmTake({ betId: 3, me: "me.testnet", deps: deps({ bets: [bet(), bet({ status: "Taken", taker: "me.testnet" })] }), before: { balance: 100n }, txHash: "T", attempts: 4 });
  assert.equal(r.kind, "taken");
});
test("confirmTake: someone else took it first -> lost, not success", async () => {
  const r = await confirmTake({ betId: 3, me: "me.testnet", deps: deps({ bets: [bet({ status: "Taken", taker: "other.testnet" })] }), before: { balance: 100n }, txHash: "T", attempts: 2 });
  assert.equal(r.kind, "lost");
});
test("confirmTake: cancelled/expired while taking -> gone", async () => {
  const r = await confirmTake({ betId: 3, me: "me.testnet", deps: deps({ bets: [bet({ status: "Cancelled" })] }), before: { balance: 100n }, txHash: "T", attempts: 2 });
  assert.equal(r.kind, "gone");
});
test("confirmTake: still Open + tx final with take_rejected -> refused with plain reason and refund", async () => {
  const r: any = await confirmTake({ betId: 3, me: "me.testnet", deps: deps({ bets: [bet()], logs: ["take_rejected reason=referee_ack does not match the bet's referee"], bal: 100n }), before: { balance: 100n }, txHash: "T", attempts: 3 });
  assert.equal(r.kind, "refused");
  assert.match(r.sentence, /^The contract refused this take: .*referee.*Your money was returned\.$/);
});
test("confirmTake: nothing readable -> pending, never success", async () => {
  const r = await confirmTake({ betId: 3, me: "me.testnet", deps: deps({ bets: [bet()], logs: null }), before: { balance: 100n }, txHash: "T", attempts: 3 });
  assert.equal(r.kind, "pending");
});

test("taker review card: taker's own stake, storage, tip carved out of the stake (not added), pay-now = stake + storage", () => {
  const b = bet({}, { referee: { account: "ref.testnet", mode: "Human" } });
  const o = takerReviewOffer(b, { tip: true, deadlineLabel: "2027-01-02 03:04 UTC", offerClosesLabel: "2027-01-01 03:04 UTC" });
  const m = buildReviewModel(o.offer, o.storage);
  // C1: lib/money amounts (USDC 2 dp; the exact pay-now stays in Full terms); the referee as a person, never the raw id
  assert.equal(m.table.stake, "10.00 USDC");
  assert.equal(m.table.payNow, "10.00 USDC");
  assert.match(m.terms.find((t) => t.id === "pay-now")!.value, /^10\.00 USDC \(exactly 10\.00\d+ USDC\)$/);
  assert.match(m.table.tip ?? "", /out of your 10\.00 USDC stake\. It is not added on top\./);
  assert.match(m.summary.find((r) => r.id === "decider")!.text, /, a person \(no AI\)$/);
  assert.ok(!JSON.stringify(m).includes("ref.testnet"), "no raw referee id on the take review");
  const off = takerReviewOffer(b, { tip: false, deadlineLabel: "x", offerClosesLabel: null });
  assert.match(buildReviewModel(off.offer, off.storage).table.tip ?? "", /^No tip/);
});
test("ReviewCard has a taker side and BetPage uses the take state machine (source pins)", () => {
  const rc = readFileSync(join(here, "../src/components/ReviewCard.tsx"), "utf8");
  assert.match(rc, /side\??:\s*"maker"\s*\|\s*"taker"/);
  const bp = readFileSync(join(here, "../src/components/BetPage.tsx"), "utf8") + readFileSync(join(here, "../src/components/TakeBetModal.tsx"), "utf8"); // MODAL1c2: the take logic moved into TakeBetModal
  for (const id of ["take-state", "take-review", "take-result", "take-login"]) assert.ok(bp.includes(`"${id}"`), id);
  assert.ok(bp.includes("takeAvailability") && bp.includes("confirmTake"));
});

// FE8 (S8/S9): read-back after Open and after Cancel. Never show success unless get_bet shows the bet (S8 Errors).
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmOpen, confirmCancel, type OpenDeps } from "../lib/openConfirm";
import { buildBetUrl, expiresLabel, shareScreenModel } from "../lib/shareLink";

const ME = "11".repeat(32);
const bet = (over: any = {}) => ({ envelope: { maker: ME, terms_hash: "abc", funding_deadline: Date.UTC(2027, 0, 2, 3, 4) * 1_000_000, taker_allow: "Any", ...(over.envelope ?? {}) }, status: over.status ?? "Open", taker: null });
function deps(p: any = {}): OpenDeps & { calls: string[] } {
  const calls: string[] = [];
  const counts: number[] = [...(p.counts ?? [5])];
  return {
    calls,
    betCount: p.betCount ?? (async () => { calls.push("count"); return counts.length > 1 ? counts.shift()! : counts[0]; }),
    getBet: p.getBet ?? (async (id: number) => { calls.push(`get_bet:${id}`); return (p.bets ?? {})[id] ?? null; }),
    balance: p.balance ?? (async () => 1000n),
    txLogs: p.txLogs ?? (async () => null),
    sleep: async () => {},
  } as any;
}
const base = { maker: ME, termsHash: "abc", before: { count: 5, balance: 1000n }, txHash: "TX", attempts: 3, delayMs: 0 };

test("opened: a new bet by this maker with the same terms hash is read back with get_bet", async () => {
  const d = deps({ counts: [6], bets: { 6: bet() } });
  const r: any = await confirmOpen({ ...base, deps: d });
  assert.equal(r.kind, "opened");
  assert.equal(r.betId, 6);
  assert.ok(d.calls.includes("get_bet:6"));
});
test("opened: skips someone else's bet that landed in between", async () => {
  const d = deps({ counts: [7], bets: { 6: bet({ envelope: { maker: "other.testnet" } }), 7: bet() } });
  const r: any = await confirmOpen({ ...base, deps: d });
  assert.equal(r.betId, 7);
});
test("not opened when the new bet has different terms (never green without a matching read-back)", async () => {
  const d = deps({ counts: [6], bets: { 6: bet({ envelope: { terms_hash: "zzz" } }) } });
  const r = await confirmOpen({ ...base, deps: d });
  assert.notEqual(r.kind, "opened");
});
test("refused: open_rejected log -> mapped message, refund confirmed from the balance", async () => {
  const d = deps({ counts: [5], txLogs: async () => ["open_rejected bet=unassigned reason=referee cannot be maker or fee_account"] });
  const r: any = await confirmOpen({ ...base, deps: d });
  assert.equal(r.kind, "refused");
  assert.equal(r.reason, "referee cannot be maker or fee_account");
  assert.equal(r.refunded, true);
  assert.match(r.sentence, /^The contract refused this bet: .*\. Your money was returned\.$/);
});
test("refused but balance not back yet: says so instead of claiming a refund", async () => {
  const d = deps({ counts: [5], balance: async () => 400n, txLogs: async () => ["open_rejected bet=unassigned reason=tip requires a referee"] });
  const r: any = await confirmOpen({ ...base, deps: d });
  assert.equal(r.kind, "refused");
  assert.equal(r.refunded, false);
  assert.doesNotMatch(r.sentence, /Your money was returned\./);
  assert.match(r.sentence, /check My bets/i);
});
test("silent refusal: tx finished, no log, no new bet -> refused with the generic reason", async () => {
  const d = deps({ counts: [5], txLogs: async () => [] });
  const r: any = await confirmOpen({ ...base, deps: d });
  assert.equal(r.kind, "refused");
  assert.equal(r.reason, null);
});
test("pending: nothing readable after all attempts -> still confirming, money safe, no success", async () => {
  const d = deps({ counts: [5], txLogs: async () => null });
  const r: any = await confirmOpen({ ...base, deps: d });
  assert.equal(r.kind, "pending");
  assert.equal(r.message, "Still confirming. Your money is safe; check My bets.");
});
test("RPC failures while reading never throw and never produce success", async () => {
  const d = deps({ betCount: async () => { throw new Error("rpc down"); }, txLogs: async () => { throw new Error("rpc down"); } });
  const r = await confirmOpen({ ...base, deps: d });
  assert.equal(r.kind, "pending");
});
test("retries: the bet shows up on the 2nd read", async () => {
  const d = deps({ counts: [5, 6], bets: { 6: bet() } });
  const r = await confirmOpen({ ...base, deps: d });
  assert.equal(r.kind, "opened");
});

test("confirmCancel: Cancelled -> cancelled; Taken -> taken (race); Open -> pending; Expired -> expired", async () => {
  const g = (s: string) => ({ getBet: async () => bet({ status: s }), sleep: async () => {} }) as any;
  assert.equal((await confirmCancel({ betId: 3, deps: g("Cancelled"), attempts: 2, delayMs: 0 })).kind, "cancelled");
  const t: any = await confirmCancel({ betId: 3, deps: g("Taken"), attempts: 2, delayMs: 0 });
  assert.equal(t.kind, "taken");
  assert.equal(t.message, "Someone took this bet a moment ago. It's live now.");
  assert.equal((await confirmCancel({ betId: 3, deps: g("Open"), attempts: 2, delayMs: 0 })).kind, "pending");
  assert.equal((await confirmCancel({ betId: 3, deps: g("Expired"), attempts: 2, delayMs: 0 })).kind, "expired");
});

test("buildBetUrl: link to /bet/:id on the same origin, no query or hash carried over", () => {
  assert.equal(buildBetUrl("https://app.example.com/new?x=1#y", 12), "https://app.example.com/bet/12");
  assert.equal(buildBetUrl("http://localhost:3000/", 3), "http://localhost:3000/bet/3");
});
test("expiresLabel is UTC from the contract's funding_deadline (ns)", () => {
  assert.equal(expiresLabel(Date.UTC(2027, 0, 2, 3, 4) * 1_000_000), "2027-01-02 03:04 UTC");
});
test("shareScreenModel: copy from S9, named taker line, invite-by-link note", () => {
  const m = shareScreenModel({ betId: 9, bet: bet() as any, origin: "https://a.b" });
  assert.equal(m.title, "Your bet is open. Share the link so the other person can take it.");
  assert.equal(m.link, "https://a.b/bet/9");
  assert.equal(m.status, "Waiting for someone to take it · expires 2027-01-02 03:04 UTC");
  assert.equal(m.help, "Send this link to the person you're betting. They'll see the bet and can take it or pass.");
  assert.equal(m.namedTaker, null);
  const n = shareScreenModel({ betId: 9, bet: bet({ envelope: { taker_allow: { Account: "alice.testnet" } } }) as any, origin: "https://a.b", takerLabel: "alice" });
  assert.equal(n.namedTaker, "Only alice can take this.");
  const i = shareScreenModel({ betId: 9, bet: bet({ envelope: { taker_allow: { InvitePubkey: "ab".repeat(32) } } }) as any, origin: "https://a.b" });
  assert.match(i.inviteNote!, /personal link/i);
});

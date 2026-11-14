// FE10 (S12): live bet page logic: plain status chips, concede refusals pinned to lib.rs, the "frozen while a ruling is in progress"
// rule mirrored from amend_referee, concede read-back, and the pending referee-change display.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONCEDE_REFUSALS, plainConcedeRefusal, statusChip, refereeChangeFrozen, concedeWinnerOutcome, confirmConcede, pendingRefereeProposal, concedeSentence, ALL_STATUSES } from "../lib/liveBet";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
const region = (start: string, end: string) => { const a = rs.indexOf(start); const b = rs.indexOf(end, a + 1); assert.ok(a > 0 && b > a, start); return rs.slice(a, b); };
const concede = region("pub fn concede(", "\n    pub fn ");
const amend = region("pub fn amend_referee(", "\n    pub fn ");

const bet = (o: any = {}) => ({
  envelope: { maker: "maker.testnet", maker_side: "YES", outcomes: ["YES", "NO"], referee: o.referee === undefined ? { account: "ref.testnet", mode: "Human" } : o.referee, resolve_deadline: 2_000_000_000_000_000_000 },
  status: "Taken", taker: "taker.testnet", bonds: [], outcome: null, referee_proposal: { maker_value: null, taker_value: null }, ...o.rest,
}) as any;

test("every require() reason in concede maps to a plain message (fails when lib.rs adds one)", () => {
  const reasons = [...concede.matchAll(/(?:require\([\s\S]*?,\s*|panic_str\()\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 4, `found ${reasons.length}`);
  const missing = reasons.filter((r) => !plainConcedeRefusal(r).known);
  assert.deepEqual(missing, [], "unmapped concede reasons: add them to CONCEDE_REFUSALS in lib/liveBet.ts");
});

test("every concede table row still names text that exists in lib.rs", () => {
  for (const r of CONCEDE_REFUSALS) assert.ok(rs.includes(r.source), `${r.id}: ${r.source}`);
});

test("concede table messages: plain, no jargon, no final period", () => {
  for (const r of CONCEDE_REFUSALS) {
    assert.ok(!/bet_id|envelope|predecessor|status|Finalized/i.test(r.message), r.id);
    assert.ok(r.message.length > 10 && !r.message.endsWith("."), r.id);
  }
  assert.equal(plainConcedeRefusal("something new").known, false);
});

test("frozen rule mirrors amend_referee: open to change only in Open or Taken-without-bonds", () => {
  assert.match(amend, /bet\.status == BetStatus::Open \|\| \(bet\.status == BetStatus::Taken && bet\.bonds\.is_empty\(\)\)/);
  assert.equal(refereeChangeFrozen(bet({ rest: { status: "Open", taker: null } })), false);
  assert.equal(refereeChangeFrozen(bet()), false);
  for (const s of ["Resolving", "Proposed", "Challenged", "Evidence", "Rejudge"]) assert.equal(refereeChangeFrozen(bet({ rest: { status: s } })), true, s);
  assert.equal(refereeChangeFrozen(bet({ rest: { bonds: [{}] } })), true);
  for (const s of ["Finalized", "Settled", "Voided", "Cancelled", "Expired"]) assert.equal(refereeChangeFrozen(bet({ rest: { status: s } })), true, s);
});

test("every BetStatus in lib.rs has a chip; chips are plain English", () => {
  const e = rs.slice(rs.indexOf("pub enum BetStatus {"));
  const body = e.slice(0, e.indexOf("\n}"));
  const names = [...body.matchAll(/^\s{4}([A-Z][A-Za-z]+),/gm)].map((m) => m[1]);
  assert.deepEqual([...names].sort(), [...ALL_STATUSES].sort());
  for (const s of names) {
    const c = statusChip(bet({ rest: { status: s } }), "maker.testnet");
    assert.ok(c.label.length > 3 && c.sentence.length > 10, s);
    assert.ok(!/Finalized|Rejudge|Resolving|envelope|bonds/.test(c.label + c.sentence), `${s}: ${c.label} / ${c.sentence}`);
  }
});

test("chips differ for human and AI referee and name the person", () => {
  assert.match(statusChip(bet(), "maker.testnet").sentence, /ref\.testnet/);
  assert.match(statusChip(bet({ referee: null }), "maker.testnet").sentence, /AI/);
  assert.equal(statusChip(bet({ rest: { status: "Challenged" } }), null).id, "dispute");
  assert.equal(statusChip(bet({ rest: { status: "Open", taker: null } }), null).id, "open");
});

test("concede winner: conceder's side loses (mirrors lib.rs)", () => {
  assert.equal(concedeWinnerOutcome(bet(), "maker.testnet"), "NO");
  assert.equal(concedeWinnerOutcome(bet(), "taker.testnet"), "YES");
  assert.equal(concedeWinnerOutcome(bet(), "stranger.testnet"), null);
});

test("concede sentence names the other side, no numbers", () => {
  const s = concedeSentence(bet(), "maker.testnet");
  assert.match(s, /taker\.testnet/);
  assert.match(s, /cannot be undone/);
  assert.ok(!/\d/.test(s));
});

const deps = (seq: any[]) => { let i = 0; return { getBet: async () => seq[Math.min(i++, seq.length - 1)], sleep: async () => {} }; };

test("concede read-back: success ONLY when get_bet shows the bet decided for the other side", async () => {
  const done = bet({ rest: { status: "Finalized", outcome: "NO" } });
  const r = await confirmConcede({ betId: 7, me: "maker.testnet", deps: deps([bet(), done]), attempts: 4, delayMs: 0 });
  assert.equal(r.kind, "conceded");
  const still = await confirmConcede({ betId: 7, me: "maker.testnet", deps: deps([bet()]), attempts: 3, delayMs: 0 });
  assert.equal(still.kind, "pending");
  const other = await confirmConcede({ betId: 7, me: "maker.testnet", deps: deps([bet({ rest: { status: "Finalized", outcome: "YES" } })]), attempts: 2, delayMs: 0 });
  assert.equal(other.kind, "ruled", "decided the other way before the concede landed: not shown as a concede");
  const voided = await confirmConcede({ betId: 7, me: "maker.testnet", deps: deps([bet({ rest: { status: "Voided" } })]), attempts: 2, delayMs: 0 });
  assert.equal(voided.kind, "ruled");
});

test("pending referee change: reads both sides' proposals, AI shown plainly", () => {
  assert.equal(pendingRefereeProposal(bet()), null);
  const p = pendingRefereeProposal(bet({ rest: { referee_proposal: { maker_value: JSON.stringify({ account: "new.testnet", mode: "Human" }), taker_value: null } } }))!;
  assert.deepEqual(p, { maker: "new.testnet", taker: null, makerSet: true, takerSet: false });
  const q = pendingRefereeProposal(bet({ rest: { referee_proposal: { maker_value: null, taker_value: "null" } } }))!;
  assert.deepEqual(q, { maker: null, taker: "the AI", makerSet: false, takerSet: true });
});

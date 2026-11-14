// FE10b / D-FE10B1: referee change on the live bet page. The amend_referee refusal table is pinned to
// contracts/escrow/src/lib.rs (every require()/panic text in amend_referee, commit_two_party and bet_mut), the relayed args have the exact
// shape services/relayer/src/policy.ts allows, and the read-back only reports success when get_bet shows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AMEND_REFEREE_REFUSALS, plainAmendRefusal, buildAmendRefereeArgs, refereeChangeMode, validateNewReferee, confirmAmend, hasPreflightableSources, proposalToAgree,
} from "../lib/refereeChange";

const here = dirname(fileURLToPath(import.meta.url));
const rsPath = join(here, "../../../contracts/escrow/src/lib.rs");
const rs = readFileSync(rsPath, "utf8");
const lines = rs.split("\n");
const region = (start: string, end: string) => { const a = rs.indexOf(start); const b = rs.indexOf(end, a + 1); assert.ok(a > 0 && b > a, start); return rs.slice(a, b); };
const amend = region("pub fn amend_referee(", "\n    pub fn ");
const commit = region("fn commit_two_party(", "\n    /// v1.1");
const betMut = region("fn bet_mut(", "fn bet(");

const bet = (o: any = {}) => ({
  envelope: { bet_id: 7, maker: "maker.testnet", taker_allow: o.takerAllow ?? "Any", terms: o.terms === undefined ? null : o.terms, terms_hash: "ab".repeat(32), referee: o.referee === undefined ? { account: "ref.testnet", mode: "Human" } : o.referee },
  status: "Taken", taker: "taker.testnet", bonds: [], outcome: null, referee_proposal: { maker_value: null, taker_value: null }, ...o.rest,
}) as any;

const reasonsOf = (raw: string) => { const src = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); return [...src.matchAll(/(?:require\([\s\S]*?,\s*|panic_str\()\s*"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1]); };

test("every require()/panic reason in amend_referee, commit_two_party and bet_mut maps to a plain message (fails when lib.rs adds one)", () => {
  const reasons = [...reasonsOf(amend), ...reasonsOf(commit), ...reasonsOf(betMut)];
  assert.ok(reasons.length >= 8, `found ${reasons.length}`);
  const missing = reasons.filter((r) => !plainAmendRefusal(r).known);
  assert.deepEqual(missing, [], "unmapped amend_referee reasons: add them to AMEND_REFEREE_REFUSALS in lib/refereeChange.ts");
});

test("every table row cites the lib.rs line that raises it, and that line still has the text", () => {
  for (const r of AMEND_REFEREE_REFUSALS) {
    assert.ok(Number.isInteger(r.line) && r.line > 0, r.id);
    assert.ok(lines[r.line - 1].includes(r.source), `${r.id}: lib.rs:${r.line} should contain "${r.source}" but is: ${lines[r.line - 1]?.trim()}`);
  }
});

test("table covers the exact set of reasons (no extra rows for reasons that are gone)", () => {
  const live = new Set([...reasonsOf(amend), ...reasonsOf(commit), ...reasonsOf(betMut)]);
  for (const r of AMEND_REFEREE_REFUSALS) assert.ok([...live].some((x) => x.includes(r.source)), `${r.id} not raised any more`);
});

test("refusal messages: plain, no jargon, no final period; unknown text falls back to 'nothing changed'", () => {
  for (const r of AMEND_REFEREE_REFUSALS) {
    assert.ok(!/bet_id|envelope|predecessor|status|Option<|json|fee_account|BetStatus/i.test(r.message), `${r.id}: ${r.message}`);
    assert.ok(r.message.length > 10 && !r.message.endsWith("."), r.id);
  }
  const f = plainAmendRefusal("something new");
  assert.equal(f.known, false);
  assert.match(f.message, /Nothing changed/);
  assert.equal(plainAmendRefusal("Smart contract panicked: bet already terminal").known, true);
});

test("relayed args are exactly {bet_id: integer, new_referee_json: string} (policy.ts assertAmendRefereeArgs)", () => {
  const a = buildAmendRefereeArgs(7, "newref.testnet");
  assert.deepEqual(Object.keys(a).sort(), ["bet_id", "new_referee_json"]);
  assert.equal(a.bet_id, 7);
  assert.equal(typeof a.new_referee_json, "string");
  assert.deepEqual(JSON.parse(a.new_referee_json as string), { account: "newref.testnet", mode: "Human" });
  assert.equal(buildAmendRefereeArgs(7, null).new_referee_json, "null");
  assert.throws(() => buildAmendRefereeArgs(-1, null));
  assert.throws(() => buildAmendRefereeArgs(1.5, null));
  assert.throws(() => buildAmendRefereeArgs(7, "x".repeat(5000) + ".testnet"));
  // the policy file still says what this builder assumes
  const policy = readFileSync(join(here, "../../../services/relayer/src/policy.ts"), "utf8");
  assert.match(policy, /AMEND_REFEREE_JSON_MAX_BYTES = 4096/);
});

test("the same referee always serialises to the same string (both sides must send identical text, lib.rs commit_two_party m == t)", () => {
  assert.match(commit, /if m == t/);
  assert.equal(buildAmendRefereeArgs(7, "a.testnet").new_referee_json, buildAmendRefereeArgs(9, "a.testnet").new_referee_json);
});

test("mode: maker alone while Open; propose in Taken (both parties); frozen once a ruling/dispute starts; none for outsiders", () => {
  assert.match(amend, /untaken = bet\.status == BetStatus::Open/);
  assert.match(amend, /only the maker may edit an untaken offer/);
  assert.equal(refereeChangeMode(bet({ rest: { status: "Open", taker: null } }), "maker.testnet"), "maker-alone");
  assert.equal(refereeChangeMode(bet({ rest: { status: "Open", taker: null } }), "someone.testnet"), "none");
  assert.equal(refereeChangeMode(bet(), "maker.testnet"), "propose");
  assert.equal(refereeChangeMode(bet(), "taker.testnet"), "propose");
  assert.equal(refereeChangeMode(bet(), "someone.testnet"), "none");
  assert.equal(refereeChangeMode(bet(), null), "none");
  for (const s of ["Resolving", "Proposed", "Challenged", "Evidence", "Rejudge", "Finalized", "Settled", "Voided", "Cancelled", "Expired"]) assert.equal(refereeChangeMode(bet({ rest: { status: s } }), "maker.testnet"), "frozen", s);
  assert.equal(refereeChangeMode(bet({ rest: { bonds: [{}] } }), "maker.testnet"), "frozen");
});

test("new referee validation mirrors amend_referee: not the maker, not the fee account, not the named taker, not the taker", () => {
  assert.match(amend, /referee\.account != bet\.envelope\.maker && referee\.account != fee_account/);
  assert.deepEqual(validateNewReferee("newref.testnet", bet(), "fee.testnet"), []);
  assert.match(validateNewReferee("maker.testnet", bet(), "fee.testnet")[0], /yourself|maker/i);
  assert.match(validateNewReferee("taker.testnet", bet(), "fee.testnet")[0], /taker/i);
  assert.match(validateNewReferee("fee.testnet", bet(), "fee.testnet")[0], /can't be a referee/);
  assert.match(validateNewReferee("named.testnet", bet({ takerAllow: { Account: "named.testnet" }, rest: { taker: null, status: "Open" } }), "fee.testnet")[0], /taker/i);
  assert.ok(validateNewReferee("", bet(), null).length > 0);
  assert.ok(validateNewReferee("abcd1234", bet(), null).length > 0); // a bare 8-char tail is not an account
});

const mkDeps = (seq: any[]) => { let i = 0; return { getBet: async () => seq[Math.min(i++, seq.length - 1)], sleep: async () => {} }; };

test("read-back (maker alone / switch): changed only once get_bet shows the new referee", async () => {
  const before = bet({ rest: { status: "Open", taker: null } });
  const after = bet({ referee: { account: "newref.testnet", mode: "Human" }, rest: { status: "Open", taker: null } });
  const calls: number[] = [];
  const deps = { getBet: async () => { calls.push(1); return calls.length < 3 ? before : after; }, sleep: async () => {} };
  const r = await confirmAmend({ betId: 7, expected: "newref.testnet", via: "maker-alone", me: "maker.testnet", deps, attempts: 6, delayMs: 1 });
  assert.equal(r.kind, "changed");
  assert.equal(calls.length, 3);
  const ai = await confirmAmend({ betId: 7, expected: null, via: "maker-alone", me: "maker.testnet", deps: mkDeps([bet({ referee: null })]), attempts: 2, delayMs: 1 });
  assert.equal(ai.kind, "changed");
  assert.match(ai.message, /AI/);
});

test("read-back (propose): 'proposed' when get_bet shows my side's value, 'changed' when the referee flipped, never success otherwise", async () => {
  const mine = bet({ rest: { referee_proposal: { maker_value: JSON.stringify({ account: "newref.testnet", mode: "Human" }), taker_value: null } } });
  assert.equal((await confirmAmend({ betId: 7, expected: "newref.testnet", via: "propose", me: "maker.testnet", deps: mkDeps([mine]), attempts: 2, delayMs: 1 })).kind, "proposed");
  const takerSide = bet({ rest: { referee_proposal: { maker_value: null, taker_value: JSON.stringify({ account: "newref.testnet", mode: "Human" }) } } });
  assert.equal((await confirmAmend({ betId: 7, expected: "newref.testnet", via: "propose", me: "taker.testnet", deps: mkDeps([takerSide]), attempts: 2, delayMs: 1 })).kind, "proposed");
  const done = bet({ referee: { account: "newref.testnet", mode: "Human" } });
  assert.equal((await confirmAmend({ betId: 7, expected: "newref.testnet", via: "propose", me: "taker.testnet", deps: mkDeps([done]), attempts: 2, delayMs: 1 })).kind, "changed");
  const nothing = await confirmAmend({ betId: 7, expected: "newref.testnet", via: "propose", me: "maker.testnet", deps: mkDeps([bet()]), attempts: 3, delayMs: 1 });
  assert.equal(nothing.kind, "pending");
  assert.doesNotMatch(nothing.message, /changed|proposed it/i);
});

test("read-back: a bet that moved on (ruling started / over) is reported as such, not as success", async () => {
  const r = await confirmAmend({ betId: 7, expected: "newref.testnet", via: "propose", me: "maker.testnet", deps: mkDeps([bet({ rest: { status: "Resolving" } })]), attempts: 2, delayMs: 1 });
  assert.equal(r.kind, "frozen");
});

test("agree: the value to send is the other side's raw proposal string, byte for byte; none when I proposed or nothing is waiting", () => {
  const raw = JSON.stringify({ account: "newref.testnet", mode: "Human" });
  const b = bet({ rest: { referee_proposal: { maker_value: raw, taker_value: null } } });
  const a = proposalToAgree(b, "taker.testnet");
  assert.ok(a);
  assert.equal(a!.json, raw);
  assert.equal(a!.account, "newref.testnet");
  assert.equal(proposalToAgree(b, "maker.testnet"), null);
  assert.equal(proposalToAgree(bet(), "taker.testnet"), null);
  const toAi = bet({ rest: { referee_proposal: { maker_value: "null", taker_value: null } } });
  assert.deepEqual({ json: proposalToAgree(toAi, "taker.testnet")!.json, account: proposalToAgree(toAi, "taker.testnet")!.account }, { json: "null", account: null });
  // already both set but different: the taker may still align with the maker
  const diff = bet({ rest: { referee_proposal: { maker_value: raw, taker_value: "null" } } });
  assert.equal(proposalToAgree(diff, "taker.testnet")!.json, raw);
});

test("switch-to-AI is offered only when the terms text is on the bet and names sources", () => {
  assert.equal(hasPreflightableSources(bet()), false); // hash-only bet: no terms text on-chain
  assert.equal(hasPreflightableSources(bet({ terms: "not json" })), false);
  assert.equal(hasPreflightableSources(bet({ terms: JSON.stringify({ claim: "x", sources_allowed: [] }) })), false);
  assert.equal(hasPreflightableSources(bet({ terms: JSON.stringify({ claim: "x" }) })), false);
  assert.equal(hasPreflightableSources(bet({ terms: JSON.stringify({ claim: "x", sources_allowed: [{ id: "S1", publisher: "NWS" }] }) })), true);
  assert.equal(hasPreflightableSources(bet({ referee: null, terms: JSON.stringify({ sources_allowed: [{ id: "S1" }] }) })), false); // already AI
});

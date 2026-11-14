// FE9 (S11): every way the contract's Take path can refuse (full refund, I-3) maps to a plain message. Pinned to lib.rs:
// a NEW take_rejected reason or silent refusal there fails this test until lib/takeRefusal.ts is updated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TAKE_REFUSALS, SILENT_TAKE_REFUSALS, plainTakeRefusal, parseTakeRejected, takeRefusalSentence } from "../lib/takeRefusal";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
const unescape = (s: string) => s.replace(/\\"/g, '"');
const sample = (s: string) => s.replace(/\{[^}]*\}/g, "7");
const a = rs.indexOf("fn handle_take(");
const b = rs.indexOf("fn handle_bond(", a);
const take = rs.slice(a, b);

function loggedReasons(): string[] {
  return [...take.matchAll(/take_rejected (?:bet_id=\{bet_id\} )?reason=((?:[^"\\]|\\.)*)"/g)].map((m) => unescape(m[1]));
}

test("handle_take region found and logs take_rejected reasons", () => {
  assert.ok(a > 0 && b > a);
  assert.ok(loggedReasons().length >= 4, `found ${loggedReasons().length}`);
});

test("every logged take_rejected reason maps to a plain message (fails when lib.rs adds a new one)", () => {
  const missing = loggedReasons().filter((r) => !plainTakeRefusal(sample(r)).known);
  assert.deepEqual(missing, [], "unmapped take_rejected reasons: add them to TAKE_REFUSALS in lib/takeRefusal.ts");
});

test("every table row still names text that exists in lib.rs", () => {
  for (const e of TAKE_REFUSALS) assert.ok(rs.includes(e.source), `row ${e.id}: "${e.source}" not in lib.rs`);
});

test("silent refusals in handle_take are pinned: a new one fails until documented", () => {
  const lines = take.split("\n");
  let n = 0;
  lines.forEach((l, i) => { if (/return false;/.test(l) && !lines.slice(Math.max(0, i - 3), i + 1).some((x) => x.includes("take_rejected"))) n++; });
  assert.equal(n, SILENT_TAKE_REFUSALS.length);
  for (const s of SILENT_TAKE_REFUSALS) assert.ok(s.id && s.message.length > 10);
});

test("only the pinned missing-config panics exist before the first write", () => {
  const before = take.slice(0, take.indexOf("all checks passed: first write"));
  const panics = [...before.matchAll(/panic_str\("([^"]*)"\)/g)].map((m) => m[1]);
  assert.deepEqual(panics.sort(), ["missing fee_min_taker_options copy", "taker option asset has no asset limit", "taker_asset has no asset limit"].sort());
});

test("plain messages: no jargon, a clause without a final period", () => {
  for (const e of TAKE_REFUSALS) {
    assert.ok(!/referee_ack|taker_asset|taker_options|fee_bps|envelope|whitelist/i.test(e.message), `${e.id}: ${e.message}`);
    assert.ok(e.message.length > 10 && !e.message.endsWith("."), `${e.id}`);
  }
});

test("specific mappings", () => {
  assert.match(plainTakeRefusal("referee_ack does not match the bet's referee").message, /referee.*changed/i);
  assert.match(plainTakeRefusal("deposit does not exactly match taker_asset or any taker_options entry").message, /amount|currency/i);
  assert.match(plainTakeRefusal("fee + tip exceeds stake").message, /tip/i);
  assert.match(plainTakeRefusal("tip requires a referee").message, /tip/i);
});

test("unknown reason: safe fallback; null reason: the silent explanation", () => {
  assert.equal(plainTakeRefusal("brand new reason xyz").known, false);
  const n = plainTakeRefusal(null);
  assert.equal(n.known, false);
  assert.match(n.message, /taken|cancel|expired/i);
});

test("parseTakeRejected reads the first take_rejected log line (both shapes)", () => {
  assert.equal(parseTakeRejected(["x", "take_rejected reason=tip requires a referee"]), "tip requires a referee");
  assert.equal(parseTakeRejected(["take_rejected bet_id=4 reason=deposit does not exactly match taker_asset or any taker_options entry"]), "deposit does not exactly match taker_asset or any taker_options entry");
  assert.equal(parseTakeRejected(["take bet_id=4 taker=a"]), null);
});

test("sentence: refunded vs on its way", () => {
  assert.equal(takeRefusalSentence("tip requires a referee"), "The contract refused this take: you can only tip a referee when a person is deciding the bet. Your money was returned.");
  assert.match(takeRefusalSentence("tip requires a referee", false), /on its way back; check My bets/);
});

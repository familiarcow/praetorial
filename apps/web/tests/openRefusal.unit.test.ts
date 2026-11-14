// FE8 (S8): every way the contract's Open path can refuse (full refund, I-3) maps to a plain message. The table is checked
// against contracts/escrow/src/lib.rs itself, so a NEW open_rejected reason / sanity_check error / silent refusal there
// fails this test until the table (lib/openRefusal.ts) is updated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OPEN_REFUSALS, SILENT_OPEN_REFUSALS, PRE_HANDLER_SILENT_REFUSALS, plainOpenRefusal, refusalSentence, parseOpenRejected, DECLINED_MESSAGE } from "../lib/openRefusal";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
const unescape = (s: string) => s.replace(/\\"/g, '"');
const sample = (s: string) => s.replace(/\{[^}]*\}/g, "7");

function loggedReasons(): string[] {
  const out: string[] = [];
  for (const m of rs.matchAll(/open_rejected bet=unassigned reason=((?:[^"\\]|\\.)*)"/g)) out.push(unescape(m[1]));
  return out;
}
function sanityErrors(): string[] {
  const start = rs.indexOf("fn sanity_check(&self)");
  const end = rs.indexOf("Ok(())", start);
  const body = rs.slice(start, end);
  return [...body.matchAll(/Err\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => unescape(m[1]));
}
function region(from: string, to: string): string {
  const a = rs.indexOf(from); const b = rs.indexOf(to, a);
  assert.ok(a > 0 && b > a, `region ${from}`);
  return rs.slice(a, b);
}
function silentCount(body: string, ret: RegExp): number {
  const lines = body.split("\n");
  let n = 0;
  lines.forEach((l, i) => { if (ret.test(l) && !lines.slice(Math.max(0, i - 3), i + 1).some((x) => x.includes("open_rejected"))) n++; });
  return n;
}

test("the contract logs open_rejected reasons we can read (sanity: grep finds them)", () => {
  assert.ok(loggedReasons().length >= 20, `found ${loggedReasons().length}`);
  assert.ok(sanityErrors().length >= 15, `found ${sanityErrors().length}`);
});

test("every logged open_rejected reason maps to a plain message (fails when lib.rs adds a new one)", () => {
  // "{reason}" is the sanity_check pass-through, covered by the next test.
  const missing = loggedReasons().filter((r) => r !== "{reason}" && !plainOpenRefusal(sample(r)).known);
  assert.deepEqual(missing, [], "unmapped open_rejected reasons: add them to OPEN_REFUSALS in lib/openRefusal.ts");
});

test("every sanity_check error string (logged via reason={reason}) maps to a plain message", () => {
  const missing = sanityErrors().filter((r) => !plainOpenRefusal(r).known);
  assert.deepEqual(missing, [], "unmapped sanity_check errors");
});

test("every table entry still names text that exists in lib.rs (stale rows fail)", () => {
  for (const e of OPEN_REFUSALS) assert.ok(rs.includes(e.source), `table row ${e.id}: "${e.source}" not found in lib.rs`);
});

test("silent refusals (return false without a log) are pinned: a new one fails until documented", () => {
  const open = region("fn handle_open(", "let bet_id = self.next_bet_id;");
  assert.equal(silentCount(open, /return false;/), SILENT_OPEN_REFUSALS.length);
  const pre = region("pub fn mt_on_transfer(", "fn handle_open(");
  assert.equal(silentCount(pre, /return PromiseOrValue::Value\(amounts\);/), PRE_HANDLER_SILENT_REFUSALS);
  for (const s of SILENT_OPEN_REFUSALS) assert.ok(s.message.length > 10 && s.id);
});

test("no require!/panic on the Open path (I-3: refusals are refunds, never a panic)", () => {
  const open = region("fn handle_open(", "let bet_id = self.next_bet_id;");
  assert.ok(!/\brequire\(|panic_str|panic!|assert!\(/.test(open), "handle_open must not panic");
  assert.ok(!/\brequire\(|panic_str|panic!/.test(region("pub fn mt_on_transfer(", "fn handle_open(")), "mt_on_transfer must not panic");
});

test("plain messages: no raw jargon, no field names, a clause without a final period", () => {
  for (const e of OPEN_REFUSALS) {
    assert.ok(!/stake_maker|stake_taker|maker_asset|taker_asset|asset_limits|fee_bps|taker_options|resolve_deadline|funding_deadline|sanity|envelope|whitelist/i.test(e.message), `${e.id}: ${e.message}`);
    assert.ok(e.message.length > 10 && !e.message.endsWith("."), `${e.id}: ${e.message}`);
  }
});

test("specific mappings", () => {
  assert.match(plainOpenRefusal("deposit does not equal stake_maker + the maker-asset storage charge").message, /amount.*storage|storage.*amount/i);
  assert.match(plainOpenRefusal("sourcecheck attestation stale (older than 1h)").message, /sources/i);
  assert.match(plainOpenRefusal("referee cannot be maker or fee_account").message, /referee/i);
  assert.match(plainOpenRefusal("beta sunset reached, no new offers").message, /no longer|closed|not taking/i);
  assert.match(plainOpenRefusal("fee_bps must equal the pinned protocol fee (100 bps), got 5").message, /fee/i);
});

test("unknown reason: safe fallback with known=false", () => {
  const r = plainOpenRefusal("brand new reason xyz");
  assert.equal(r.known, false);
  assert.match(r.message, /didn't accept|couldn't accept|couldn't open/i);
});

test("refusalSentence follows the S8 copy", () => {
  assert.equal(refusalSentence("referee cannot be maker or fee_account"), `The contract refused this bet: ${plainOpenRefusal("referee cannot be maker or fee_account").message}. Your money was returned.`);
  assert.equal(refusalSentence(null), "The contract refused this bet: it didn't say why. Your money was returned.");
  assert.equal(DECLINED_MESSAGE, "You cancelled. Nothing was sent.");
});

test("parseOpenRejected finds the reason in tx logs; null when absent", () => {
  assert.equal(parseOpenRejected(["foo", "open_rejected bet=unassigned reason=tip requires a referee", "bar"]), "tip requires a referee");
  assert.equal(parseOpenRejected(["EVENT_JSON:{}"]), null);
  assert.equal(parseOpenRejected([]), null);
});

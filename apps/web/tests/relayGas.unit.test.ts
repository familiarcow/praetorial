// REFGAS1: every relayed call must carry gas >= the contract's worst case for that method, from ONE table (lib/relayGas.ts)
// that cites contracts/escrow/src/lib.rs. A human referee's referee_rule schedules up to 5 payouts x (15+10) Tgas and ran out of
// prepaid gas at the old 80 Tgas default (DR5 live, tx FqawWQJpM67YzBKEutNStjQcqfRiB3bdMkk3NPCgsfyJ).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RELAY_GAS_TGAS, MAX_PREPAID_TGAS, gasForMethod, contractRefusalMessage } from "../lib/relayGas";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const libRs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
const rsTgas = (name: string) => Number(new RegExp(`const ${name}: Gas = Gas::from_tgas\\((\\d+)\\)`).exec(libRs)![1]);
const PAYOUT = rsTgas("PAYOUT_GAS") + rsTgas("PAYOUT_CALLBACK_GAS");
const MAX_DRAIN_BATCH = Number(/const MAX_DRAIN_BATCH: u64 = (\d+)/.exec(libRs)![1]);

test("table is capped at NEAR's 300 Tgas per transaction", () => {
  assert.equal(MAX_PREPAID_TGAS, 300);
  for (const [m, g] of Object.entries(RELAY_GAS_TGAS)) assert.ok(g > 0 && g <= 300, `${m}=${g}`);
});

test("payout-scheduling escrow methods get the full 300 Tgas (referee_rule can fan out 5 payouts x 25 Tgas plus a drain of up to 10)", () => {
  assert.ok(MAX_DRAIN_BATCH * PAYOUT <= 300 && 5 * PAYOUT + 100 <= 300);
  for (const m of ["referee_rule", "finalize", "concede", "cancel", "void_after_deadline", "emergency_refund", "drain_payouts"]) {
    assert.equal(gasForMethod(m), 300, m);
  }
});

test("request_resolution covers OUTLAYER_GAS + RESOLUTION_CALLBACK_GAS", () => {
  assert.ok(gasForMethod("request_resolution") >= rsTgas("OUTLAYER_GAS") + rsTgas("RESOLUTION_CALLBACK_GAS"));
});

test("every method the web relays has a table entry (no silent default)", () => {
  for (const m of ["referee_rule", "concede", "cancel", "mt_transfer_call", "void_after_deadline", "request_resolution", "finalize", "amend_referee", "submit_exhibits", "emergency_refund", "drain_payouts", "ft_withdraw", "storage_deposit", "near_deposit", "ft_transfer_call"]) {
    assert.ok(RELAY_GAS_TGAS[m] >= 30, m);
  }
  assert.throws(() => gasForMethod("no_such_method"), /no gas entry/);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === "dist") continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

test("no component or lib passes a literal gas number (only lib/relayGas.ts holds numbers)", () => {
  const offenders: string[] = [];
  for (const f of [...walk(join(web, "src")), ...walk(join(web, "lib"))]) {
    if (f.endsWith("relayGas.ts") || f.endsWith("delegate.ts")) continue;
    readFileSync(f, "utf8").split("\n").forEach((l, i) => { if (/gasTgas\s*[:=?]+\s*\??\s*\d|GAS_TGAS\s*=\s*\d|gasTgas \?\? \d/.test(l)) offenders.push(`${f.slice(web.length + 1)}:${i + 1}: ${l.trim()}`); });
  }
  assert.deepEqual(offenders, []);
});

test("useRelayAction takes its default gas from the table", () => {
  const s = readFileSync(join(web, "lib/useRelayAction.ts"), "utf8");
  assert.match(s, /gasForMethod\(p\.methodName\)/);
  assert.doesNotMatch(s, /gasTgas \?\? 80/);
});

test("on-chain failure is reported as the contract refusing, never 'Nothing was sent'", () => {
  const m = contractRefusalMessage({ ok: false, txHash: "TX1", receiptFailure: '[{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: only the named referee may rule"}}}}]', error: "transaction failed on chain: x" });
  assert.equal(m, "The contract refused this: only the named referee may rule. No money moved.");
  const g = contractRefusalMessage({ ok: false, txHash: "TX2", receiptFailure: "Exceeded the prepaid gas." });
  assert.match(g!, /^The contract refused this: Exceeded the prepaid gas\./);
  assert.doesNotMatch(g!, /Nothing was sent/);
  // never reached the chain -> not this message
  assert.equal(contractRefusalMessage({ ok: false, error: "relayer http 429" }), null);
});

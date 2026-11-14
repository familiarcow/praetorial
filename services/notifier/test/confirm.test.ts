// D-DSY1 (2): notifier announces a terminal outcome only after rpcUrls[1] agrees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterConfirmedTerminals } from "../src/confirm.js";
import { computeNoticesMulti } from "../src/notifier.js";
import { ServiceAlertRaiser } from "../../monitor/src/serviceAlerts.js";
import type { Alert } from "../../monitor/src/alerts.js";

const NS = 1_000_000_000;
const bet = (over: any = {}): any => ({
  envelope: { maker: "maker1.testnet", terms_hash: "x", settlement_period: 10 * NS },
  status: "Settled", taker: "taker1.testnet", created_at: 1, proposed_at: 0, outcome: "YES", ...over,
});
const second = (b: any | "dead"): any => ({
  async view() { if (b === "dead") throw new Error("down"); return b; },
});
function raiser() {
  const sent: Alert[] = [];
  return { sent, r: new ServiceAlertRaiser({ async send(a: Alert) { sent.push(a); } }, 0) };
}
const input = () => new Map([["e.testnet", new Map([[1, bet()]])]]);
async function announce(sec: any, cache = new Set<string>()) {
  const { sent, r } = raiser();
  const seen = new Set<string>();
  const filtered = await filterConfirmedTerminals(input(), { second: sec, raiser: r, cache });
  return { sent, seen, notices: computeNoticesMulti(filtered, NS, seen) };
}

test("agree -> settled notice announced, no alert", async () => {
  const { sent, notices } = await announce(second(bet()));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "settled");
  assert.equal(sent.length, 0);
});

test("disagree -> nothing announced, no winner text, alert", async () => {
  const { sent, notices } = await announce(second(bet({ outcome: "NO" })));
  assert.equal(notices.length, 0);
  assert.equal(sent[0].kind, "terminal_unconfirmed");
});

test("second RPC down -> nothing announced, alert", async () => {
  const { sent, notices } = await announce(second("dead"));
  assert.equal(notices.length, 0);
  assert.equal(sent.length, 1);
});

test("single RPC configured -> nothing announced, 'single RPC' alert", async () => {
  const { sent, notices } = await announce(null);
  assert.equal(notices.length, 0);
  assert.ok(sent.some((a) => a.kind === "terminal_single_rpc"));
});

test("Voided is gated too; non-terminal passes through untouched", async () => {
  const { r } = raiser();
  const m = new Map([["e.testnet", new Map([[1, bet({ status: "Voided", outcome: "VOID" })], [2, bet({ status: "Taken", outcome: null })]])]]);
  const f = await filterConfirmedTerminals(m, { second: second("dead"), raiser: r, cache: new Set() });
  assert.deepEqual([...f.get("e.testnet")!.keys()], [2]);
});

test("unconfirmed terminal is not marked seen, so it is announced once confirmed later (exactly once)", async () => {
  const seen = new Set<string>();
  const cache = new Set<string>();
  const { r } = raiser();
  const f1 = await filterConfirmedTerminals(input(), { second: second("dead"), raiser: r, cache });
  assert.equal(computeNoticesMulti(f1, NS, seen).length, 0);
  const f2 = await filterConfirmedTerminals(input(), { second: second(bet()), raiser: r, cache });
  assert.equal(computeNoticesMulti(f2, NS, seen).length, 1);
  const f3 = await filterConfirmedTerminals(input(), { second: second("dead"), raiser: r, cache });
  assert.equal(computeNoticesMulti(f3, NS, seen).length, 0); // cached confirmed, already seen
  assert.equal(f3.get("e.testnet")!.size, 1);
});

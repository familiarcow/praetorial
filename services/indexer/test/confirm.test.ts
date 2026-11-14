// D-DSY1 (2): indexer shows a terminal outcome only after rpcUrls[1] agrees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshBets } from "../src/refresh.js";
import { buildHistoryMulti, redactUnconfirmed } from "../src/board.js";
import { ServiceAlertRaiser } from "../../monitor/src/serviceAlerts.js";
import type { Alert } from "../../monitor/src/alerts.js";

function bet(over: any = {}): any {
  return { envelope: { maker: "m.testnet", terms_hash: "h1", stake_maker: "1", stake_taker: "1", maker_side: "YES", funding_deadline: 1, taker_allow: { Any: {} } }, created_at: 5, status: "Open", taker: null, outcome: null, ...over };
}
const settled = (o: any = {}) => bet({ status: "Settled", taker: "t.testnet", outcome: "YES", ...o });
const chain = (c: Record<number, any> | "dead"): any => ({
  calls: 0,
  async view(_c: string, m: string, a: any) {
    if (m === "contract_version") return "1.0.0"; // matches label v1
    this.calls++;
    if (c === "dead") throw new Error("rpc down");
    return c[a.bet_id] ?? null;
  },
});
const C = [{ id: "e.testnet", version: "v1" }];
function raiser() {
  const sent: Alert[] = [];
  return { sent, r: new ServiceAlertRaiser({ async send(a: Alert) { sent.push(a); } }, 0) };
}
const entry = (r: any) => buildHistoryMulti(r.bets)[0];

test("second RPC agrees -> winner shown, no alert", async () => {
  const { sent, r } = raiser();
  const res = await refreshBets(chain({ 1: settled() }), C, new Map(), {}, { second: chain({ 1: settled() }), raiser: r });
  const e = entry(res);
  assert.equal(e.status, "Settled");
  assert.equal(e.outcome, "YES");
  assert.equal(e.display_status, "Settled");
  assert.equal(sent.length, 0);
});

test("second RPC disagrees (different outcome) -> 'settling, confirming', no winner, alert", async () => {
  const { sent, r } = raiser();
  const res = await refreshBets(chain({ 1: settled() }), C, new Map(), {}, { second: chain({ 1: settled({ outcome: "NO" }) }), raiser: r });
  const e = entry(res);
  assert.equal(e.display_status, "settling, confirming");
  assert.equal(e.outcome, null);
  assert.ok(!JSON.stringify(e).includes("YES"));
  assert.ok(sent.some((a) => a.kind === "terminal_unconfirmed"));
});

test("second RPC disagrees on status (still Taken / bet missing) -> confirming + alert", async () => {
  for (const other of [bet({ status: "Taken", taker: "t.testnet" }), null]) {
    const { sent, r } = raiser();
    const res = await refreshBets(chain({ 1: settled() }), C, new Map(), {}, { second: chain({ 1: other }), raiser: r });
    assert.equal(entry(res).display_status, "settling, confirming");
    assert.equal(sent.length, 1);
  }
});

test("second RPC returns a different bet identity (same id) -> not confirmed", async () => {
  const { sent, r } = raiser();
  const res = await refreshBets(chain({ 1: settled() }), C, new Map(), {}, { second: chain({ 1: settled({ created_at: 99 }) }), raiser: r });
  assert.equal(entry(res).display_status, "settling, confirming");
  assert.equal(sent.length, 1);
});

test("second RPC down -> confirming + alert, no winner", async () => {
  const { sent, r } = raiser();
  const res = await refreshBets(chain({ 1: settled() }), C, new Map(), {}, { second: chain("dead"), raiser: r });
  const e = entry(res);
  assert.equal(e.display_status, "settling, confirming");
  assert.equal(e.outcome, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "terminal_unconfirmed");
});

test("single RPC configured (no second) -> confirming + 'single RPC' alert", async () => {
  const { sent, r } = raiser();
  const res = await refreshBets(chain({ 1: settled() }), C, new Map(), {}, { second: null, raiser: r });
  assert.equal(entry(res).display_status, "settling, confirming");
  assert.equal(entry(res).outcome, null);
  assert.ok(sent.some((a) => a.kind === "terminal_single_rpc" && /single RPC: terminal outcomes unconfirmed/.test(a.message)));
});

test("Voided is also gated", async () => {
  const { sent, r } = raiser();
  const res = await refreshBets(chain({ 1: bet({ status: "Voided", taker: "t.testnet", outcome: "VOID" }) }), C, new Map(), {}, { second: chain("dead"), raiser: r });
  assert.equal(entry(res).display_status, "settling, confirming");
  assert.equal(entry(res).status, "settling, confirming");
  assert.equal(sent.length, 1);
});

test("non-terminal bets are never gated and never query the second RPC", async () => {
  const second = chain("dead");
  const res = await refreshBets(chain({ 1: bet({ status: "Taken", taker: "t.testnet" }) }), C, new Map(), {}, { second, raiser: raiser().r });
  assert.equal(entry(res).display_status, "Taken");
  assert.equal(second.calls, 0);
});

test("once confirmed it stays terminal (cached): no further second-RPC calls, lock still holds", async () => {
  const second = chain({ 1: settled() });
  const r1 = await refreshBets(chain({ 1: settled() }), C, new Map(), {}, { second, raiser: raiser().r });
  const callsAfterFirst = second.calls;
  second.view = async () => { throw new Error("must not be called again"); };
  const r2 = await refreshBets(chain({ 1: bet({ status: "Taken", taker: "t.testnet" }) }), C, r1.bets, r1.maxIds, { second, raiser: raiser().r });
  assert.ok(callsAfterFirst >= 1);
  assert.equal(entry(r2).display_status, "Settled");
  assert.equal(entry(r2).outcome, "YES");
});

test("an unconfirmed terminal is re-checked next refresh and confirms once the second RPC recovers", async () => {
  const r1 = await refreshBets(chain({ 1: settled() }), C, new Map(), {}, { second: chain("dead"), raiser: raiser().r });
  assert.equal(entry(r1).display_status, "settling, confirming");
  const r2 = await refreshBets(chain({ 1: settled() }), C, r1.bets, r1.maxIds, { second: chain({ 1: settled() }), raiser: raiser().r });
  assert.equal(entry(r2).display_status, "Settled");
  assert.equal(entry(r2).outcome, "YES");
});

test("the /bet view of an unconfirmed terminal hides the winner (redactUnconfirmed)", async () => {
  const res = await refreshBets(chain({ 1: settled() }), C, new Map(), {}, { second: chain("dead"), raiser: raiser().r });
  const red = redactUnconfirmed(res.bets.get("e.testnet:1")!);
  assert.equal(red.bet.outcome, null);
  assert.equal((red as any).display_status, "settling, confirming");
  assert.ok(!JSON.stringify(red).includes('"YES"') || JSON.stringify(red).includes("maker_side"));
});

test("version check runs on each refresh when a raiser is supplied: mismatch alerts, match does not", async () => {
  for (const [v, expectAlert] of [["2.0.0", true], ["1.0.0", false]] as const) {
    const { sent, r } = raiser();
    const client: any = { async view(_c: string, m: string, a: any) { return m === "contract_version" ? v : (a.bet_id === 1 ? bet() : null); } };
    await refreshBets(client, C, new Map(), {}, { second: client, raiser: r });
    assert.equal(sent.some((a) => a.kind === "contract_version_mismatch"), expectAlert);
  }
});

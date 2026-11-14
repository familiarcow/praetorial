// JC1y: the indexer indexes every NEP-297 governance event the escrow emits (judge chain, guardian, assets, amendments,
// model observations) from RECEIPTS, and ignores logs of failed receipts (D-JCD1 #5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { indexGovernance, GOVERNANCE_KINDS } from "../src/governance.js";
import { refreshGovernance } from "../src/refresh.js";
import { createServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const LOGS: Record<string, string> = JSON.parse(readFileSync(join(here, "fixtures", "governance_logs.json"), "utf8"));
const ESCROW = "escrow.testnet";
const OKS = { SuccessValue: "" };
const rc = (logs: string[], status: any = OKS, ts = "1700000000000000000", id = "r") =>
  ({ receipt: { receipt_id: id, receiver_id: ESCROW }, execution_outcome: { block_timestamp: ts, outcome: { logs, status } } });
const hist = (...r: any[]) => r.map((x, i) => ({ hash: `tx${i}`, rc: x }));

const CASES: [string, string, string][] = [
  ["judge_pair_proposed", "judge_pair_proposed", "judge_chain"],
  ["judge_pair_applied", "judge_pair_applied", "judge_chain"],
  ["judge_pair_cancelled", "judge_pair_cancelled", "judge_chain"],
  ["guardian_proposed", "guardian_proposed", "guardian"],
  ["guardian_rotated", "guardian_rotated", "guardian"],
  ["guardian_cancelled", "guardian_cancelled", "guardian"],
  ["asset_proposed", "asset_proposed", "asset"],
  ["asset_applied", "asset_applied", "asset"],
  ["asset_cancelled", "asset_cancelled", "asset"],
  ["asset_disabled", "asset_disabled", "asset"],
  ["terms_amend_proposed", "terms_amend_proposed", "amendment"],
  ["terms_amended", "terms_amended", "amendment"],
  ["referee_amend_proposed", "referee_amend_proposed", "amendment"],
  ["referee_amended", "referee_amended", "amendment"],
  ["model_observation_retry", "outcome_retry", "model_observation"],
  ["model_observation_submitted", "outcome_submitted", "model_observation"],
];

for (const [fx, event, kind] of CASES) {
  test(`indexer indexes ${fx} (${event}) as kind ${kind} with tx hash and block time`, () => {
    const out = indexGovernance(ESCROW, hist(rc([LOGS[fx]], OKS, "1700000000000000042")));
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.equal(out[0].event, event);
    assert.equal(out[0].kind, kind);
    assert.equal(out[0].contract_id, ESCROW);
    assert.equal(out[0].tx_hash, "tx0");
    assert.equal(out[0].block_timestamp, "1700000000000000042");
    assert.ok(out[0].data && typeof out[0].data === "object");
  });
}

test("every CASES kind is a declared GOVERNANCE_KINDS kind, and a non-governance event (bet_opened) is not indexed", () => {
  for (const [, , k] of CASES) assert.ok((GOVERNANCE_KINDS as readonly string[]).includes(k), k);
  assert.deepEqual(indexGovernance(ESCROW, hist(rc([LOGS.unrelated_bet_opened]))), []);
});

test("a log from a FAILED receipt is not indexed (D-JCD1 #5); the same log in a successful receipt is", () => {
  const failed = rc([LOGS.terms_amend_proposed, LOGS.guardian_rotated], { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked" } } } } });
  assert.deepEqual(indexGovernance(ESCROW, hist(failed)), []);
  assert.equal(indexGovernance(ESCROW, hist(rc([LOGS.terms_amend_proposed, LOGS.guardian_rotated]))).length, 2);
});

test("a receipt with no status at all is not trusted (not indexed)", () => {
  assert.deepEqual(indexGovernance(ESCROW, hist({ receipt: { receipt_id: "x", receiver_id: ESCROW }, execution_outcome: { block_timestamp: "1", outcome: { logs: [LOGS.guardian_rotated] } } })), []);
});

test("receipts to other accounts and other event standards are ignored; output is in block order", () => {
  const other = { ...rc([LOGS.guardian_rotated]), receipt: { receipt_id: "o", receiver_id: "someone.else" } };
  const foreign = rc([`EVENT_JSON:${JSON.stringify({ standard: "nep171", version: "1.0.0", event: "guardian_rotated", data: [{}] })}`]);
  const a = rc([LOGS.asset_proposed], OKS, "20", "a"), b = rc([LOGS.asset_cancelled], OKS, "10", "b");
  const out = indexGovernance(ESCROW, hist(other, foreign, a, b));
  assert.deepEqual(out.map((e) => e.event), ["asset_cancelled", "asset_proposed"]);
});

test("refreshGovernance keeps previous entries for a contract whose history fetch fails, and replaces the others", async () => {
  const prev = new Map([["bad.testnet", indexGovernance(ESCROW, hist(rc([LOGS.guardian_proposed])))], [ESCROW, []]]);
  const fetchHistory = async (c: string) => { if (c === "bad.testnet") throw new Error("down"); return hist(rc([LOGS.judge_pair_applied])); };
  const r = await refreshGovernance(fetchHistory, ["bad.testnet", ESCROW], prev);
  assert.equal(r.events.get("bad.testnet")!.length, 1);
  assert.equal(r.events.get(ESCROW)![0].event, "judge_pair_applied");
  assert.deepEqual(r.failed.map((f) => f.contractId), ["bad.testnet"]);
});

test("server GET /governance serves the indexed events, filterable by contract_id and kind", async () => {
  const events = new Map([[ESCROW, indexGovernance(ESCROW, hist(rc([LOGS.guardian_rotated, LOGS.asset_disabled])))]]);
  const srv = createServer(() => new Map(), () => events);
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;
  try {
    const all: any[] = await (await fetch(`http://127.0.0.1:${port}/governance`)).json() as any[];
    assert.equal(all.length, 2);
    const g: any[] = await (await fetch(`http://127.0.0.1:${port}/governance?contract_id=${ESCROW}&kind=guardian`)).json() as any[];
    assert.deepEqual(g.map((e: any) => e.event), ["guardian_rotated"]);
  } finally { srv.close(); }
});

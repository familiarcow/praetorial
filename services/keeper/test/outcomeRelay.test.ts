// KEEPSUBMIT1 RED: tickMulti relays the resolver's stored signed result to the permissionless submit_outcome.
// Integration part: FakeEscrow re-implements submit_outcome's gates (status, terms_hash, used/next/pending run_no, REAL ed25519 verify of the
// borsh buffer against resolver_keys()[0]) and moves the bet to Proposed. SIMULATED: only the contract + OutLayer callback (the stored raw is
// the shape on_resolution stores, signed with a test key); the keeper code, arg building and signature bytes are the production ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nacl from "tweetnacl";
import { tickMulti } from "../src/runner.js";
import { TxLogger } from "@praetorial/common/logger.js";
import { buildSubmitOutcomeMessage, generateResolverKeypair } from "@praetorial/common/resolverSign.js";
import { makeRaw, makeBet } from "./helpers/signedRaw.js";

const kp = generateResolverKeypair();
const FRZ3 = "frz3.testnet", FRZ2 = "frz2.testnet";

class FakeEscrow {
  calls: { contract: string; method: string; args: any }[] = [];
  failNext = 0;
  constructor(public bets: Record<string, Record<number, any>>) {}
  async view(c: string, m: string, a: any): Promise<any> {
    if (m === "get_bet") return this.bets[c]?.[a.bet_id] ?? null;
    if (m === "pending_payouts_view") return [];
    if (m === "is_shutdown") return false;
    if (m === "resolver_keys") return [kp.publicKeyHex, "", ""];
    throw new Error(`unexpected view ${m}`);
  }
  async call(c: string, m: string, a: any): Promise<any> {
    this.calls.push({ contract: c, method: m, args: a });
    if (m !== "submit_outcome") return {};
    if (this.failNext > 0) { this.failNext--; throw new Error("rpc timeout"); }
    const r = a.result; const bet = this.bets[c][r.bet_id];
    if (!["Taken", "Resolving", "Challenged", "Evidence"].includes(bet.status)) throw new Error("bet not awaiting an outcome");
    if (r.terms_hash !== bet.envelope.terms_hash) throw new Error("terms_hash mismatch");
    if (bet.used_run_nos.includes(r.run_no)) throw new Error("run_no already used");
    if (r.run_no !== bet.next_expected_run_no) throw new Error("run_no out of order");
    if (bet.pending_run_no != null && r.run_no !== bet.pending_run_no) throw new Error("run_no does not match the pending resolution request");
    if (typeof r.checked_until !== "string") throw new Error("checked_until must be a U64 string");
    const ok = nacl.sign.detached.verify(buildSubmitOutcomeMessage(c, r), Buffer.from(a.signature_hex, "hex"), Buffer.from(kp.publicKeyHex, "hex"));
    if (!ok) throw new Error("bad signature");
    bet.status = "Proposed"; bet.outcome = r.outcome; bet.used_run_nos.push(r.run_no); bet.pending_run_no = null; bet.proposed_at = Date.now() * 1_000_000;
    return { transaction: { hash: "tx" + r.bet_id } };
  }
  async callPayable(c: string, m: string, a: any) { return this.call(c, m, a); }
  submits() { return this.calls.filter((x) => x.method === "submit_outcome"); }
}

function setup(chain: FakeEscrow) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepsubmit1-"));
  const logPath = path.join(dir, "log.jsonl");
  const logger = new TxLogger(logPath);
  const statePath = path.join(dir, "state.json");
  const contracts = [{ id: FRZ3, version: "v1" }, { id: FRZ2, version: "v1" }];
  const tick = () => tickMulti({ client: chain as any, contracts, logger, statePath, nowMs: () => Date.now() });
  const logs = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { tick, logs };
}
const raw = (c: string, betId: number, o: any = {}) => makeRaw({ contract: c, betId, runNo: 1, kp, ...o });

test("relays a stored signed result on every escrow in ESCROW_CONTRACTS; the bet moves to Proposed; second tick is a no-op", async () => {
  const chain = new FakeEscrow({
    [FRZ3]: { 1: makeBet("Resolving", raw(FRZ3, 1), { betId: 1 }) },
    [FRZ2]: { 1: makeBet("Resolving", raw(FRZ2, 1, { outcome: "YES" }), { betId: 1 }) },
  });
  const { tick, logs } = setup(chain);
  await tick();
  assert.deepEqual(chain.submits().map((x) => x.contract).sort(), [FRZ2, FRZ3]);
  assert.equal(chain.bets[FRZ3][1].status, "Proposed");
  assert.equal(chain.bets[FRZ3][1].outcome, "NO");
  assert.equal(chain.bets[FRZ2][1].status, "Proposed");
  assert.equal(chain.bets[FRZ2][1].outcome, "YES");
  const stored = JSON.parse(chain.bets[FRZ3][1].last_resolution_raw);
  assert.equal(chain.submits().find((x) => x.contract === FRZ3)!.args.signature_hex, stored.signing.signature_hex);
  const ok = logs().filter((l) => l.service === "keeper-outcome-relay" && l.action === "submit_outcome" && l.status === "ok");
  assert.equal(ok.length, 2, "one ok log line per relayed bet");
  assert.deepEqual(ok.map((l) => l.contract_id).sort(), [FRZ2, FRZ3]);
  assert.ok(ok.every((l) => typeof l.bet_id === "number" && l.detail));
  await tick();
  assert.equal(chain.submits().length, 2, "idempotent: nothing resubmitted");
});

test("never submits unsigned / malformed / used / mismatched / wrong-status bets, and never crashes the tick", async () => {
  const chain = new FakeEscrow({
    [FRZ3]: {
      1: makeBet("Resolving", raw(FRZ3, 1, { signed: false }), { betId: 1 }),
      2: makeBet("Resolving", "garbage{", { betId: 2 }),
      3: makeBet("Resolving", raw(FRZ3, 3), { betId: 3, used: [1] }),
      4: makeBet("Resolving", raw(FRZ3, 4, { runNo: 2 }), { betId: 4 }),
      5: makeBet("Resolving", raw(FRZ3, 9), { betId: 5 }),
      6: makeBet("Resolving", raw(FRZ3, 6, { contractField: FRZ2 }), { betId: 6 }),
      7: makeBet("Proposed", raw(FRZ3, 7), { betId: 7 }),
      8: makeBet("Settled", raw(FRZ3, 8), { betId: 8 }),
    },
  });
  const { tick } = setup(chain);
  await tick();
  assert.equal(chain.submits().length, 0);
});

test("a failed submit is logged (status error), the tick survives, and the next tick retries and succeeds", async () => {
  const chain = new FakeEscrow({ [FRZ3]: { 1: makeBet("Resolving", raw(FRZ3, 1), { betId: 1 }), 2: makeBet("Resolving", raw(FRZ3, 2), { betId: 2 }) } });
  chain.failNext = 1;
  const { tick, logs } = setup(chain);
  await tick();
  const errs = logs().filter((l) => l.service === "keeper-outcome-relay" && l.status === "error");
  assert.equal(errs.length, 1);
  assert.match(errs[0].detail, /rpc timeout/);
  assert.equal(chain.submits().length, 2, "the other bet was still relayed in the same tick");
  assert.equal(Object.values(chain.bets[FRZ3]).filter((b: any) => b.status === "Proposed").length, 1);
  await tick();
  assert.equal(Object.values(chain.bets[FRZ3]).filter((b: any) => b.status === "Proposed").length, 2);
  assert.equal(chain.submits().length, 3);
});

test("a tampered result (signature does not verify) is rejected by the contract and logged as an error", async () => {
  const good = JSON.parse(raw(FRZ3, 1));
  good.result.outcome = "YES"; // signed NO
  const chain = new FakeEscrow({ [FRZ3]: { 1: makeBet("Resolving", JSON.stringify(good), { betId: 1 }) } });
  const { tick, logs } = setup(chain);
  await tick();
  assert.equal(chain.bets[FRZ3][1].status, "Resolving");
  assert.ok(logs().some((l) => l.service === "keeper-outcome-relay" && l.status === "error" && /bad signature/.test(l.detail)));
});

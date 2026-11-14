// RED-first (theme: desync). Notifier dedupe keys vs redeploy of the same contract account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNoticesMulti } from "../src/notifier.js";

const NS = 1_000_000_000;
const bet = (over: any): any => ({
  envelope: { maker: "maker1.testnet", terms_hash: "x", settlement_period: 10 * NS },
  status: "Settled", taker: "taker1.testnet", created_at: 1, proposed_at: 0, outcome: "YES", ...over,
});

test("redeploy at the same account (bet ids restart): the NEW bet #1's settle notice is not swallowed by the old #1's seen key", () => {
  const seen = new Set<string>();
  const old = computeNoticesMulti(new Map([["e.testnet", new Map([[1, bet({})]])]]), 1 * NS, seen);
  assert.equal(old.length, 1);
  const fresh = bet({ created_at: 777, taker: "newtaker.testnet", envelope: { maker: "newmaker.testnet", terms_hash: "y", settlement_period: 10 * NS } });
  const n = computeNoticesMulti(new Map([["e.testnet", new Map([[1, fresh]])]]), 2 * NS, seen);
  assert.equal(n.length, 1);
  assert.deepEqual(n[0].to_accounts.sort(), ["newmaker.testnet", "newtaker.testnet"]);
});

test("BLOCKED regression: same bet re-polled (no redeploy) is not re-notified; same id on two contracts is independent", () => {
  const seen = new Set<string>();
  const m = new Map([["a.testnet", new Map([[1, bet({})]])], ["b.testnet", new Map([[1, bet({})]])]]);
  assert.equal(computeNoticesMulti(m, 1 * NS, seen).length, 2);
  assert.equal(computeNoticesMulti(m, 2 * NS, seen).length, 0);
});

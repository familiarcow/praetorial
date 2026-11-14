// LIVE1 defect 2 (web): "Move NEAR to Escrow balance".
//  (a) near_deposit on wrap.testnet takes a 0.00125 NEAR storage fee on first use, so the ft_transfer_call must send
//      the ACTUAL wNEAR balance read after the deposit (tx 3WoNrAfT... sent the pre-fee amount and panicked
//      "The account doesn't have enough balance"); wNEAR already stranded in the wallet is swept along.
//  (b) success is the final tx outcome (receipt failures included), never just the relayer's HTTP 200.
//  (c) the relayer's error text is kept so the UI can show it under the friendly message.
import test from "node:test";
import assert from "node:assert/strict";
import { runMove, type MoveDeps } from "../lib/moveToBetting";
import { INTENTS_CONTRACT_ID } from "../lib/config";

const ME = "03c105e3c8dc8eccd940900a70fe34350a17fd72974289642e39c70e7168a5b5";
const FEE = 1_250_000_000_000_000_000_000n; // wrap.testnet storage on first deposit
const NEAR = 10n ** 24n;

function world(o: { wnear?: bigint; usdc?: bigint; relay?: (s: any, i: number) => { ok: boolean; txHash?: string; error?: string }; failTx?: Record<string, string> } = {}) {
  const st = { wnear: o.wnear ?? 0n, usdc: o.usdc ?? 0n, registered: (o.wnear ?? 0n) > 0n, steps: [] as any[] };
  const channels: string[] = [];
  const deps: MoveDeps = {
    // RELAYDEP1 / D-RELAYDEP1 (supersedes "the relayer sponsors near_deposit"): the user-signed channel does the deposit-bearing wrap.
    direct(step) { channels.push("direct"); return this.relay(step); },
    async relay(step) {
      if (step.methodName === "near_deposit" && !channels.length) throw new Error("near_deposit must never be relayed");
      const i = st.steps.length;
      st.steps.push(step);
      const forced = o.relay?.(step, i);
      if (forced && !forced.ok) return forced;
      if (step.methodName === "near_deposit") {
        const dep = BigInt(step.depositYocto);
        st.wnear += st.registered ? dep : dep - FEE;
        st.registered = true;
      } else if (step.methodName === "ft_transfer_call") {
        const bal = step.receiverId === "wrap.testnet" ? st.wnear : st.usdc;
        if (BigInt(step.args.amount as string) > bal) { (step as any).__overdrawn = true; return { ok: true, txHash: `tx${i}` }; }
        if (step.receiverId === "wrap.testnet") st.wnear -= BigInt(step.args.amount as string); else st.usdc -= BigInt(step.args.amount as string);
      }
      return forced ?? { ok: true, txHash: `tx${i}` };
    },
    async view(contract, method, args) {
      assert.equal(method, "ft_balance_of");
      assert.equal(args.account_id, ME);
      return String(contract === "wrap.testnet" ? st.wnear : contract === "usdc.testnet" ? st.usdc : 0n);
    },
    async txFailure(hash) {
      if (o.failTx?.[hash]) return o.failTx[hash];
      const i = Number(hash.slice(2));
      const s = st.steps[i];
      if (s?.methodName === "ft_transfer_call" && (s as any).__overdrawn) return "The account doesn't have enough balance";
      return null;
    },
    sleep: async () => {},
  };
  return { st, deps };
}

test("native NEAR: transfers the wNEAR balance read AFTER near_deposit (storage fee taken), not the pre-fee amount", async () => {
  const { st, deps } = world();
  const r = await runMove({ symbol: "NEAR", source: "native", amountUnits: (3n * NEAR).toString() }, ME, deps, "testnet");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(st.steps.map((s) => s.methodName), ["near_deposit", "ft_transfer_call"]);
  assert.equal(st.steps[1].args.amount, (3n * NEAR - FEE).toString());
  assert.equal(st.steps[1].args.receiver_id, INTENTS_CONTRACT_ID);
  assert.equal(st.wnear, 0n);
  assert.deepEqual(r.txHashes, ["tx0", "tx1"]);
});

test("native NEAR also sweeps wNEAR already stranded in the wallet", async () => {
  const { st, deps } = world({ wnear: 5n * NEAR - FEE });
  const r = await runMove({ symbol: "NEAR", source: "native", amountUnits: (2n * NEAR).toString() }, ME, deps, "testnet");
  assert.equal(r.ok, true);
  assert.equal(st.steps[1].args.amount, (7n * NEAR - FEE).toString());
});

test("token source moves the balance read now (fresh), not a stale displayed amount", async () => {
  const { st, deps } = world({ usdc: 9_000_000n });
  const r = await runMove({ symbol: "USDC", source: "token", amountUnits: "7000000" }, ME, deps, "testnet");
  assert.equal(r.ok, true);
  assert.equal(st.steps.length, 1);
  assert.equal(st.steps[0].args.amount, "9000000");
});

test("relayer HTTP 200 but the transaction failed on chain (receipt failure) is a FAILURE with the chain's reason", async () => {
  const { deps } = world();
  const r = await runMove({ symbol: "NEAR", source: "native", amountUnits: NEAR.toString() }, ME, deps, "testnet");
  assert.equal(r.ok, true);
  const w2 = world({ failTx: { tx1: "Smart contract panicked: The account doesn't have enough balance" } });
  const r2 = await runMove({ symbol: "NEAR", source: "native", amountUnits: NEAR.toString() }, ME, w2.deps, "testnet");
  assert.equal(r2.ok, false);
  assert.match(String(r2.detail), /enough balance/);
});

test("relayer refusal keeps the relayer's error text for the UI and stops before the next step", async () => {
  const { st, deps } = world({ relay: () => ({ ok: false, error: "replay detected: (x, y, nonce=1) already relayed" }) });
  const r = await runMove({ symbol: "NEAR", source: "native", amountUnits: NEAR.toString() }, ME, deps, "testnet");
  assert.equal(r.ok, false);
  assert.match(String(r.detail), /replay detected/);
  assert.equal(st.steps.length, 1);
});

test("nothing to move after the deposit (balance read 0) is reported, no zero transfer is relayed", async () => {
  const { st, deps } = world();
  deps.view = async () => "0";
  const r = await runMove({ symbol: "USDC", source: "token", amountUnits: "7000000" }, ME, deps, "testnet");
  assert.equal(r.ok, false);
  assert.equal(st.steps.length, 0);
});

test("RELAYDEP1 / D-RELAYDEP1: the near_deposit step carries the user's NEAR, so it is user-signed, never relayed", async () => {
  const { needsUserSignedTx } = await import("../lib/directTx");
  const { buildMoveSteps } = await import("../lib/moveToBetting");
  const steps = buildMoveSteps({ symbol: "NEAR", account: ME, amountUnits: (3n * NEAR).toString(), source: "native", network: "testnet" });
  assert.equal(needsUserSignedTx(steps[0].methodName, BigInt(steps[0].depositYocto)), true);
});

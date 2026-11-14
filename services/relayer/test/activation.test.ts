// FUND2 RED: a user funded only through a deposit address holds a betting balance on intents.near under their implicit id, but
// that NEAR account does not exist on chain (0 NEAR, no access key), so no meta-transaction (open/take/withdraw) can be signed
// for it: the relayer answered 500 and the web showed "couldn't be sent" forever (live probe 2026-11-10, spikes/fund2/NOTES.md).
// Fix: the relayer creates the implicit account with a tiny NEAR transfer, ONLY for a 64-hex implicit id that does not exist yet
// and already holds a nonzero balance of a stakeable asset, charged to the user's daily budget and the global cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { activateImplicitAccount, DEFAULT_ACTIVATION_YOCTO, type ActivationPorts } from "../src/activation.js";
import { GuardStoreCore, type SqlDriver } from "../src/guardStoreCore.js";
import { PolicyViolation } from "../src/policy.js";

const ID = "12c24877c6fa5fb58eea8400bde5f9d7b0f74787536c34f619ba840b081b21ab";
const USDC = "nep141:usdc.testnet", WNEAR = "nep141:wrap.testnet";
const cfg = { escrowContract: "escrow.testnet", intentsContract: "intents.testnet", usdcTokenId: USDC, stakeAssetIds: [USDC, WNEAR],
  perCallSponsorshipYocto: 5_000_000_000_000_000_000_000n, maxRequestsPerWindow: 20, windowMs: 60_000, dailyBudgetYocto: 100_000_000_000_000_000_000_000n };

function sqlDriver(): SqlDriver {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (q: string) => db.exec(q),
    run: (q: string, ...b: any[]) => ({ lastInsertRowid: Number(db.prepare(q).run(...b).lastInsertRowid) }),
    get: (q: string, ...b: any[]) => db.prepare(q).get(...b) as any,
    transaction: <T>(fn: () => T): T => { db.exec("BEGIN IMMEDIATE;"); try { const r = fn(); db.exec("COMMIT;"); return r; } catch (e) { db.exec("ROLLBACK;"); throw e; } },
  };
}
function world(o: { exists?: boolean; balances?: Record<string, bigint>; transferFails?: "not-executed" | "executed" } = {}) {
  const sent: { to: string; yocto: bigint }[] = [];
  const ports: ActivationPorts = {
    accountExists: async () => !!o.exists,
    intentsBalance: async (_id, token) => o.balances?.[token] ?? 0n,
    minStake: async () => 1n, // SEC1/MON-9: the min-stake gate itself is covered in sec1Drain.test.ts
    transfer: async (to, yocto) => {
      if (o.transferFails === "not-executed") throw new Error("rpc timeout");
      if (o.transferFails === "executed") throw Object.assign(new Error("transaction failed"), { transaction_outcome: {} });
      sent.push({ to, yocto }); return { transactionHash: "ACTTX", actualCostYocto: 400_000_000_000_000_000_000n, raw: {} };
    },
  };
  const guards = new GuardStoreCore(sqlDriver(), cfg as any);
  return { sent, ports, guards };
}

test("unfunded implicit id with a USDC betting balance: the relayer creates the account with the activation transfer", async () => {
  const w = world({ balances: { [USDC]: 20_000_000n } });
  const r = await activateImplicitAccount({ accountId: ID, cfg, activationYocto: DEFAULT_ACTIVATION_YOCTO, ports: w.ports, guards: w.guards });
  assert.deepEqual(r, { activated: true, txHash: "ACTTX" });
  assert.deepEqual(w.sent, [{ to: ID, yocto: DEFAULT_ACTIVATION_YOCTO }]);
  // Above the 182-byte implicit-account storage (0.00182 NEAR) with headroom for 1-yocto stake deposits; tiny.
  assert.ok(DEFAULT_ACTIVATION_YOCTO >= 1_820_000_000_000_000_000_000n && DEFAULT_ACTIVATION_YOCTO <= 5_000_000_000_000_000_000_000n);
  // Charged: the transfer + its gas count against the user's daily budget and the global cap.
  assert.ok(w.guards.globalBudgetStatus().usedYocto >= DEFAULT_ACTIVATION_YOCTO);
});

test("a wNEAR-only betting balance also qualifies", async () => {
  const w = world({ balances: { [WNEAR]: 1n } });
  assert.equal((await activateImplicitAccount({ accountId: ID, cfg, activationYocto: DEFAULT_ACTIVATION_YOCTO, ports: w.ports, guards: w.guards })).activated, true);
});

test("account already on chain: nothing sent, answered as done (idempotent)", async () => {
  const w = world({ exists: true, balances: { [USDC]: 20_000_000n } });
  assert.deepEqual(await activateImplicitAccount({ accountId: ID, cfg, activationYocto: DEFAULT_ACTIVATION_YOCTO, ports: w.ports, guards: w.guards }), { activated: false, txHash: null });
  assert.equal(w.sent.length, 0);
});

test("no betting balance: refused with a plain reason, nothing sent (sign-ups are not funded)", async () => {
  const w = world();
  await assert.rejects(activateImplicitAccount({ accountId: ID, cfg, activationYocto: DEFAULT_ACTIVATION_YOCTO, ports: w.ports, guards: w.guards }),
    (e: any) => e instanceof PolicyViolation && /betting balance/.test(e.message));
  assert.equal(w.sent.length, 0);
});

test("named (non-implicit) accounts and junk ids are refused", async () => {
  for (const id of ["alice.near", ID.toUpperCase(), ID.slice(1), ""]) {
    const w = world({ balances: { [USDC]: 1n } });
    await assert.rejects(activateImplicitAccount({ accountId: id, cfg, activationYocto: DEFAULT_ACTIVATION_YOCTO, ports: w.ports, guards: w.guards }), PolicyViolation);
    assert.equal(w.sent.length, 0);
  }
});

test("activation switched off (0 yocto): refused", async () => {
  const w = world({ balances: { [USDC]: 1n } });
  await assert.rejects(activateImplicitAccount({ accountId: ID, cfg, activationYocto: 0n, ports: w.ports, guards: w.guards }), (e: any) => e instanceof PolicyViolation && /off/.test(e.message));
});

test("a transfer that never executed releases the budget hold; one that executed is charged", async () => {
  const a = world({ balances: { [USDC]: 1n }, transferFails: "not-executed" });
  await assert.rejects(activateImplicitAccount({ accountId: ID, cfg, activationYocto: DEFAULT_ACTIVATION_YOCTO, ports: a.ports, guards: a.guards }));
  assert.equal(a.guards.globalBudgetStatus().usedYocto, 0n);
  const b = world({ balances: { [USDC]: 1n }, transferFails: "executed" });
  await assert.rejects(activateImplicitAccount({ accountId: ID, cfg, activationYocto: DEFAULT_ACTIVATION_YOCTO, ports: b.ports, guards: b.guards }));
  assert.ok(b.guards.globalBudgetStatus().usedYocto > 0n);
});

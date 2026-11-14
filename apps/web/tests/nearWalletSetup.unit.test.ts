// WALLET1 (a): first Privy login sat on "Setting up your wallet…" until a refresh.
// Root cause: Privy react-auth 3.x extended-chains createWallet resolves to { user, wallet },
// but App.tsx read `w.address` (undefined), so nearAddress stayed empty.
import test from "node:test";
import assert from "node:assert/strict";
import { findNearWallet, ensureNearWallet, WalletSetupTimeoutError, NearWalletSetup } from "../lib/nearWalletSetup";

const ADDR = "a".repeat(64);
const userWith = (addr?: string) => ({
  id: "did:privy:u1",
  linkedAccounts: addr ? [{ type: "email", address: "x@y.z" }, { type: "wallet", chainType: "near", address: addr }] : [{ type: "email", address: "x@y.z" }],
});

test("findNearWallet picks the NEAR wallet out of linkedAccounts", () => {
  assert.equal(findNearWallet(userWith(ADDR)), ADDR);
  assert.equal(findNearWallet(userWith()), null);
  assert.equal(findNearWallet(null), null);
  assert.equal(findNearWallet({ linkedAccounts: [{ type: "wallet", chainType: "ethereum", address: "0xabc" }] }), null);
});

test("Privy 3.x shape: createWallet resolves { user, wallet } -> address from wallet.address", async () => {
  const addr = await ensureNearWallet({
    user: userWith(),
    createWallet: async () => ({ user: userWith(ADDR), wallet: { address: ADDR, chain_type: "near" } }),
    refreshUser: async () => { throw new Error("should not be needed"); },
  });
  assert.equal(addr, ADDR);
});

test("an already-created NEAR wallet is picked up without calling createWallet", async () => {
  let calls = 0;
  const addr = await ensureNearWallet({ user: userWith(ADDR), createWallet: async () => { calls++; return {}; }, refreshUser: async () => userWith(ADDR) });
  assert.equal(addr, ADDR);
  assert.equal(calls, 0);
});

test("createWallet output without an address -> refreshUser and read the wallet from the fresh user", async () => {
  let refreshed = 0;
  const addr = await ensureNearWallet({
    user: userWith(),
    createWallet: async () => ({}),
    refreshUser: async () => { refreshed++; return userWith(ADDR); },
  });
  assert.equal(addr, ADDR);
  assert.equal(refreshed, 1);
});

test("createWallet fails because the wallet already exists (stale user) -> refreshUser picks it up", async () => {
  const addr = await ensureNearWallet({
    user: userWith(),
    createWallet: async () => { throw new Error("User already has an embedded wallet for chain near"); },
    refreshUser: async () => userWith(ADDR),
  });
  assert.equal(addr, ADDR);
});

test("createWallet fails and no wallet after refresh -> the original error surfaces", async () => {
  await assert.rejects(
    ensureNearWallet({ user: userWith(), createWallet: async () => { throw new Error("boom"); }, refreshUser: async () => userWith() }),
    /boom/,
  );
});

test("createWallet never settles -> times out with WalletSetupTimeoutError", async () => {
  const t0 = Date.now();
  await assert.rejects(
    ensureNearWallet({ user: userWith(), createWallet: () => new Promise(() => {}), refreshUser: async () => userWith(), timeoutMs: 50 }),
    (e: unknown) => e instanceof WalletSetupTimeoutError,
  );
  assert.ok(Date.now() - t0 < 2000);
});

test("default timeout is about 20 s", () => {
  assert.equal(NearWalletSetup.DEFAULT_TIMEOUT_MS, 20_000);
});

test("NearWalletSetup: re-firing for the same user shares one in-flight createWallet", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const deps = {
    createWallet: async () => { calls++; await gate; return { user: userWith(ADDR), wallet: { address: ADDR } }; },
    refreshUser: async () => userWith(ADDR),
  };
  const setup = new NearWalletSetup();
  const p1 = setup.run({ ...deps, user: userWith() });
  const p2 = setup.run({ ...deps, user: { ...userWith() } }); // new object, same user id (React re-render)
  release();
  assert.equal(await p1, ADDR);
  assert.equal(await p2, ADDR);
  assert.equal(calls, 1);
});

test("NearWalletSetup: after a failure, a retry starts a fresh attempt", async () => {
  let calls = 0;
  const setup = new NearWalletSetup();
  const deps = {
    user: userWith(),
    createWallet: async () => { calls++; if (calls === 1) throw new Error("boom"); return { wallet: { address: ADDR } }; },
    refreshUser: async () => userWith(),
  };
  await assert.rejects(setup.run(deps), /boom/);
  assert.equal(await setup.run(deps), ADDR);
  assert.equal(calls, 2);
});

test("App.tsx wires the helper and no longer reads the address straight off createWallet's result", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(src, /NearWalletSetup/);
  assert.match(src, /refreshUser/);
  assert.doesNotMatch(src, /\.then\(\(w: any\) => \{\s*setNearAddress\(w\.address\)/);
});

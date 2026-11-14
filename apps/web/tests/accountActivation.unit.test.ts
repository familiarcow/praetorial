// FUND2 RED: a deposit-only user (betting balance on intents, implicit NEAR account never created) could not open, take or
// withdraw: reading the access-key nonce threw "Cannot convert undefined to a BigInt" and the UI said "couldn't be sent" on every
// retry. The relay path now asks the relayer to activate the account (POST /activate), waits for the key, then signs as usual.
import test from "node:test";
import assert from "node:assert/strict";
import { nonceOrActivate, parseAccessKeyNonce, ActivationError } from "../lib/accountActivation";

const noSleep = async () => {};

test("parseAccessKeyNonce: nonce, or null for the RPC's missing-account/key answers (both shapes)", () => {
  assert.equal(parseAccessKeyNonce({ nonce: 276997469000000, permission: "FullAccess" }), 276997469000000n);
  assert.equal(parseAccessKeyNonce({ error: "access key ed25519:Few9 does not exist while viewing", block_height: 1 }), null);
  assert.equal(parseAccessKeyNonce(new Error('{"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCOUNT"}}')), null);
  assert.equal(parseAccessKeyNonce(new Error('{"cause":{"name":"UNKNOWN_ACCESS_KEY"}}')), null);
  assert.throws(() => parseAccessKeyNonce(new Error("rate limited")), /rate limited/);
});

test("account exists: the nonce is returned, the relayer is never asked to activate", async () => {
  let asked = 0;
  const n = await nonceOrActivate({ read: async () => 7n, activate: async () => { asked++; return { ok: true }; }, sleep: noSleep });
  assert.equal(n, 7n); assert.equal(asked, 0);
});

test("missing account: activate once, then poll until the key shows up", async () => {
  const reads: (bigint | null)[] = [null, null, null, 277000000000000n];
  let asked = 0;
  const n = await nonceOrActivate({ read: async () => reads.shift() ?? null, activate: async () => { asked++; return { ok: true }; }, sleep: noSleep });
  assert.equal(n, 277000000000000n); assert.equal(asked, 1);
});

test("relayer refuses (no betting balance): a plain error that carries the relayer's reason", async () => {
  await assert.rejects(nonceOrActivate({ read: async () => null, activate: async () => ({ ok: false, error: "this account has no betting balance yet; add money first, then try again" }), sleep: noSleep }),
    (e: any) => e instanceof ActivationError && /set up your account/i.test(e.message) && /no betting balance/.test(e.detail));
});

test("activated but the key never appears within the wait: a plain error, not a BigInt crash", async () => {
  await assert.rejects(nonceOrActivate({ read: async () => null, activate: async () => ({ ok: true }), sleep: noSleep, attempts: 3 }), ActivationError);
});

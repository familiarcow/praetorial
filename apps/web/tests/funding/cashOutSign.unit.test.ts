// F5 (FUND4 SPEC §5.2, familiarcow UX-37 FUND 14): Cash out / Convert are signed by the USER through the conversion service's
// generate/submit-intent (NEP-413, the Privy key), never by our relayer. The browser re-checks the payload the Worker hands out
// (exactly one transfer of amountIn of the origin token to the quote's deposit address, signed by this account, deadline no later
// than the quote) and recomputes the hash before asking for a signature. We never sign a payload we haven't parsed.
import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { signAndSubmit, signedDataFor, base58Encode } from "../../lib/cashOutSign";
import { hashNep413Payload } from "../../lib/funding/intentCheck";
import { FundingError } from "../../lib/funding/fundingClient";
import { withdrawRecord, ID } from "./fixtures";
import type { SwapRecord } from "../../lib/funding/types";

const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
const ACCOUNT = Buffer.from(kp.publicKey).toString("hex");
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const NOW = Date.parse("2026-11-11T11:40:00.000Z");
const rec = (o: Partial<SwapRecord> = {}) => withdrawRecord({ account: ACCOUNT, ...o }); // deadline 12:09:40, 20 USDC

function payload(o: { amount?: string; token?: string; receiver?: string; signer?: string; deadline?: string; extra?: unknown[] } = {}) {
  const r = rec();
  const message = JSON.stringify({
    signer_id: o.signer ?? ACCOUNT, deadline: o.deadline ?? "2026-11-11T12:09:00.000Z",
    intents: [{ intent: "transfer", receiver_id: o.receiver ?? r.depositAddress, tokens: { [o.token ?? ID.USDC]: o.amount ?? r.amountIn } }, ...(o.extra ?? [])],
  });
  return { message, nonce: Buffer.alloc(32, 4).toString("base64"), recipient: "intents.near" };
}

function deps(p = payload(), o: { hash?: string; intentErr?: unknown; submitErr?: unknown; refuse?: boolean } = {}) {
  const calls = { intent: 0, sign: [] as string[], submit: [] as any[] };
  return {
    calls,
    d: {
      now: () => NOW,
      client: {
        async withdrawIntent(account: string, depositAddress: string) {
          calls.intent++;
          assert.equal(account, ACCOUNT); assert.equal(depositAddress, rec().depositAddress);
          if (o.intentErr) throw o.intentErr;
          return { intent: { standard: "nep413", payload: p }, hash: o.hash ?? hex(hashNep413Payload(p)) };
        },
        async withdrawSubmit(depositAddress: string, signedData: unknown) {
          calls.submit.push({ depositAddress, signedData });
          if (o.submitErr) throw o.submitErr;
          return { intentHash: "IntentHash1" };
        },
      },
      async signRawHash(address: string, hashHex: string) {
        assert.equal(address, ACCOUNT);
        calls.sign.push(hashHex);
        if (o.refuse) throw new Error("User rejected the request");
        return "0x" + hex(nacl.sign.detached(Buffer.from(hashHex, "hex"), kp.secretKey));
      },
    },
  };
}

test("happy path: checks the payload, signs OUR recomputed NEP-413 hash with the user's key, submits a signature that verifies", async () => {
  const p = payload();
  const { d, calls } = deps(p);
  const r = await signAndSubmit(rec(), d);
  assert.deepEqual(r, { kind: "submitted", intentHash: "IntentHash1" });
  assert.deepEqual(calls.sign, [hex(hashNep413Payload(p))]);
  assert.equal(calls.submit.length, 1);
  const s = calls.submit[0].signedData;
  assert.deepEqual(Object.keys(s).sort(), ["payload", "public_key", "signature", "standard"]);
  assert.equal(s.standard, "nep413");
  assert.deepEqual(s.payload, p);
  assert.equal(s.public_key, `ed25519:${bs58.encode(kp.publicKey)}`);
  const sig = bs58.decode(s.signature.replace(/^ed25519:/, ""));
  assert.equal(nacl.sign.detached.verify(hashNep413Payload(s.payload), sig, kp.publicKey), true);
});

test("a payload that doesn't match the quote is never signed (other amount, token, receiver, signer, later deadline, extra intent)", async () => {
  const bad = {
    amount: payload({ amount: "20000001" }),
    token: payload({ token: ID.USDT }),
    receiver: payload({ receiver: "evil.near" }),
    signer: payload({ signer: "b".repeat(64) }),
    deadline: payload({ deadline: "2026-11-11T12:30:00.000Z" }),
    extra: payload({ extra: [{ intent: "transfer", receiver_id: "evil.near", tokens: { [ID.USDC]: "1" } }] }),
  };
  for (const [name, p] of Object.entries(bad)) {
    const { d, calls } = deps(p);
    const r = await signAndSubmit(rec(), d);
    assert.equal(r.kind, "mismatch", name);
    assert.deepEqual(calls.sign, [], `${name}: no signature requested`);
    assert.equal(calls.submit.length, 0, `${name}: nothing submitted`);
  }
});

test("a hash that doesn't match the payload is never signed", async () => {
  const { d, calls } = deps(payload(), { hash: "00".repeat(32) });
  const r = await signAndSubmit(rec(), d);
  assert.equal(r.kind, "mismatch");
  assert.deepEqual(calls.sign, []);
  assert.equal(calls.submit.length, 0);
});

test("the user cancels in the wallet: nothing is submitted", async () => {
  const { d, calls } = deps(payload(), { refuse: true });
  assert.deepEqual(await signAndSubmit(rec(), d), { kind: "cancelled" });
  assert.equal(calls.sign.length, 1);
  assert.equal(calls.submit.length, 0);
});

test("the quote has expired: no request, no signature", async () => {
  const { d, calls } = deps();
  const r = await signAndSubmit(rec({ deadline: "2026-11-11T11:39:00.000Z" }), d);
  assert.equal(r.kind, "expired");
  assert.equal(calls.intent, 0);
  assert.deepEqual(calls.sign, []);
});

test("already signed: never signs twice", async () => {
  const { d, calls } = deps();
  const r = await signAndSubmit(rec({ signed: true }), d);
  assert.equal(r.kind, "already");
  assert.equal(calls.intent, 0);
});

test("not an implicit account (no key to sign with): refused before any request", async () => {
  const { d, calls } = deps();
  const r = await signAndSubmit(rec({ account: "alice.near" }), { ...d, client: { ...d.client, withdrawIntent: async () => { calls.intent++; throw new Error("x"); } } });
  assert.equal(r.kind, "refused");
  assert.equal(calls.intent, 0);
});

test("the Worker can't give us the transfer to sign: nothing signed (refused, with the error kept)", async () => {
  const e = new FundingError("upstream_down", "down");
  const { d, calls } = deps(payload(), { intentErr: e });
  const r = await signAndSubmit(rec(), d);
  assert.deepEqual(r, { kind: "refused", error: e });
  assert.deepEqual(calls.sign, []);
});

test("submit refused outright (400): nothing was sent; submit lost on the way (network / 5xx): unknown = checking, never failed", async () => {
  const refused = await signAndSubmit(rec(), deps(payload(), { submitErr: new FundingError("bad_request", "bad signature") }).d);
  assert.equal(refused.kind, "refused");
  for (const code of ["network", "upstream_down", "rate_limited"] as const) {
    const r = await signAndSubmit(rec(), deps(payload(), { submitErr: new FundingError(code, "x") }).d);
    assert.equal(r.kind, "unknown", code);
  }
  assert.equal((await signAndSubmit(rec(), deps(payload(), { submitErr: new TypeError("boom") }).d)).kind, "unknown");
});

test("signedDataFor / base58Encode: ed25519:<base58> for the implicit account's key and the 64-byte signature (hex with or without 0x)", () => {
  const p = payload();
  const sigHex = hex(nacl.sign.detached(hashNep413Payload(p), kp.secretKey));
  const a = signedDataFor(p, ACCOUNT, sigHex), b = signedDataFor(p, ACCOUNT, `0x${sigHex}`);
  assert.deepEqual(a, b);
  assert.equal(a.public_key, `ed25519:${bs58.encode(kp.publicKey)}`);
  assert.equal(a.signature, `ed25519:${bs58.encode(Buffer.from(sigHex, "hex"))}`);
  assert.equal(base58Encode(new Uint8Array([0, 0, 1])), bs58.encode(new Uint8Array([0, 0, 1])));
  assert.equal(base58Encode(new Uint8Array([])), "");
  assert.throws(() => signedDataFor(p, ACCOUNT, "ab"), /64/);
});

test("SECREV1 SR-1: a cash out this browser did not create (server-only record) is never signed: no intent asked, no signature", async () => {
  const { d, calls } = deps(payload());
  const r = await signAndSubmit(rec({ createdHere: false }), d);
  assert.equal(r.kind, "refused");
  assert.equal(calls.intent, 0);
  assert.deepEqual(calls.sign, []);
  const missing = rec(); delete (missing as any).createdHere; // records saved by an older build
  assert.equal((await signAndSubmit(missing, d)).kind, "refused");
  assert.deepEqual(calls.sign, []);
});

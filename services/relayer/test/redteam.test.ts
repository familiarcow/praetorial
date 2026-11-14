// Red-team run 2026-11-07, theme "relayer abuse". Tests prefixed "BLOCKED:"
// are regressions proving an attack is already stopped; tests prefixed
// "BREAK:" demonstrated a real hole when first committed (RED) and were
// then fixed test-first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as borsh from "borsh";
import { KeyPair } from "near-api-js";
import { SCHEMA, actionCreators, buildDelegateAction, encodeDelegateAction, Signature } from "@near-js/transactions";
import { Relayer, BadSignedDelegate, PolicyViolation, GuardViolation, type ChainPort, type RelayerConfig } from "../src/relayer.js";
import { decodeSignedDelegate } from "../src/delegate.js";
import { GuardStore } from "../src/guardStore.js";
import { createRelayHandler } from "../src/http.js";

const ESCROW = "escrow3.praetorial-dev-1101.testnet";
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const USDC = "usdc.fakes.testnet";
const EST = 5_000_000_000_000_000_000_000n;

function cfgOf(o: Partial<RelayerConfig> = {}): RelayerConfig {
  return {
    escrowContract: ESCROW,
    intentsContract: INTENTS,
    usdcTokenId: USDC,
    maxTransferAmount: 1_000_000_000n,
    maxBlockHeightFuture: 1200n,
    perCallSponsorshipYocto: EST,
    maxRequestsPerWindow: 1000,
    windowMs: 60_000,
    dailyBudgetYocto: EST * 20n,
    ...o,
  };
}

function chainOf(opts: { delayMs?: number; cost?: bigint } = {}): ChainPort & { calls: number } {
  const port: any = {
    calls: 0,
    async currentBlockHeight() {
      return 4000n;
    },
    async broadcastSignedDelegate() {
      port.calls += 1;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { transactionHash: "H" + port.calls, actualCostYocto: opts.cost ?? 3_000_000_000_000_000_000_000n, raw: {} };
    },
  };
  return port;
}

interface Opts {
  senderId?: string;
  receiverId?: string;
  methodName?: string;
  args?: Record<string, unknown>;
  nonce?: bigint;
  actions?: any[];
  deposit?: bigint;
  keyPair?: KeyPair;
}
function build(o: Opts = {}) {
  const kp = o.keyPair ?? KeyPair.fromRandom("ed25519");
  const da = buildDelegateAction({
    senderId: o.senderId ?? "victim.testnet",
    receiverId: o.receiverId ?? ESCROW,
    actions: o.actions ?? [actionCreators.functionCall(o.methodName ?? "cancel", o.args ?? { bet_id: 1 }, 30_000_000_000_000n, o.deposit ?? 0n)],
    nonce: o.nonce ?? 1n,
    maxBlockHeight: 5000n,
    publicKey: kp.getPublicKey() as any,
  });
  const hash = createHash("sha256").update(Buffer.from(encodeDelegateAction(da))).digest();
  const signature = new Signature({ keyType: 0, data: kp.sign(hash).signature });
  const bytes = Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, { delegateAction: da, signature }));
  return { bytes, base64: bytes.toString("base64"), kp };
}

// ---------------------------------------------------------------- (2) policy bypass

test("BLOCKED: method-name tricks (case, whitespace, NUL, unicode homoglyph) never match the escrow allowlist", async () => {
  // Proves: policy uses exact Set membership on the raw method string, so none of these variants are normalised into an allowed name.
  for (const m of ["Cancel", "cancel ", " cancel", "cancel\u0000", "cancel\n", "c\u0430ncel", "CANCEL", "cancel\u200b"]) {
    const chain = chainOf();
    await assert.rejects(() => new Relayer(chain, cfgOf()).relay(build({ methodName: m }).base64), PolicyViolation, JSON.stringify(m));
    assert.equal(chain.calls, 0);
  }
});

test("BLOCKED: receiver-id look-alikes of the escrow (case, trailing dot, subaccount, prefix) are rejected", async () => {
  // Proves: receiver match is exact-string, no suffix/prefix/case folding.
  for (const r of [ESCROW.toUpperCase(), ESCROW + ".", "x." + ESCROW, ESCROW.slice(0, -1), " " + ESCROW, "attacker.testnet"]) {
    const chain = chainOf();
    await assert.rejects(() => new Relayer(chain, cfgOf()).relay(build({ receiverId: r }).base64), PolicyViolation, r);
    assert.equal(chain.calls, 0);
  }
});

test("BLOCKED: an allowed call bundled with Transfer/AddKey/DeleteAccount/Deploy/Stake/second call is rejected", async () => {
  // Proves: delegate must have exactly ONE action and it must be FunctionCall; no value/key-custody action can ride along.
  const fc = () => actionCreators.functionCall("cancel", { bet_id: 1 }, 30_000_000_000_000n, 0n);
  const kp = KeyPair.fromRandom("ed25519").getPublicKey() as any;
  const variants: any[][] = [
    [fc(), actionCreators.transfer(1_000_000_000_000_000_000_000_000n)],
    [actionCreators.transfer(1n), fc()],
    [fc(), actionCreators.addKey(kp, actionCreators.fullAccessKey())],
    [fc(), actionCreators.deleteAccount("attacker.testnet")],
    [fc(), actionCreators.deployContract(new Uint8Array([0, 97, 115, 109]))],
    [fc(), actionCreators.stake(1n, kp)],
    [fc(), fc()],
    [actionCreators.transfer(1n)],
    [actionCreators.addKey(kp, actionCreators.fullAccessKey())],
    [],
  ];
  for (const actions of variants) {
    const chain = chainOf();
    await assert.rejects(() => new Relayer(chain, cfgOf()).relay(build({ actions }).base64), PolicyViolation);
    assert.equal(chain.calls, 0);
  }
});

test("BLOCKED: a huge (5000) action list is rejected without broadcast", async () => {
  // Proves: bounded work on a big list; length != 1 rejected.
  const fc = actionCreators.functionCall("cancel", { bet_id: 1 }, 1n, 0n);
  const chain = chainOf();
  await assert.rejects(() => new Relayer(chain, cfgOf()).relay(build({ actions: Array(5000).fill(fc) }).base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

test("BLOCKED: nested delegate (action variant 8 = SignedDelegate) cannot even be decoded", async () => {
  // Proves: the relayer's decoder only knows the 8 base action kinds, so a delegate-in-delegate is BadSignedDelegate, never forwarded.
  const { bytes } = build();
  const off = bytes.indexOf(Buffer.from([1, 0, 0, 0, 2])) + 4; // action variant byte of the sole FunctionCall
  const evil = Buffer.from(bytes);
  evil[off] = 8;
  const chain = chainOf();
  await assert.rejects(() => new Relayer(chain, cfgOf()).relay(evil.toString("base64")), BadSignedDelegate);
  assert.equal(chain.calls, 0);
});

test("BLOCKED: tampering a signed delegate after signing (swap receiver / method) fails signature verification", async () => {
  // Proves: signature covers the whole action, relayer re-verifies before spending.
  const b = build();
  const dec = decodeSignedDelegate(b.base64);
  const tampered = { ...dec.delegateAction, receiverId: INTENTS };
  const bytes = Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, {
    delegateAction: tampered,
    signature: new Signature({ keyType: 0, data: dec.signatureBytes }),
  }));
  const chain = chainOf();
  await assert.rejects(() => new Relayer(chain, cfgOf()).relay(bytes.toString("base64")), BadSignedDelegate);
  assert.equal(chain.calls, 0);
});

// ---------------------------------------------------------------- (3) malformed payloads

test("BLOCKED: secp256k1 public key / signature types are rejected as BadSignedDelegate", async () => {
  // Proves: non-ed25519 key types never reach nacl or the broadcast path.
  const sk = KeyPair.fromRandom("secp256k1");
  const da = buildDelegateAction({
    senderId: "victim.testnet", receiverId: ESCROW, nonce: 1n, maxBlockHeight: 5000n,
    actions: [actionCreators.functionCall("cancel", { bet_id: 1 }, 1n, 0n)],
    publicKey: sk.getPublicKey() as any,
  });
  const hash = createHash("sha256").update(Buffer.from(encodeDelegateAction(da))).digest();
  const bytes = Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, {
    delegateAction: da, signature: new Signature({ keyType: 1, data: sk.sign(hash).signature }),
  }));
  const chain = chainOf();
  await assert.rejects(() => new Relayer(chain, cfgOf()).relay(bytes.toString("base64")), BadSignedDelegate);
  assert.equal(chain.calls, 0);
});

test("BLOCKED: every truncation and many random byte-mutations only ever yield BadSignedDelegate (no crash/other error/hang)", async () => {
  // Proves: decode failure is always normalised; mutated-but-decodable payloads die at signature verification.
  const { bytes } = build();
  const t0 = Date.now();
  const relayer = new Relayer(chainOf(), cfgOf());
  for (let n = 0; n < bytes.length; n++) {
    await assert.rejects(() => relayer.relay(bytes.subarray(0, n).toString("base64")), BadSignedDelegate, `truncated to ${n}`);
  }
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 400; i++) {
    const m = Buffer.from(bytes);
    for (let k = 0; k < 1 + (rnd() % 4); k++) m[rnd() % m.length] = rnd() & 0xff;
    if (m.equals(bytes)) continue; // no-op mutation
    try {
      await relayer.relay(m.toString("base64"));
      assert.fail("mutated payload was relayed");
    } catch (e) {
      assert.ok(e instanceof BadSignedDelegate || e instanceof PolicyViolation, `unexpected ${String(e)}`);
    }
  }
  assert.ok(Date.now() - t0 < 20_000, "decode fuzz too slow");
});

test("BLOCKED: gigantic action-count / vec-length prefixes on a tiny payload fail fast", async () => {
  // Proves: a 4-billion-element length prefix does not allocate or hang.
  const { bytes } = build();
  const dec = decodeSignedDelegate(bytes.toString("base64"));
  const actionsLenOffset = bytes.indexOf(Buffer.from([1, 0, 0, 0, 2])); // Vec<Action> len=1 then FunctionCall variant (2)
  assert.ok(actionsLenOffset > 0, "could not locate actions length");
  assert.ok(dec);
  const evil = Buffer.from(bytes);
  evil.writeUInt32LE(0xffffffff, actionsLenOffset);
  const t0 = Date.now();
  await assert.rejects(() => new Relayer(chainOf(), cfgOf()).relay(evil.toString("base64")), BadSignedDelegate);
  assert.ok(Date.now() - t0 < 2000);
});

test("BREAK: trailing bytes after a valid SignedDelegate are rejected (non-canonical payload)", async () => {
  // Was: borsh 1.0 deserialize ignores unread bytes, so garbage/second payload appended after a valid delegate was accepted.
  const { base64 } = build();
  const padded = Buffer.concat([Buffer.from(base64, "base64"), Buffer.from("deadbeef", "hex")]).toString("base64");
  const chain = chainOf();
  await assert.rejects(() => new Relayer(chain, cfgOf()).relay(padded), BadSignedDelegate);
  assert.equal(chain.calls, 0);
});

test("BREAK: non-canonical base64 (junk characters / embedded whitespace) is rejected, not silently skipped", async () => {
  // Was: Buffer.from(x,'base64') drops invalid characters, so the same delegate had many string spellings.
  const { base64 } = build();
  const chain = chainOf();
  const relayer = new Relayer(chain, cfgOf());
  await assert.rejects(() => relayer.relay("!!" + base64.slice(0, 10) + "@@" + base64.slice(10)), BadSignedDelegate);
  assert.equal(chain.calls, 0);
});

// ---------------------------------------------------------------- (1)/(4) budget, replay, races

test("BLOCKED: same signed delegate submitted concurrently twice -> exactly one broadcast", async () => {
  // Proves: replay mark happens before the (slow) broadcast, not after.
  const chain = chainOf({ delayMs: 30 });
  const relayer = new Relayer(chain, cfgOf());
  const { base64 } = build();
  const r = await Promise.allSettled([relayer.relay(base64), relayer.relay(base64), relayer.relay(base64)]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(chain.calls, 1);
});

test("BLOCKED: two relayer instances sharing one guard DB file never both pay for the same nonce", async () => {
  // Proves: replay state is in shared SQLite, so a horizontally-scaled/duplicated relayer cannot double-spend gas on one delegate.
  const db = join(mkdtempSync(join(tmpdir(), "rt-")), "g.sqlite3");
  const c1 = chainOf({ delayMs: 20 }), c2 = chainOf({ delayMs: 20 });
  const a = new Relayer(c1, cfgOf({ guardDbPath: db })), b = new Relayer(c2, cfgOf({ guardDbPath: db }));
  const { base64 } = build();
  const r = await Promise.allSettled([a.relay(base64), b.relay(base64)]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(c1.calls + c2.calls, 1);
  a.close(); b.close();
});

test("BLOCKED: 60 concurrent distinct-nonce requests from one sender never exceed the 20-call budget", async () => {
  // Proves: check-then-spend is atomic (reservation under IMMEDIATE tx) even with async chain latency.
  const chain = chainOf({ delayMs: 10, cost: EST });
  const relayer = new Relayer(chain, cfgOf());
  const kp = KeyPair.fromRandom("ed25519");
  const r = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => relayer.relay(build({ keyPair: kp, nonce: BigInt(i + 1) }).base64)));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 20);
  assert.equal(chain.calls, 20);
});

test("BLOCKED: restarting the relayer (new Relayer on same DB file) does not reset budget or nonces", async () => {
  // Proves: guard state is persistent end-to-end through Relayer, not just GuardStore.
  const db = join(mkdtempSync(join(tmpdir(), "rt-")), "g.sqlite3");
  const cfg = cfgOf({ guardDbPath: db, dailyBudgetYocto: EST });
  const kp = KeyPair.fromRandom("ed25519");
  const r1 = new Relayer(chainOf({ cost: EST }), cfg);
  await r1.relay(build({ keyPair: kp, nonce: 1n }).base64);
  r1.close();
  const c2 = chainOf();
  const r2 = new Relayer(c2, cfg);
  await assert.rejects(() => r2.relay(build({ keyPair: kp, nonce: 2n }).base64), GuardViolation);
  await assert.rejects(() => r2.relay(build({ keyPair: kp, nonce: 1n }).base64), GuardViolation);
  assert.equal(c2.calls, 0);
  r2.close();
});

test("BREAK: a delegate that fails ON-CHAIN (gas already burnt) is charged to the sender's budget, not refunded", async () => {
  // Was: any broadcast throw -> releaseBudget. near-api-js THROWS (ServerTransactionError) when the tx executed but failed
  // (stale nonce, non-payable + deposit, panic), so every failing delegate cost the relayer gas and the user's budget stayed at 0.
  const cfg = cfgOf({ dailyBudgetYocto: EST * 2n });
  const failing: any = {
    calls: 0,
    async currentBlockHeight() { return 4000n; },
    async broadcastSignedDelegate() {
      failing.calls += 1;
      const e: any = new Error("Exceeded the prepaid gas / DelegateActionInvalidNonce");
      e.transaction_outcome = { outcome: { tokens_burnt: "2000000000000000000000" } }; // shape produced by @near-js/utils parseResultError
      throw e;
    },
  };
  const relayer = new Relayer(failing, cfg);
  const kp = KeyPair.fromRandom("ed25519");
  for (let n = 1; n <= 2; n++) await assert.rejects(() => relayer.relay(build({ keyPair: kp, nonce: BigInt(n) }).base64));
  // two failed on-chain executions must have consumed the whole 2-call budget
  await assert.rejects(() => relayer.relay(build({ keyPair: kp, nonce: 3n }).base64), GuardViolation);
  assert.equal(failing.calls, 2);
});

test("BREAK: a reservation made in a previous budget window cannot erase a newer window's reservation", () => {
  // Was: rollover zeroed reserved_yocto, then releasing the OLD reservation subtracted its estimate from the NEW window's
  // (clamped at 0), so in-flight holds vanished and the cap could be exceeded by in-flight calls.
  const DAY = 24 * 3600 * 1000;
  let t = 1_000_000;
  const store = new GuardStore(":memory:", { maxRequestsPerWindow: 1000, windowMs: 60_000, dailyBudgetYocto: 100n }, () => t);
  const old = store.reserveBudget("u", 60n);
  t += DAY; // new window
  store.reserveBudget("u", 60n); // legitimately held in window 2
  store.releaseBudget("u", old.reservationId); // old call finishes after rollover
  assert.throws(() => store.reserveBudget("u", 60n), GuardViolation, "window-2 hold of 60 must still count");
  store.close();
});

// ---------------------------------------------------------------- (2) account-id / deposit

test("BREAK: malformed / non-canonical sender account ids are rejected before any guard or broadcast", async () => {
  // Was: senderId used verbatim as the budget/rate-limit key and as the outer tx receiver. 'Alice.testnet', 'alice.testnet ',
  // (non-ASCII ids cannot be built with this borsh lib: it truncates code points, so they never arrive) each got a FRESH budget + rate-limit bucket, trivially multiplying a user's sponsorship.
  for (const s of ["Alice.testnet", "alice.testnet ", "ALICE.TESTNET", "a", "x".repeat(65), "al..ice.testnet", ".alice", "alice.", "ali ce", "alice\u0000.testnet", ""]) {
    const chain = chainOf();
    await assert.rejects(() => new Relayer(chain, cfgOf()).relay(build({ senderId: s }).base64), (e) => e instanceof PolicyViolation || e instanceof BadSignedDelegate, JSON.stringify(s));
    assert.equal(chain.calls, 0, JSON.stringify(s));
  }
});

test("BLOCKED: valid named and implicit (64-hex) sender ids are still accepted", async () => {
  // Proves: the id validation above does not reject legit accounts.
  for (const s of ["alice.testnet", "a-b_c.d1.testnet", "ab", "a".repeat(64), "0123456789abcdef".repeat(4)]) {
    const chain = chainOf();
    await new Relayer(chain, cfgOf()).relay(build({ senderId: s }).base64);
    assert.equal(chain.calls, 1, s);
  }
});

test("BREAK: non-zero attached deposit on a non-payable escrow method is rejected pre-broadcast (gas griefing)", async () => {
  // Was: policy ignored FunctionCall.deposit; cancel/submit_exhibits/retry_payout/drain_payouts/emergency_refund are not #[payable],
  // so a deposit makes the call panic on-chain AFTER the relayer paid gas.
  for (const m of ["cancel", "submit_exhibits", "retry_payout", "drain_payouts", "emergency_refund"]) {
    const args = m === "emergency_refund" || m === "cancel" ? { bet_id: 1 } : { bet_id: 1, id: 1, limit: 1, hashes: [] };
    const chain = chainOf();
    await assert.rejects(() => new Relayer(chain, cfgOf()).relay(build({ methodName: m, args, deposit: 1n }).base64), PolicyViolation, m);
    assert.equal(chain.calls, 0);
  }
});

test("BLOCKED: request_resolution with a deposit is refused pre-broadcast (D-RELAYDEP1: the relayer would pay the bond); ft_transfer_call with 1 yocto is still relayed", async () => {
  // D-RELAYDEP1 supersedes "request_resolution (#[payable]) with a deposit is relayed": the delegate's deposit is charged to the relayer.
  const c1 = chainOf();
  await assert.rejects(() => new Relayer(c1, cfgOf()).relay(build({ methodName: "request_resolution", args: { bet_id: 1 }, deposit: 10n ** 22n }).base64), PolicyViolation);
  const c2 = chainOf();
  await new Relayer(c2, cfgOf()).relay(build({ receiverId: USDC, methodName: "ft_transfer_call", args: { receiver_id: ESCROW, amount: "5", msg: "{}" }, deposit: 1n }).base64);
  assert.equal(c1.calls, 0);
  assert.equal(c2.calls, 1);
});

test("BREAK: ft_transfer_call with a deposit above 1 yocto (NEP-141 demands exactly 1) is rejected pre-broadcast", async () => {
  // Was: any deposit accepted; token asserts exactly 1 yocto, so >1 fails on-chain after relayer paid gas.
  const chain = chainOf();
  await assert.rejects(() => new Relayer(chain, cfgOf()).relay(build({ receiverId: USDC, methodName: "ft_transfer_call", args: { receiver_id: ESCROW, amount: "5", msg: "{}" }, deposit: 2n }).base64), PolicyViolation);
  assert.equal(chain.calls, 0);
});

// ---------------------------------------------------------------- (5) HTTP layer: size + leaks

async function withServer<T>(relayer: { relay(s: string): Promise<{ txHash: string }> }, fn: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(createRelayHandler(relayer));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
function post(port: number, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/relay", method: "POST" }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    req.on("error", (e: any) => (e.code === "ECONNRESET" || e.code === "EPIPE" ? resolve({ status: 413, text: "connection closed by server" }) : reject(e)));
    req.end(body);
  });
}

test("BREAK: oversized request bodies are refused (413) before being buffered or parsed", async () => {
  // Was: runner concatenated the whole body in memory with no cap -> memory DoS on the relayer from one unauthenticated POST.
  let called = 0;
  await withServer({ async relay() { called++; return { txHash: "x" }; } }, async (port) => {
    const r = await post(port, JSON.stringify({ signedDelegate: "A".repeat(5 * 1024 * 1024) }));
    assert.equal(r.status, 413);
    assert.equal(called, 0);
  });
});

test("BLOCKED: normal-sized relay request over HTTP still works", async () => {
  // Proves: size cap leaves a real SignedDelegate (~300B) alone.
  await withServer({ async relay() { return { txHash: "OK1" }; } }, async (port) => {
    const r = await post(port, JSON.stringify({ signedDelegate: build().base64 }));
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true, txHash: "OK1" });
  });
});

test("BREAK: unexpected (non-policy) errors do not leak their message (RPC URLs / api keys / paths) to the HTTP client", async () => {
  // Was: every error's .message was echoed back with status 400, including raw fetch/RPC/sqlite errors that contain endpoint
  // URLs with embedded API keys and filesystem paths.
  const secretish = "request to https://rpc.example/?apiKey=SUPERSECRET123 failed; /home/relayer/.near-credentials/x.json";
  await withServer({ async relay() { throw new Error(secretish); } }, async (port) => {
    const r = await post(port, JSON.stringify({ signedDelegate: build().base64 }));
    assert.ok(r.status >= 500, `status ${r.status}`);
    assert.ok(!r.text.includes("SUPERSECRET123") && !r.text.includes(".near-credentials"), r.text);
  });
});

test("BLOCKED: policy / guard / decode rejections still return their reason with status 4xx", async () => {
  // Proves: client-facing error reasons for caller mistakes are preserved after the leak fix.
  for (const E of [PolicyViolation, GuardViolation, BadSignedDelegate]) {
    await withServer({ async relay() { throw new E("reason-xyz"); } }, async (port) => {
      const r = await post(port, JSON.stringify({ signedDelegate: "AAAA" }));
      assert.equal(r.status, 400, E.name); // public API shape unchanged: caller errors stay 400 + reason
      assert.ok(r.text.includes("reason-xyz"));
    });
  }
});

// DRILL1 offline test of the drill's assertion logic (no chain). Run: node --test assertions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { sideFee, concedeCredits, refundCredits, REFUSALS, matchesRefusal, residue, expectedEscrowDelta } from "./assertions.mjs";

test("sideFee = min(stake, max(stake*bps/10000, minFee))", () => {
  assert.equal(sideFee(10_000_000n, 100n, 500_000n), 500_000n); // 1% = 100000 < min
  assert.equal(sideFee(100_000_000n, 100n, 500_000n), 1_000_000n);
  assert.equal(sideFee(300_000n, 100n, 500_000n), 300_000n); // capped at stake
});

test("concede: winner gets both stakes minus both fees; fee account gets fees + both storage charges", () => {
  const c = concedeCredits({ maker: "m", taker: "t", conceder: "t", stakeM: 10_000_000n, stakeT: 10_000_000n, feeBps: 100n, minFeeM: 500_000n, minFeeT: 500_000n, storageM: 7n, storageT: 5n, feeAccount: "fee" });
  assert.equal(c.get("m"), 19_000_000n);
  assert.equal(c.get("fee"), 1_000_000n + 12n);
  assert.equal(c.get("t") ?? 0n, 0n);
  // conservation: credits == total deposited
  let sum = 0n; for (const v of c.values()) sum += v;
  assert.equal(sum, 20_000_000n + 12n);
});

test("emergency refund: exactly stake + storage back, NO fee; fee account gets nothing", () => {
  const c = refundCredits({ maker: "m", taker: "t", stakeM: 10_000_000n, stakeT: 10_000_000n, storageM: 7n, storageT: 5n });
  assert.equal(c.get("m"), 10_000_007n);
  assert.equal(c.get("t"), 10_000_005n);
  assert.equal(c.get("fee"), undefined);
  const open = refundCredits({ maker: "m", taker: null, stakeM: 10_000_000n, stakeT: 0n, storageM: 7n, storageT: 0n });
  assert.equal(open.get("m"), 10_000_007n);
  assert.equal(open.size, 1);
});

test("refusal strings are the frozen contract's and are matched as substrings", () => {
  assert.equal(REFUSALS.onlyGuardian, "only guardian");
  assert.equal(REFUSALS.onlyProposed, "only the proposed guardian may accept");
  assert.equal(REFUSALS.alreadyShutdown, "already shut down");
  assert.equal(REFUSALS.unpauseAfterShutdown, "contract is shut down; unpause is impossible after shutdown");
  assert.equal(REFUSALS.voidAfterShutdown, "contract is shut down");
  assert.ok(matchesRefusal("Smart contract panicked: only guardian", REFUSALS.onlyGuardian));
  assert.ok(!matchesRefusal("Smart contract panicked: no pending guardian", REFUSALS.onlyGuardian));
  assert.ok(!matchesRefusal("", REFUSALS.onlyGuardian));
  assert.ok(!matchesRefusal(undefined, REFUSALS.onlyGuardian));
});

test("residue: balance delta minus expected credits must be zero; any difference is reported non-zero", () => {
  assert.equal(residue(100n, 100n), 0n);
  assert.equal(residue(100n, 90n), 10n);
  assert.equal(residue(100n, 101n), -1n);
});

test("expectedEscrowDelta: escrow's intents balance returns to its pre-drill value once every bet is paid out", () => {
  // deposits in (A maker, B both, C both), all paid out => delta 0
  assert.equal(expectedEscrowDelta({ deposited: 100n, paidOut: 100n }), 0n);
  assert.equal(expectedEscrowDelta({ deposited: 100n, paidOut: 60n }), 40n);
});

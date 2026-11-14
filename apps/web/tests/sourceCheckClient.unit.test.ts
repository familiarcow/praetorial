// D-FETCH2 crosscheck: lib/sourceCheckClient.ts's message builder must
// produce byte-identical output to contracts/escrow/src/lib.rs's
// `sourcecheck_message` -- pinned against the shared fixture
// contracts/escrow/tests/fixtures/sourcecheck_crosscheck.json (also used
// by resolver/core and services/common/src/sourceCheck.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sourcecheckMessage, isSourceCheckFresh, SOURCECHECK_FRESHNESS_NS } from "../lib/sourceCheckClient";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "contracts",
  "escrow",
  "tests",
  "fixtures",
  "sourcecheck_crosscheck.json",
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  spec_hash: string;
  checked_at: string;
  message: string;
  message_hex: string;
};

test("sourcecheckMessage matches the shared crosscheck fixture's message string", () => {
  const built = sourcecheckMessage(fixture.spec_hash, fixture.checked_at);
  assert.equal(built, fixture.message);
});

test("sourcecheckMessage matches the shared crosscheck fixture's message bytes (hex)", () => {
  const built = sourcecheckMessage(fixture.spec_hash, fixture.checked_at);
  const builtHex = Buffer.from(built, "utf8").toString("hex");
  assert.equal(builtHex, fixture.message_hex);
});

test("sourcecheckMessage accepts a bigint checkedAtNs and matches the string form", () => {
  const asBigint = sourcecheckMessage(fixture.spec_hash, BigInt(fixture.checked_at));
  assert.equal(asBigint, fixture.message);
});

test("sourcecheckMessage rejects a non-integer checked_at", () => {
  assert.throws(() => sourcecheckMessage(fixture.spec_hash, "not-a-number"));
});

test("isSourceCheckFresh: exactly at the 1h boundary passes (inclusive)", () => {
  const checkedAt = 1_000_000_000_000n;
  const now = checkedAt + SOURCECHECK_FRESHNESS_NS;
  assert.equal(isSourceCheckFresh(checkedAt, now), true);
});

test("isSourceCheckFresh: 1h + 1ns old fails", () => {
  const checkedAt = 1_000_000_000_000n;
  const now = checkedAt + SOURCECHECK_FRESHNESS_NS + 1n;
  assert.equal(isSourceCheckFresh(checkedAt, now), false);
});

test("isSourceCheckFresh: a future checked_at is always refused", () => {
  const now = 1_000_000_000_000n;
  const checkedAt = now + 1n;
  assert.equal(isSourceCheckFresh(checkedAt, now), false);
});

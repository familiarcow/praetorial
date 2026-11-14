// D-DSY1 (1): contract_version() vs ESCROW_CONTRACTS '@vN' label.
import { test } from "node:test";
import assert from "node:assert/strict";
import { versionMatchesLabel, checkContractVersions } from "../src/versionCheck.js";

test("label 'vN' matches semver major N", () => {
  assert.equal(versionMatchesLabel("v1", "1.0.0"), true);
  assert.equal(versionMatchesLabel("v1", "1.9.3"), true);
  assert.equal(versionMatchesLabel("v2", "1.9.3"), false);
  assert.equal(versionMatchesLabel("v1", "0.1.0"), false);
  assert.equal(versionMatchesLabel("v0", "0.1.0"), true);
});

test("a full-semver label (optional leading v) must match exactly", () => {
  assert.equal(versionMatchesLabel("0.1.0", "0.1.0"), true);
  assert.equal(versionMatchesLabel("v0.1.0", "0.1.0"), true);
  assert.equal(versionMatchesLabel("0.1.0", "0.1.1"), false);
  assert.equal(versionMatchesLabel("1.2.3-rc.1", "1.2.3"), false);
});

test("unparsable label or version never matches", () => {
  assert.equal(versionMatchesLabel("latest", "1.0.0"), false);
  assert.equal(versionMatchesLabel("v1", "garbage"), false);
  assert.equal(versionMatchesLabel("v1", ""), false);
});

const clientOf = (versions: Record<string, string | "dead">): any => ({
  async view(c: string, m: string) {
    assert.equal(m, "contract_version");
    const v = versions[c];
    if (v === undefined || v === "dead") throw new Error("rpc down");
    return v;
  },
});

test("checkContractVersions: match / mismatch / unchecked per contract, failure-isolated", async () => {
  const r = await checkContractVersions(
    clientOf({ "a.testnet": "1.2.0", "b.testnet": "2.0.0", "c.testnet": "dead" }),
    [{ id: "a.testnet", version: "v1" }, { id: "b.testnet", version: "v1" }, { id: "c.testnet", version: "v1" }],
  );
  assert.deepEqual(r.map((x) => [x.contractId, x.status, x.actual]), [
    ["a.testnet", "match", "1.2.0"],
    ["b.testnet", "mismatch", "2.0.0"],
    ["c.testnet", "unchecked", null],
  ]);
});

test("non-string / empty contract_version result is 'unchecked', not a match", async () => {
  const client: any = { async view() { return null; } };
  const r = await checkContractVersions(client, [{ id: "a.testnet", version: "v1" }]);
  assert.equal(r[0].status, "unchecked");
});

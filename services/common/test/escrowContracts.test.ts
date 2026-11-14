// RED-first (D-UPGRADE1): ESCROW_CONTRACTS='id1@v1,id2@v2' must parse to
// a list of contract refs; the old single ESCROW_CONTRACT_ID env var
// must keep working unchanged when ESCROW_CONTRACTS is unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEscrowContracts } from "../src/config.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("backward compat: single ESCROW_CONTRACT_ID still works when ESCROW_CONTRACTS is unset", () => {
  withEnv({ ESCROW_CONTRACTS: undefined, ESCROW_CONTRACT_ID: "escrow-v1.testnet" }, () => {
    const refs = parseEscrowContracts();
    assert.deepEqual(refs, [{ id: "escrow-v1.testnet", version: "v1" }]);
  });
});

test("ESCROW_CONTRACTS parses a multi-contract list with versions", () => {
  withEnv({ ESCROW_CONTRACTS: "escrow-v1.testnet@v1,escrow-v2.testnet@v2", ESCROW_CONTRACT_ID: undefined }, () => {
    const refs = parseEscrowContracts();
    assert.deepEqual(refs, [
      { id: "escrow-v1.testnet", version: "v1" },
      { id: "escrow-v2.testnet", version: "v2" },
    ]);
  });
});

test("ESCROW_CONTRACTS entry without @version defaults to v1", () => {
  withEnv({ ESCROW_CONTRACTS: "escrow-only.testnet", ESCROW_CONTRACT_ID: undefined }, () => {
    const refs = parseEscrowContracts();
    assert.deepEqual(refs, [{ id: "escrow-only.testnet", version: "v1" }]);
  });
});

test("whitespace around entries/ids is trimmed", () => {
  withEnv({ ESCROW_CONTRACTS: " a.testnet@v1 , b.testnet@v2 ", ESCROW_CONTRACT_ID: undefined }, () => {
    const refs = parseEscrowContracts();
    assert.deepEqual(refs, [
      { id: "a.testnet", version: "v1" },
      { id: "b.testnet", version: "v2" },
    ]);
  });
});

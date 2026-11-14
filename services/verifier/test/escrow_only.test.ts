// FRZ1b (found live): verify-escrow has no bet; it must run only E1-E4 and not crash in bet checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEscrowChecks, loadEvidenceDir } from "../src/run.js";

const R3E = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "e2e", "live-runR3e");
test("runEscrowChecks on bet-less evidence returns exactly E1-E4 without throwing", () => {
  const ev: any = loadEvidenceDir(R3E);
  delete ev.bet;
  const r = runEscrowChecks(ev, {});
  assert.deepEqual(r.map((x) => x.id), ["E1", "E2", "E3", "E4"]);
});

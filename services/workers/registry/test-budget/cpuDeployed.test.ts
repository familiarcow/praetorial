// CF1f / D-CF1F1: the DEPLOYED gate: >= 60 live requests (search/lookup/health + >= 1 real claim) under a single-worker `wrangler tail`
// with zero exceededCpu and zero non-ok outcomes. p50/max are recorded (printed; summary.txt); max > 8 ms alone is not a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore plain ESM script shared with the CLI
import { summarizeTail } from "../../../e2e/live-CF1f/count_outcomes.mjs";
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../e2e/live-CF1f");
test("CF1f deployed: >= 60 live registry requests incl. a real claim on testnet, zero exceededCpu, zero non-ok", () => {
  const file = path.join(DIR, "tail_registry.json");
  assert.ok(fs.existsSync(file), "no deployed evidence: run the wrangler tail capture (see e2e/live-CF1f/README.md)");
  const s = summarizeTail(fs.readFileSync(file, "utf8"));
  console.log("CF1f-DEPLOYED registry " + JSON.stringify({ events: s.events, claims: s.claims, outcomes: s.outcomes, exceededCpu: s.exceededCpu, nonOk: s.nonOk, cpuP50: s.cpuP50, cpuMax: s.cpuMax }));
  assert.ok(s.events >= 60, `only ${s.events} events`); assert.ok(s.claims >= 1, "no real claim in the tail");
  assert.equal(s.exceededCpu, 0); assert.equal(s.nonOk, 0, JSON.stringify(s.outcomes));
});

// FRZ2SEC1: a live run whose resolver fell back to the offline mock (no NEAR_AI_API_KEY injected) must never pass.
// Fixture = DR4 bet 25 on frz2: last_resolution_raw from get_bet (no secrets in it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeBackendOf, assertRealJudge } from "../judgeBackend.js";
import { writeEvidenceDir, type RecordedRun } from "../recorder.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => JSON.parse(readFileSync(join(here, "..", "fixtures", n), "utf8"));
const MOCK = fx("frz2_bet25_get_bet_offline_mock.json").last_resolution_raw as string;

test("bet 25 raw (offline-mock, key not injected) is reported as mock and refused", () => {
  const r = judgeBackendOf(MOCK);
  assert.equal(r.backend, "offline-mock");
  assert.match(r.reason ?? "", /NEAR_AI_API_KEY/);
  assert.equal(r.real, false);
  assert.throws(() => assertRealJudge(MOCK), /offline-mock/);
  assert.throws(() => assertRealJudge(MOCK), /NEAR_AI_API_KEY/);
});

test("a near-ai raw passes and reports its http statuses", () => {
  const raw = JSON.stringify({ judge: { judge_backend: "near-ai", judge_backend_reason: null, run_diagnostics: [{ http_status: 200 }, { http_status: 200 }] } });
  const r = judgeBackendOf(raw);
  assert.equal(r.real, true);
  assert.deepEqual(r.httpStatuses, [200, 200]);
  assert.doesNotThrow(() => assertRealJudge(raw));
});

test("a missing/unknown backend, an unparsable raw, or a no-key reason is refused (fail closed)", () => {
  assert.throws(() => assertRealJudge(JSON.stringify({ judge: {} })), /judge_backend/);
  assert.throws(() => assertRealJudge("not json"), /last_resolution_raw/);
  assert.throws(() => assertRealJudge(JSON.stringify({ judge: { judge_backend: "near-ai", judge_backend_reason: "NEAR_AI_API_KEY is not set" } })), /NEAR_AI_API_KEY/);
});

test("the evidence recorder refuses a live run whose raw resolution used the offline mock", () => {
  const input: RecordedRun = JSON.parse(readFileSync(join(here, "..", "fixtures", "recorded_run_input.json"), "utf8"));
  const bad = structuredClone(input);
  (bad.rawResolution as any).judge = JSON.parse(MOCK).judge;
  assert.throws(() => writeEvidenceDir(bad, join(process.env.TMPDIR ?? "/tmp", "frz2sec1-never")), /offline-mock/);
  const badBet = structuredClone(input);
  (badBet.bets.afterRequest as any).last_resolution_raw = MOCK;
  assert.throws(() => writeEvidenceDir(badBet, join(process.env.TMPDIR ?? "/tmp", "frz2sec1-never")), /offline-mock/);
});

// DR1b point (4): the recorder captures the raw NEAR AI stream + attestation report when available so verify-bet B4 can PASS on a future run.
// Fixture: verifier V1b record (judge diagnostics with signature_proof, raw streams) + the V1d attestation report (clone edited to the V1b test signer, SYNTHETIC like b4_binding.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJudgeEvidence, attestationTargets, b4Gaps, writeEvidenceDir, type RecordedRun } from "../recorder.js";
import { checkB4, type Evidence } from "../../../../verifier/src/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = join(here, "..", "..", "..", "..", "verifier", "test", "fixtures");
const rj = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const raw = rj(join(V, "v1b", "raw_resolution.txt"));
const terms = readFileSync(join(V, "v1b", "terms.json"), "utf8");
const je = rj(join(V, "v1b", "judge_evidence.json"));
const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dr1b-b4-"));
const addr: string = raw.judge.run_diagnostics[0].signature_proof.signing_address;
const report = (model: string) => { const r = rj(join(V, "v1d", "attestation_report_z-ai_glm-5.3.json")); r.gateway_attestation.signing_address = addr; r.ohttp_attestation.signing_key = addr; r.model_attestations[0].model = model; return JSON.stringify(r); };
const targets = attestationTargets(raw);
const atts = targets.map((t) => ({ model: t.model, signing_address: t.signing_address, raw: report(t.model) }));
const evOf = (): Evidence => ({ judge: raw.judge, termsRaw: terms, submitted: [{ result: raw.result, signatureHex: raw.signing.signature_hex, pubkeyHex: raw.signing.pubkey_hex }] } as unknown as Evidence);

test("attestationTargets lists each distinct (model, signing_address) of the recorded answers", () => {
  assert.ok(targets.length >= 1);
  for (const t of targets) assert.equal(t.signing_address, addr);
  assert.deepEqual(new Set(targets.map((t) => t.model)), new Set(raw.judge.run_diagnostics.map((d: any) => d.model)));
});

test("writeJudgeEvidence writes judge_evidence.json {sources,responses} and one attestation report file per signer, byte-exact", () => {
  const dir = scratch();
  writeJudgeEvidence({ judgeEvidence: je, attestations: atts }, dir);
  assert.deepEqual(rj(join(dir, "judge_evidence.json")), je);
  const files = readdirSync(dir).filter((f) => f.startsWith("attestation_report_"));
  assert.equal(files.length, atts.length);
  for (const a of atts) assert.ok(files.some((f) => readFileSync(join(dir, f), "utf8") === a.raw));
});

test("with the captured stream + attestation, B4 is a FULL PASS offline (and a SKIP without them)", () => {
  const dir = scratch();
  writeJudgeEvidence({ judgeEvidence: je, attestations: atts }, dir);
  const files = readdirSync(dir).filter((f) => f.startsWith("attestation_report_"));
  const withIt = checkB4(evOf(), { judgeEvidence: rj(join(dir, "judge_evidence.json")), attestations: files.map((f) => ({ name: f, raw: readFileSync(join(dir, f), "utf8") })), termsPath: undefined } as any);
  assert.equal(withIt.status, "PASS", JSON.stringify(withIt));
  const without = checkB4(evOf(), {} as any);
  assert.equal(without.status, "SKIP");
});

test("b4Gaps names what is missing (never silently optional): streams, sources, attestations", () => {
  assert.deepEqual(b4Gaps(raw, { judgeEvidence: je, attestations: atts }), []);
  const g = b4Gaps(raw, {});
  assert.ok(g.some((x) => /raw NEAR AI stream/.test(x)), g.join("|"));
  assert.ok(g.some((x) => /attestation/.test(x)), g.join("|"));
  assert.ok(b4Gaps(raw, { judgeEvidence: { sources: je.sources, responses: {} }, attestations: atts }).some((x) => /raw NEAR AI stream/.test(x)));
});

test("writeEvidenceDir records b4_evidence.json with the gap list; no judge evidence -> gaps are written down, not hidden", () => {
  const input: RecordedRun = rj(join(here, "..", "fixtures", "recorded_run_input.json"));
  const dir = scratch();
  writeEvidenceDir(input, dir);
  assert.ok(existsSync(join(dir, "b4_evidence.json")));
  const b = rj(join(dir, "b4_evidence.json"));
  assert.ok(Array.isArray(b.gaps) && b.captured && typeof b.captured.streams === "number");
  const dir2 = scratch();
  writeEvidenceDir({ ...input, judgeEvidence: je, attestations: [] }, dir2);
  assert.ok(existsSync(join(dir2, "judge_evidence.json")));
});

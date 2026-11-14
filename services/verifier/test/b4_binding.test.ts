// V1d / D-VER2a: B4 binds every NEAR AI signing_address to NEAR AI's public model attestation report.
// Binding rule (docs/VERIFY.md B4): report.model_attestations[].model == the recorded model AND
// report.gateway_attestation.signing_address == the recorded signing_address. The TDX/GPU quote chain is NOT verified.
// Positive binding uses the REAL recorded report (fixtures/v1d) + the REAL signed NEAR AI response (judge-proto/attest).
// The V1b fixture uses a TEST keypair, so its report is SYNTHETIC (an edited clone of the real report); so are all mismatch reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { checkB4, type Evidence } from "../src/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const V1B = join(here, "fixtures", "v1b");
const ATT = join(here, "..", "..", "..", "judge-proto", "attest");
const REAL_REPORT_PATH = join(here, "fixtures", "v1d", "attestation_report_z-ai_glm-5.3.json");
const REAL_REPORT = readFileSync(REAL_REPORT_PATH, "utf8");
const REAL_ADDR = "40599fb284f43953bb356b09080fd803c960fc10285ad90eca462ca711ad4acb";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const rj = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** SYNTHETIC: clone of the real report edited to attest `model` under `address`. */
function synth(model: string, address: string): { name: string; raw: string } {
  const r = JSON.parse(REAL_REPORT);
  r.gateway_attestation.signing_address = address;
  r.ohttp_attestation.signing_key = address;
  r.model_attestations[0].model = model;
  return { name: `synthetic-${model}`, raw: JSON.stringify(r) };
}

function v1b(): { ev: Evidence; je: any; addr: string; models: string[] } {
  const r = rj(join(V1B, "raw_resolution.txt"));
  const terms = readFileSync(join(V1B, "terms.json"), "utf8");
  const je = rj(join(V1B, "judge_evidence.json"));
  const ev = { judge: r.judge, termsRaw: terms, submitted: [{ result: r.result, signatureHex: r.signing.signature_hex, pubkeyHex: r.signing.pubkey_hex }] } as unknown as Evidence;
  const ds = r.judge.run_diagnostics;
  return { ev, je, addr: ds[0].signature_proof.signing_address, models: ds.map((d: any) => d.model) };
}

/** REAL signed NEAR AI response (judge-proto/attest) wrapped as a recorded diagnostic. */
function realProofEvidence(): Evidence {
  const sig = rj(join(ATT, "sig.json"));
  const req = rj(join(ATT, "req.json"));
  const proof = {
    signing_algo: sig.signing_algo, signing_address: sig.signing_address, signature: sig.signature, text: sig.text,
    response_sha256: sha(readFileSync(join(ATT, "resp.json"))), request_sha256: sha(readFileSync(join(ATT, "req.json"))),
  };
  const judge = { elements: [], run_diagnostics: [{ model: req.model, verify_result: "answer", signature_verified: true, signature_proof: proof }] };
  return { judge, submitted: [{ result: { outcome: "VOID" }, signatureHex: "", pubkeyHex: "" }] } as unknown as Evidence;
}

test("REAL recorded report + REAL signed NEAR AI response: signer is bound (no FAIL), report sha256 recorded", () => {
  const r = checkB4(realProofEvidence(), { attestations: [{ name: "real", raw: REAL_REPORT }] });
  assert.notEqual(r.status, "FAIL", r.reason);
  assert.match(r.reason, /bound/i);
  assert.match(r.reason, new RegExp(REAL_ADDR.slice(0, 12)));
  assert.doesNotMatch(r.reason, /attestation report for/i); // not listed as missing
  assert.match(r.reason, new RegExp(sha(REAL_REPORT).slice(0, 16)));
  const ev = r.evidence as any;
  assert.equal(ev.attestation_reports[0].sha256, sha(REAL_REPORT));
  assert.equal(ev.attestation_reports[0].model, "z-ai/glm-5.3");
  assert.equal(ev.bound[0].signing_address, REAL_ADDR);
});

test("REAL signed response, report lists a different signing key -> FAIL (forged-keypair class)", () => {
  const r = checkB4(realProofEvidence(), { attestations: [synth("z-ai/glm-5.3", "11".repeat(32))] });
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /not (listed|bound)|unknown signer/i);
});

test("V1b fixture (test keypair) claiming the REAL report's model + REAL report: self-keypair forgery -> FAIL, not bound", () => {
  const { ev, je } = v1b();
  for (const d of (ev.judge as any).run_diagnostics) d.model = "z-ai/glm-5.3"; // the model name is not part of the NEAR AI signature
  const r = checkB4(ev, { judgeEvidence: je, attestations: [{ name: "real", raw: REAL_REPORT }] });
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /signer|signing_address|model/i);
});

test("SYNTHETIC matching reports for every (model, signer) -> B4 PASS, reason says bound + report sha256", () => {
  const { ev, je, addr, models } = v1b();
  const reps = [...new Set(models)].map((m) => synth(m, addr));
  const r = checkB4(ev, { judgeEvidence: je, attestations: reps });
  assert.equal(r.status, "PASS", r.reason);
  assert.match(r.reason, /bound/i);
  assert.match(r.reason, new RegExp(sha(reps[0].raw).slice(0, 16)));
  assert.equal((r.evidence as any).attestation_reports.length, reps.length);
});

test("signer not listed by the report for its model -> FAIL", () => {
  const { ev, je, models } = v1b();
  const reps = [...new Set(models)].map((m) => synth(m, "22".repeat(32)));
  const r = checkB4(ev, { judgeEvidence: je, attestations: reps });
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /not (listed|bound)|unknown signer/i);
});

test("report lists the signer but attests a DIFFERENT model -> FAIL (model mismatch)", () => {
  const { ev, je, addr } = v1b();
  const r = checkB4(ev, { judgeEvidence: je, attestations: [synth("other/model-x", addr)] });
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /model/i);
});

test("no attestation report supplied -> SKIP (never PASS) naming the signer and model", () => {
  const { ev, je, addr } = v1b();
  const r = checkB4(ev, { judgeEvidence: je });
  assert.equal(r.status, "SKIP");
  assert.match(r.reason, /attestation/i);
  assert.match(r.reason, new RegExp(addr.slice(0, 12)));
  assert.match(r.reason, /test\/model-a/);
  assert.match(r.reason, /signature/i); // signatures WERE re-verified and said so
});

test("report for only model-a lists the signer; model-b has no report of its own -> FAIL model mismatch naming model-b", () => {
  const { ev, je, addr } = v1b();
  const r = checkB4(ev, { judgeEvidence: je, attestations: [synth("test/model-a", addr)] });
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /test\/model-b/);
  assert.match(r.reason, /model mismatch/i);
});

test("supplied report is about neither this model nor this signer -> SKIP naming the signer (not PASS)", () => {
  const { ev, je, addr } = v1b();
  const r = checkB4(ev, { judgeEvidence: je, attestations: [{ name: "real", raw: REAL_REPORT }] });
  assert.equal(r.status, "SKIP");
  assert.match(r.reason, new RegExp(addr.slice(0, 12)));
});

test("tampered signature still FAILs with a matching report (binding does not mask signature checks)", () => {
  const { ev, je, addr, models } = v1b();
  const p = (ev.judge as any).run_diagnostics[0].signature_proof;
  p.signature = (p.signature[0] === "a" ? "b" : "a") + p.signature.slice(1);
  const r = checkB4(ev, { judgeEvidence: je, attestations: [...new Set(models)].map((m) => synth(m, addr)) });
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /signature/i);
});

test("malformed attestation file (not a NEAR AI report) -> FAIL, not silently ignored", () => {
  const { ev, je } = v1b();
  const r = checkB4(ev, { judgeEvidence: je, attestations: [{ name: "junk", raw: "{\"hello\":1}" }] });
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /attestation/i);
});

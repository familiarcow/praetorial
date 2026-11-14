// V1b / D-VER2: check B4 (last_resolution_raw) is independent. The fixture (test/fixtures/v1b) is produced by the CURRENT
// resolver run offline with a test keypair + mocked NEAR AI responses (cargo test v1b_fixture, WRITE=1 regenerates it).
// No assertion is ever loosened to get green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { checkB4, quoteKey, quoteIn, elementVerdictQ, loadEvidenceDir, type Evidence } from "../src/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "v1b");
const R3E = join(here, "..", "..", "e2e", "live-runR3e");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rj = (p: string) => JSON.parse(readFileSync(p, "utf8"));

function load(raw = "raw_resolution.txt"): { ev: Evidence; je: any; terms: string } {
  const r = rj(join(FIX, raw));
  const terms = readFileSync(join(FIX, "terms.json"), "utf8");
  const je = rj(join(FIX, "judge_evidence.json"));
  const ev = { judge: r.judge, termsRaw: terms, submitted: [{ result: r.result, signatureHex: r.signing.signature_hex, pubkeyHex: r.signing.pubkey_hex }] } as unknown as Evidence;
  return { ev, je, terms };
}
// V1d: B4 PASS now also needs every signer bound to a NEAR AI attestation report. The V1b fixture signs with a TEST keypair, so these
// pre-V1d tests get a SYNTHETIC matching report (edited clone of the real recorded one); no assertion below was changed.
function fixtureReports(ev: Evidence): { name: string; raw: string }[] {
  const out = new Map<string, { name: string; raw: string }>();
  for (const d of (ev.judge as any).run_diagnostics) {
    const p = d.signature_proof;
    if (!p) continue;
    const r = rj(join(here, "fixtures", "v1d", "attestation_report_z-ai_glm-5.3.json"));
    r.gateway_attestation.signing_address = p.signing_address;
    r.model_attestations[0].model = d.model;
    out.set(d.model, { name: `synthetic-${d.model}`, raw: JSON.stringify(r) });
  }
  return [...out.values()];
}
const b4 = (ev: Evidence, je?: any) => checkB4(ev, { judgeEvidence: je, attestations: fixtureReports(ev) });

test("recorded v1b fixture, evidence supplied -> B4 PASS", () => {
  const { ev, je } = load();
  const r = b4(ev, je);
  assert.equal(r.status, "PASS", r.reason);
  assert.match(r.reason, /signature/i);
  assert.match(r.reason, /quote/i);
});

test("same fixture, no judge evidence supplied -> SKIP naming exactly what is missing (not PASS, not FAIL)", () => {
  const { ev } = load();
  const r = b4(ev, undefined);
  assert.equal(r.status, "SKIP");
  assert.match(r.reason, /source text/i);
  assert.match(r.reason, /stream/i);
  assert.match(r.reason, /signature/i); // the signatures WERE re-verified and said so
});

test("tampered NEAR AI signature -> FAIL", () => {
  const { ev, je } = load();
  const p = (ev.judge as any).run_diagnostics[0].signature_proof;
  p.signature = (p.signature[0] === "a" ? "b" : "a") + p.signature.slice(1);
  const r = b4(ev, je);
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /signature/i);
});

test("tampered signed text (hash swapped) -> FAIL", () => {
  const { ev, je } = load();
  const p = (ev.judge as any).run_diagnostics[0].signature_proof;
  p.text = p.text.replace(/^./, p.text[0] === "a" ? "b" : "a");
  assert.equal(b4(ev, je).status, "FAIL");
});

test("tampered quote (answer text edited, recorded hashes left) vs source text -> FAIL", () => {
  const { ev, je } = load();
  const d = (ev.judge as any).run_diagnostics[0];
  d.content = d.content.replace("MAXIMUM 72", "MAXIMUM 75");
  const r = b4(ev, je);
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /sha256|stream|quote/i);
});

test("quote not in the (hash-correct) source text -> FAIL even with consistent recorded hashes", () => {
  // The answer, its hashes, the stream and the signature are all re-made consistently; only the source says something else.
  const { ev, je } = load();
  const src = je.sources.S_A as string;
  je.sources.S_A = src.replace("MAXIMUM 72", "MAXIMUM 62");
  (ev.judge as any).sources[0].sha256 = sha(je.sources.S_A); // attacker re-hashes the source too
  const r = b4(ev, je);
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /quote|raw_sha256|stream/i);
});

test("source text with the wrong sha256 -> FAIL", () => {
  const { ev, je } = load();
  je.sources.S_A = je.sources.S_A + " extra";
  const r = b4(ev, je);
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /S_A.*sha256/i);
});

test("raw stream bytes whose sha256 is not the signed one -> FAIL", () => {
  const { ev, je } = load();
  const k = Object.keys(je.responses)[0];
  je.responses[k] = je.responses[k].replace("MAXIMUM 72", "MAXIMUM 75");
  assert.equal(b4(ev, je).status, "FAIL");
});

test("honest single-origin run (resolver said insufficient -> VOID) -> B4 PASS: D-ORIGIN1 re-applied agrees", () => {
  const { ev, je } = load("raw_resolution_single_origin.txt");
  const r = b4(ev, je);
  assert.equal(r.status, "PASS", r.reason);
  assert.match(r.reason, /D-ORIGIN1/);
});

test("single-origin decisive YES (D-ORIGIN1) -> FAIL", () => {
  const { ev, je } = load("raw_resolution_single_origin.txt");
  // a dishonest record: the answers cite ONE origin, but the verdict is claimed 'met' and the outcome YES
  (ev.judge as any).elements[0].verdict = "met";
  (ev.submitted[0].result as any).outcome = "YES";
  const r = b4(ev, je);
  assert.equal(r.status, "FAIL");
  assert.match(r.reason, /origin|insufficient|decision/i);
});

test("single-origin decisive YES also FAILs without source text supplied (origin facts are in the record)", () => {
  const { ev } = load("raw_resolution_single_origin.txt");
  (ev.judge as any).elements[0].verdict = "met";
  (ev.submitted[0].result as any).outcome = "YES";
  assert.equal(b4(ev, undefined).status, "FAIL");
});

test("D-EXH1: an exhibit-rule element with one origin cannot be decisive -> verdict insufficient", () => {
  const srcs = [{ id: "X1", url: "https://a.example.org/p", publisher: "A" }, { id: "X2", url: "https://www.a.example.org/q", publisher: "B" }];
  assert.equal(elementVerdictQ([["met", "X1,X2"]], srcs, true), "insufficient");
  const two = [{ id: "X1", url: "https://a.example.org/p", publisher: "A" }, { id: "X2", url: "https://b.example.net/q", publisher: "B" }];
  assert.equal(elementVerdictQ([["met", "X1,X2"]], two, true), "met");
});

test("tampered recorded verdict vs answers -> FAIL (verdict re-derived from answers, not trusted)", () => {
  const { ev, je } = load();
  (ev.judge as any).elements[0].verdict = "not_proven";
  assert.equal(b4(ev, je).status, "FAIL");
});

test("quote check uses the J4 normalisation: formatting-insensitive, numbers kept apart", () => {
  assert.equal(quoteIn("THE RATE IS 3.5 PERCENT", "the rate is 3.5 percent"), true);
  assert.equal(quoteIn("The rate is 3.5 percent", "The rate is 35 percent"), false);
  assert.equal(quoteIn("The low was -5 degrees", "The low was 5 degrees"), false);
});

test("quoteKey parity with the shared Rust/Python J4 fixture (resolver/core/tests/fixtures/quote_key.json)", () => {
  const f = rj(join(here, "..", "..", "..", "resolver", "core", "tests", "fixtures", "quote_key.json"));
  assert.ok(f.keys.length > 10);
  for (const c of f.keys) assert.equal(quoteKey(c.input), c.key, JSON.stringify(c.input));
});

test("origin/quorum parity vectors (judge.py == Rust core == TS port)", () => {
  const v = rj(join(here, "fixtures", "b4_parity.json"));
  assert.ok(v.cases.length >= 6);
  for (const c of v.cases) assert.equal(elementVerdictQ(c.results, c.sources, c.quorum), c.expect, c.name);
});

test("R3e (older resolver) -> B4 SKIP that says exactly which material is missing; never PASS, never FAIL", () => {
  const ev = loadEvidenceDir(R3E);
  const r = checkB4(ev, {});
  assert.equal(r.status, "SKIP");
  assert.match(r.reason, /signature_proof/);
  assert.match(r.reason, /judge\.sources/);
  assert.match(r.reason, /older resolver/i);
});

test("raw_resolution.txt copy with an extra byte in a recorded hash -> FAIL (loadEvidenceDir path)", () => {
  const d = mkdtempSync(join(tmpdir(), "b4-"));
  cpSync(R3E, d, { recursive: true });
  const p = join(d, "raw_resolution.txt");
  const j = rj(p);
  j.judge.run_diagnostics[1].content_sha256 = "00".repeat(32);
  writeFileSync(p, JSON.stringify(j));
  assert.equal(checkB4(loadEvidenceDir(d), {}).status, "FAIL");
});

// L1b10: live2 bet 1 (recorded raw resolution + terms). The pre-D-EARLYREQ1 resolver refused the too-early request (judge_ran=false, no
// elements) and still signed VOID; the terms' rule over zero verdicts is NO, so B4 FAILs. That is a correct detection (a signed outcome the
// recorded judge work does not support), not a verifier bug; a646d02 stops the resolver signing such a result. B4 must stay strict.
test("L1b10: live2 bet 1 (refused too-early request, signed VOID with no judge work) -> B4 FAIL, stays strict", () => {
  const live2 = join(here, "..", "..", "e2e", "live-L1", "live2");
  const r = rj(join(live2, "raw_resolution_close_above_future.txt"));
  assert.equal(r.judge.judge_ran, false);
  assert.match(r.notes.join(" "), /REQ_BEFORE_T_PLUS_5MIN/);
  const ev = { judge: r.judge, termsRaw: readFileSync(join(live2, "terms_close_above_future.json"), "utf8"), submitted: [{ result: r.result, signatureHex: r.signing.signature_hex, pubkeyHex: r.signing.pubkey_hex }] } as unknown as Evidence;
  const out = checkB4(ev, {});
  assert.equal(out.status, "FAIL");
  assert.match(out.reason, /decision rule re-applied gives NO, signed outcome is VOID/);
});

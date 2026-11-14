// V1d: optional live fetch of the public NEAR AI attestation report (keyless GET) and the --attestation CLI flag.
// Offline: fetch is injected; the body served is the REAL recorded report (fixtures/v1d).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAttestation } from "../src/attest.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPORT = join(here, "fixtures", "v1d", "attestation_report_z-ai_glm-5.3.json");
const ADDR = "40599fb284f43953bb356b09080fd803c960fc10285ad90eca462ca711ad4acb";
const BIN = join(here, "..", "verify-bet");
const R3E = join(here, "..", "..", "e2e", "live-runR3e");

test("fetchAttestation: keyless GET of /v1/attestation/report?model=&signing_address=, returns the exact body", async () => {
  const body = readFileSync(REPORT, "utf8");
  let seen: { url: string; headers: any } | undefined;
  const f = (async (url: any, init: any) => { seen = { url: String(url), headers: init?.headers ?? {} }; return new Response(body, { status: 200 }); }) as typeof fetch;
  const got = await fetchAttestation("z-ai/glm-5.3", ADDR, f);
  assert.equal(got, body);
  assert.equal(seen!.url, `https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent("z-ai/glm-5.3")}&signing_address=${ADDR}`);
  assert.equal(JSON.stringify(seen!.headers).toLowerCase().includes("authorization"), false);
});

test("fetchAttestation: HTTP error or network failure -> undefined (B4 then SKIPs, never PASSes)", async () => {
  assert.equal(await fetchAttestation("m", ADDR, (async () => new Response("no", { status: 400 })) as typeof fetch), undefined);
  assert.equal(await fetchAttestation("m", ADDR, (async () => { throw new Error("down"); }) as typeof fetch), undefined);
});

test("CLI: --attestation <real report file> is accepted (exit 0 on R3e evidence); missing file exits 2", () => {
  const ok = spawnSync(BIN, ["--evidence-dir", R3E, "--attestation", REPORT], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = spawnSync(BIN, ["--evidence-dir", R3E, "--attestation", "/nonexistent/report.json"], { encoding: "utf8" });
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
});

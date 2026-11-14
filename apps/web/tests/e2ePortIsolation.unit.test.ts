// FE1b: the 'web e2e (mocked)' step must pick a free port per run and never reuse a foreign server.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pick = () => Number(execFileSync("node", ["scripts/free-port.mjs"], { cwd: webDir, encoding: "utf8" }).trim());

test("free-port picker returns a free port, never one a dummy server holds", async () => {
  const srv = http.createServer((_, r) => r.end("x"));
  await new Promise<void>((r) => srv.listen(0, r));
  const busy = (srv.address() as { port: number }).port;
  try {
    const seen = new Set<number>();
    for (let i = 0; i < 5; i++) {
      const p = pick();
      assert.ok(Number.isInteger(p) && p > 1023 && p < 65536, `bad port ${p}`);
      assert.notEqual(p, busy);
      assert.notEqual(p, 3199, "must not be the old fixed default");
      seen.add(p);
    }
    // it is genuinely bindable right now
    const p = [...seen][0];
    const s2 = http.createServer();
    await new Promise<void>((res, rej) => s2.once("error", rej).listen(p, res));
    s2.close();
  } finally {
    srv.close();
  }
});

const reuse = (env: Record<string, string>) =>
  execFileSync(
    "node",
    ["--import", "tsx", "-e", 'import c from "./playwright.config.ts"; console.log(JSON.stringify(c.webServer.reuseExistingServer))'],
    { cwd: webDir, encoding: "utf8", env: { ...process.env, PW_CI: "", ...env } },
  ).trim();

test("playwright config never reuses an existing server under PW_CI", () => {
  assert.equal(reuse({ PW_CI: "1" }), "false");
});
test("playwright config still reuses for local manual runs", () => {
  assert.equal(reuse({}), "true");
});

test("test.sh step uses the picker + PW_CI and no fixed WEB_E2E_PORT default", () => {
  const sh = readFileSync(path.join(webDir, "../../test.sh"), "utf8");
  const line = sh.split("\n").find((l) => l.includes("web e2e (mocked)"))!;
  assert.ok(line.includes("free-port.mjs"), line);
  assert.ok(line.includes("PW_CI=1"), line);
  assert.ok(!/3199|WEB_E2E_PORT/.test(line), line);
});

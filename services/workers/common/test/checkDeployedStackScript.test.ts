// STACK1 RED: scripts/check-deployed-stack.mjs end to end against local stand-in servers: one line per Worker, exit 1 on any FAIL, 0 when all PASS.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(SERVICES, "workers/scripts/check-deployed-stack.mjs");
const ESC = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet";

function serve(handler: (path: string) => { status: number; body: unknown }): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { const r = handler(req.url ?? ""); res.writeHead(r.status, { "content-type": "application/json" }); res.end(JSON.stringify(r.body)); });
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => new Promise((r) => s.close(() => r())) }));
  });
}
const runScript = (args: string[]): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  const p = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], { cwd: SERVICES, env: { ...process.env } });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => resolve({ code: code ?? -1, out }));
});

const NAMES = ["indexer", "keeper", "monitor", "notifier", "relayer", "registry", "sourcecheck", "funding"];
const body = (svc: string, over: Record<string, unknown> = {}) => ({
  ok: true, service: svc, network: "testnet", git_sha: "a1b2c3d",
  ...(svc === "registry" ? { registry_id: "registry.praetorial.testnet" } : { escrow_contract_id: ESC }),
  ...(["indexer", "keeper", "monitor"].includes(svc) ? { last_tick_at: new Date().toISOString() } : {}), ...over,
});
const urlArgs = (base: string) => NAMES.flatMap((n) => ["--url", `${n}=${base}/${n}`]);

test("script: all healthy -> eight PASS lines, exit 0", async () => {
  const s = await serve((p) => ({ status: 200, body: body(p.slice(1)) }));
  try {
    const r = await runScript(["--network", "testnet", ...urlArgs(s.url)]);
    assert.equal(r.code, 0, r.out);
    const lines = r.out.trim().split("\n").filter((l) => /^(PASS|FAIL) /.test(l));
    assert.equal(lines.length, 8, r.out);
    assert.ok(lines.every((l) => l.startsWith("PASS ")));
    for (const n of NAMES) assert.ok(lines.some((l) => l.includes(n)), n);
  } finally { await s.close(); }
});

test("script: one wrong-escrow Worker -> its line is FAIL, seven PASS, exit 1", async () => {
  const s = await serve((p) => ({ status: 200, body: body(p.slice(1), p === "/relayer" ? { escrow_contract_id: "old.testnet" } : {}) }));
  try {
    const r = await runScript(["--network", "testnet", ...urlArgs(s.url)]);
    assert.equal(r.code, 1, r.out);
    const lines = r.out.trim().split("\n").filter((l) => /^(PASS|FAIL) /.test(l));
    assert.equal(lines.filter((l) => l.startsWith("FAIL ")).length, 1, r.out);
    assert.match(lines.find((l) => l.startsWith("FAIL "))!, /relayer/);
  } finally { await s.close(); }
});

test("script: unreachable Worker -> FAIL + exit 1", async () => {
  const s = await serve((p) => ({ status: 200, body: body(p.slice(1)) }));
  try {
    const args = urlArgs(s.url).map((a) => (a.startsWith("sourcecheck=") ? "sourcecheck=http://127.0.0.1:1/x" : a));
    const r = await runScript(["--network", "testnet", ...args]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL .*sourcecheck.*unreachable/);
  } finally { await s.close(); }
});

test("script: a release record path that does not exist is an error (exit 1), not a silent pass", async () => {
  const s = await serve((p) => ({ status: 200, body: body(p.slice(1)) }));
  try {
    const r = await runScript(["--network", "testnet", "--release", "/nonexistent/release.json", ...urlArgs(s.url)]);
    assert.equal(r.code, 1, r.out);
  } finally { await s.close(); }
});

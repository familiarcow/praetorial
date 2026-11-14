// CF1f RED: the node registry suites (registry/test/*.test.ts, unchanged) run against the WORKER handler (D1 store, shared core).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const childEnv = (log: string) => { const e: Record<string, string | undefined> = { ...process.env, REGISTRY_BACKEND: "worker", REGISTRY_BACKEND_LOG: log }; delete e.NODE_TEST_CONTEXT; return e; };
const SERVICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("node registry suites pass unchanged against the Worker backend (REGISTRY_BACKEND=worker), and really hit the Worker", () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cf1f-par-")), "hits.log");
  const files = fs.readdirSync(path.join(SERVICES, "registry/test")).filter((f) => f.endsWith(".test.ts")).map((f) => "registry/test/" + f);
  assert.ok(files.length >= 7, files.join(","));
  const r = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { cwd: SERVICES, encoding: "utf8", env: childEnv(log) });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  assert.equal(r.status, 0, out.slice(-4000));
  const pass = Number(/(?:#|ℹ) pass (\d+)/.exec(out)?.[1] ?? 0), fail = Number(/(?:#|ℹ) fail (\d+)/.exec(out)?.[1] ?? -1);
  assert.equal(fail, 0, out.slice(-1500)); assert.ok(pass >= 40, `only ${pass} passed`);
  const hits = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  assert.ok(hits >= 50, `suites reached the Worker only ${hits} times`);
  console.log(`CF1f-PARITY pass=${pass} worker_hits=${hits}`);
});

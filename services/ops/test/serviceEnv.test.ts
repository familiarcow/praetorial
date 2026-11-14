import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES, COMMON_VARS, heartbeatServices, allKnownVars } from "../src/serviceEnv.js";

const SERVICES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
}

/** Every literal env var name a source file reads. */
function envReads(src: string): Set<string> {
  const out = new Set<string>();
  for (const re of [
    /\benv\.([A-Z][A-Z0-9_]+)/g,
    /\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g,
    /\b(?:required|requireEnv)\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g,
  ]) for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

test("table lists exactly the six long-running services with existing runners", () => {
  assert.deepEqual(SERVICES.map((s) => s.name), ["keeper", "indexer", "notifier", "relayer", "monitor:alerts", "treasury"]);
  for (const s of SERVICES) assert.ok(fs.existsSync(path.join(SERVICES_DIR, s.runner)), `${s.name} runner ${s.runner} missing`);
});

test("MON4 heartbeat services are keeper, relayer, monitor:alerts, notifier", () => {
  assert.deepEqual(heartbeatServices().map((s) => s.name).sort(), ["keeper", "monitor:alerts", "notifier", "relayer"]);
});

test("static: every env var a service's source reads is listed in the table (no unlisted reads)", () => {
  for (const s of SERVICES) {
    const listed = new Set<string>([...s.required, ...s.requiredOneOf.flat(), ...s.optional, ...(s.usesCommon ? COMMON_VARS : [])]);
    const dir = path.join(SERVICES_DIR, path.dirname(s.runner));
    const reads = new Set<string>();
    for (const f of walk(dir)) for (const v of envReads(fs.readFileSync(f, "utf8"))) reads.add(v);
    const missing = [...reads].filter((v) => !listed.has(v));
    assert.deepEqual(missing, [], `${s.name}: source reads env vars not in serviceEnv table: ${missing.join(", ")}`);
  }
});

test("static: every env var common/src reads is in COMMON_VARS", () => {
  const reads = new Set<string>();
  for (const f of walk(path.join(SERVICES_DIR, "common/src"))) {
    const text = fs.readFileSync(f, "utf8");
    for (const v of envReads(text)) reads.add(v);
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) reads.add(m[1]);
  }
  const missing = [...reads].filter((v) => !COMMON_VARS.includes(v));
  assert.deepEqual(missing, []);
});

test("static scanner catches reads (self-test)", () => {
  assert.deepEqual([...envReads('const a = env.FOO_BAR; env.BAZ_1; required("QUX")')].sort(), ["BAZ_1", "FOO_BAR", "QUX"]);
});

test("no duplicate var entries inside one service; allKnownVars is a superset", () => {
  for (const s of SERVICES) {
    const all = [...s.required, ...s.requiredOneOf.flat(), ...s.optional];
    assert.equal(new Set(all).size, all.length, `${s.name} has duplicate var entries`);
    for (const v of all) assert.ok(allKnownVars().has(v));
  }
});

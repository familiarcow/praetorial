// Static guard (queue item 7b): no source file under services/ hardcodes
// a real RPC URL except the shared config module itself. Prevents a
// future change from re-introducing a bespoke nodeUrl/fastnear literal
// instead of going through services/common/src/rpc.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SERVICES_ROOT = path.resolve(import.meta.dirname, "../..");
const ALLOWED_FILES = new Set([path.join(SERVICES_ROOT, "common/src/rpc.ts")]);
const EXCLUDED_DIR_SEGMENTS = new Set(["node_modules", "dist", "test", "tests", "fixtures", "archives", "data"]);
const SOURCE_EXT = new Set([".ts", ".mjs", ".js"]);
// Matches an actual RPC host literal, not just the word "rpc" -- real
// NEAR JSON-RPC endpoints (fastnear, near.org, or any https URL that
// contains "rpc." in its hostname).
const RPC_URL_PATTERN = /https?:\/\/[A-Za-z0-9.-]*rpc[A-Za-z0-9.-]*\.(fastnear\.com|near\.org)/i;

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIR_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

test("no hardcoded RPC URL outside services/common/src/rpc.ts", () => {
  const files: string[] = [];
  walk(SERVICES_ROOT, files);
  const offenders: string[] = [];
  for (const file of files) {
    if (ALLOWED_FILES.has(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    if (RPC_URL_PATTERN.test(content)) {
      offenders.push(path.relative(SERVICES_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `hardcoded RPC URL found outside shared config: ${offenders.join(", ")}`);
});

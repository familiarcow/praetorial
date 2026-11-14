// WKMAIN1b guard: no test under services/**/test/** may be hidden with skip/todo (D-WKMAIN1a).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_FILE = /\.test\.(ts|mjs|js)$/;
function walk(dir: string, inTest: boolean, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, inTest || e.name === "test", out);
    else if (inTest && TEST_FILE.test(e.name)) out.push(p);
  }
}
const HIDDEN = /\bskip\s*:|\.skip\s*\(|\btodo\s*:|\.todo\s*\(/;

test("no node:test call under services/**/test/** is skipped or todo", () => {
  const files: string[] = [];
  walk(SERVICES, false, files);
  assert.ok(files.length > 50, `scan found only ${files.length} test files; the walker is broken`);
  const hits: string[] = [];
  for (const f of files) fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => {
    if (l.trim().startsWith("//")) return;
    if (HIDDEN.test(l)) hits.push(`${path.relative(SERVICES, f)}:${i + 1}`);
  });
  assert.deepEqual(hits, [], `skipped/todo tests found: ${hits.join(", ")}`);
});

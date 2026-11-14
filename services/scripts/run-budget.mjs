// CPUFLAKE1 / D-CPUFLAKE1a: serial runner for every CPU/wall timing-budget test (workers/*/test-budget/*.test.ts).
// One file at a time, one test at a time (--test-concurrency=1), so budgets are measured without our own parallelism.
// Thresholds live in the test files and are never changed here. Exit non-zero if any file fails.
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
for (const w of readdirSync(path.join(SERVICES, "workers"), { withFileTypes: true })) {
  const d = path.join(SERVICES, "workers", w.name, "test-budget");
  if (w.isDirectory() && existsSync(d)) for (const f of readdirSync(d).sort()) if (f.endsWith(".test.ts")) files.push(path.relative(SERVICES, path.join(d, f)));
}
if (files.length === 0) { console.error("no budget files found under workers/*/test-budget"); process.exit(1); }
let failed = 0;
for (const f of files) {
  console.log(`== budget: ${f}`);
  const r = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", "--test", "--test-concurrency=1", f], { cwd: SERVICES, stdio: "inherit" });
  if (r.status !== 0) { failed++; console.log(`BUDGET FAIL: ${f}`); }
}
console.log(`budget files: ${files.length}, failed: ${failed}`);
process.exit(failed ? 1 : 0);

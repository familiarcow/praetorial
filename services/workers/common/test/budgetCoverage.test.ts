// CPUFLAKE1 (D-CPUFLAKE1a): every CPU/wall timing-budget test file must run in exactly one place:
// the serial `budget` step of ./test.sh full (services `npm run test:budget`, files under
// workers/*/test-budget/). None may sit in the parallel `services npm test` glob (they flake under
// load), and none may be in neither (would silently never run).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOT = path.resolve(SERVICES, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(path.relative(SERVICES, p).split(path.sep).join("/"));
  }
  return out;
}
const globToRe = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, "[^/]*") + "$");
const pkg = JSON.parse(fs.readFileSync(path.join(SERVICES, "package.json"), "utf8"));
const npmGlobs = [...(pkg.scripts.test as string).matchAll(/'([^']+)'/g)].map((m) => globToRe(m[1]));
const inNpmTest = (f: string) => npmGlobs.some((r) => r.test(f));
const all = walk(SERVICES);
const isBudgetByName = (f: string) => /(^|\/)[^/]*(cpuBudget|\.budget)[^/]*\.test\.ts$/.test(f) || /\/test-budget\/[^/]+\.test\.ts$/.test(f);
const budgetFiles = all.filter(isBudgetByName);
const stepFiles = all.filter((f) => /^workers\/[^/]+\/test-budget\/[^/]+\.test\.ts$/.test(f));

test("budget files exist and none is in the services npm test glob", () => {
  assert.ok(budgetFiles.length >= 6, `expected >= 6 budget files, got ${budgetFiles.join(", ")}`);
  const leaked = budgetFiles.filter(inNpmTest);
  assert.deepEqual(leaked, [], `timing-budget files still in services npm test: ${leaked.join(", ")}`);
});

test("every budget file is in the full `budget` step (nothing in neither place)", () => {
  const orphan = budgetFiles.filter((f) => !inNpmTest(f) && !stepFiles.includes(f));
  assert.deepEqual(orphan, [], `budget files in neither npm test nor the budget step: ${orphan.join(", ")}`);
  assert.ok(pkg.scripts["test:budget"], "services package.json needs a test:budget script");
  const runner = fs.readFileSync(path.join(SERVICES, "scripts/run-budget.mjs"), "utf8");
  assert.match(runner, /--test-concurrency=1/, "budget runner must be serial");
  assert.match(runner, /test-budget/, "runner must discover workers/*/test-budget");
});

test("no timing-assertion file hides in the npm test glob under another name", () => {
  const hidden = all.filter((f) => inNpmTest(f) && /\.test\.ts$/.test(f) && f !== "workers/common/test/cpuBench.test.ts" && f !== "workers/common/test/budgetCoverage.test.ts")
    .filter((f) => /threadCpuUsage|cpuDeltaMs|medianOfBatchP99|minOfBatchP99|BUDGET_MS/.test(fs.readFileSync(path.join(SERVICES, f), "utf8")));
  assert.deepEqual(hidden, [], `timing-budget assertions in the parallel glob: ${hidden.join(", ")}`);
});

test("test.sh wires the serial budget step into full and fast prints the not-run line", () => {
  const sh = fs.readFileSync(path.join(ROOT, "test.sh"), "utf8");
  assert.match(sh, /run_budget\(\)/);
  assert.match(sh, /run_step "budget[^"]*"[^\n]*test:budget/);
  assert.match(sh, /run_full\(\) \{[\s\S]*?run_budget/);
  assert.match(sh, /budget files not run in fast[^\n]*\.\/test\.sh full/);
});

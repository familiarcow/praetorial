// PUB1 (HK1 item 9): `./test.sh fast` must leave the git tree clean. A mocked e2e spec may write screenshots into a
// TRACKED folder (spikes/<lane>/shots, docs/screens) only behind an explicit opt-in env var (F4_SHOTS=1, F5_SHOTS=1,
// A1_SHOTS=1, TPL3_SHOTS=1, or screenPath's UPDATE_SCREENS=1); the default goes to gitignored test-results/.
// tpl3-ai-bet.spec.ts used to rewrite spikes/tpl3/shots on every run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = fileURLToPath(new URL(".", import.meta.url));
const specs = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? specs(join(d, e.name)) : e.name.endsWith(".spec.ts") ? [join(d, e.name)] : []);

test("no mocked e2e spec writes into a tracked spikes/*/shots folder unless an opt-in *_SHOTS=1 env var is set", () => {
  const files = specs(TESTS);
  assert.ok(files.length > 20, `found ${files.length} specs`);
  const bad: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((l, i) => {
      if (/^\s*\/\//.test(l)) return;
      if (/spikes\/[^"'`\s]+\/shots/.test(l) && !/process\.env\.[A-Z0-9_]+_SHOTS === "1"/.test(l)) bad.push(`${relative(TESTS, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

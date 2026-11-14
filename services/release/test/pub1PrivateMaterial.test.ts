// PUB1 (GATE-10 "kept" rows): the public tree names no operator path (the operator's config dir or macOS home) and no
// private design-note title. Executable scripts read operator dirs from PRAETORIAL_SECRETS_DIR / PRAETORIAL_CACHE_DIR;
// docs and committed run outputs use placeholders (<repo>, $HOME, $PRAETORIAL_SECRETS_DIR, $PRAETORIAL_CACHE_DIR).
// Out of scope (documented kept rows, spikes/pub1/REPORT.md): frozen release-covered contracts/** and resolver/**,
// agent task records (spikes/*/PROMPT*.md, agent*.log) and HK1's landed record spikes/hk1/**.
// Patterns are built from parts so this file does not match itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATTERNS: [string, RegExp][] = [
  ["operator config dir", new RegExp("\\." + "hermes\\b")],
  ["operator home path", new RegExp("/Users/" + "familiarcow\\b")],
  ["note vault", new RegExp("Hermes" + " Vault|~/" + "Documents/")],
  ["design-note title", new RegExp("MASTER" + " MAP|Praetorial" + " - [A-Z]|Praetorial" + " spec/")],
];
const OUT_OF_SCOPE = [/^contracts\//, /^resolver\//, /^spikes\/hk1\//, /^spikes\/[^/]+\/PROMPT[^/]*\.md$/, /(^|\/)agent[^/]*\.log$/];

function trackedTextFiles(): string[] {
  const r = spawnSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\0").filter((f) => f && !OUT_OF_SCOPE.some((rx) => rx.test(f)));
}

test("PUB1: no tracked file (outside the documented kept rows) names an operator path or a private note title", () => {
  const files = trackedTextFiles();
  assert.ok(files.length > 1000, `only ${files.length} tracked files found`);
  const hits: string[] = [];
  for (const f of files) {
    let buf: Buffer;
    try { buf = readFileSync(join(ROOT, f)); } catch { continue; } // deleted in the working tree
    if (buf.includes(0)) continue; // binary (screenshots, wasm)
    buf.toString("utf8").split("\n").forEach((line, i) => {
      for (const [what, rx] of PATTERNS) if (rx.test(line)) hits.push(`${f}:${i + 1} ${what}`);
    });
  }
  assert.deepEqual(hits, [], `${hits.length} hits:\n${hits.slice(0, 80).join("\n")}`);
});

test("PUB1: tests/conformance/run.sh never prints a private note title (its pass AND fail summaries)", () => {
  const src = readFileSync(join(ROOT, "tests/conformance/run.sh"), "utf8");
  const printed = src.split("\n").filter((l) => /^\s*(echo|printf)\b/.test(l));
  assert.ok(printed.length > 5, "run.sh summary lines found");
  for (const l of printed) for (const [what, rx] of PATTERNS) assert.doesNotMatch(l, rx, `${what}: ${l.trim()}`);
});

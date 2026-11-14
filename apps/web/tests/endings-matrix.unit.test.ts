// WEBE2E1: every ending has a journey. Greps the spec file text for the exact test title; no ending can silently lose its journey.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ENDINGS } from "./fixtures/endings";

const here = dirname(fileURLToPath(import.meta.url));
const EXPECTED = ["ai-yes", "ai-no", "ai-void", "ai-challenged", "concede", "referee-yes", "referee-silent", "emergency"];

test("the ENDINGS list is exactly the 8 endings, ids unique", () => {
  assert.deepEqual(ENDINGS.map((e) => e.id).sort(), [...EXPECTED].sort());
});

for (const e of ENDINGS) {
  test(`ending ${e.id} maps to an existing test title in an existing spec file`, () => {
    const file = join(here, e.spec);
    assert.ok(existsSync(file), `${e.id}: spec file ${e.spec} is missing`);
    const text = readFileSync(file, "utf8");
    assert.ok(/\.spec\.ts$/.test(e.spec), `${e.id}: not a Playwright spec`);
    const re = new RegExp(`\\btest\\(\\s*(["'\`])${e.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`);
    assert.ok(re.test(text), `${e.id}: no test("${e.title}") in ${e.spec}`);
  });
}

test("each journey title is unique and no journey is skipped, fixme'd or .only", () => {
  assert.equal(new Set(ENDINGS.map((e) => e.title)).size, ENDINGS.length);
  for (const spec of new Set(ENDINGS.map((e) => e.spec))) {
    const p = join(here, spec);
    if (!existsSync(p)) continue;
    assert.ok(!/\b(test|describe)\.(skip|fixme|only)\b/.test(readFileSync(p, "utf8")), `${spec} has skip/fixme/only`);
  }
});

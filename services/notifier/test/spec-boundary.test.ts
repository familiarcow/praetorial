// SPEC: offchain services and surfaces spec v0 §4 Notifier,
// "Onchain calls it makes" — "**None.** Pure read (event subscription) +
// offchain send. Zero signing key for chain purposes." Also §0 ground
// rule: "None of them hold a key that can move user funds or sign an
// outcome."
//
// This is a static-analysis test, not a behavioural one: it asserts the
// notifier's own source never imports a signing client at all, so the
// boundary can't regress by someone adding a "just one" contract call
// later without this test going red first.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcFiles = ["../src/notifier.ts", "../src/runner.ts"].map((p) => path.join(here, p));

test("notifier source never imports NearClient (no signing capability at all)", () => {
  for (const f of srcFiles) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(
      !text.includes("NearClient") || f.endsWith("runner.ts"),
      `${f} must not import a signing client`,
    );
  }
});

test("notifier.ts (the pure logic module) makes zero contract calls", () => {
  const text = fs.readFileSync(srcFiles[0], "utf8");
  assert.ok(!text.includes(".call("), "notifier.ts must never call a contract method");
  assert.ok(!text.includes(".callPayable("), "notifier.ts must never attach NEAR to a call");
  assert.ok(!text.includes("near-api-js"), "notifier.ts must not depend on the signing client lib at all");
});

// WT1 (1)+(2): the web form's typed templates lint exactly like the resolver (shared fixtures), and the
// web terms_hash equals the resolver/services hash for every fixture sheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lintTemplate, problemCode, canonicalTerms, termsHash, buildTypedSheet, assertTemplateOk, TemplateRefusedError, LAUNCH_TEMPLATES } from "../lib/templates";

const here = dirname(fileURLToPath(import.meta.url));
const cases: Array<{ name: string; codes: string[]; ts: any }> = JSON.parse(
  readFileSync(join(here, "../../../resolver/core/tests/fixtures/template_cases.json"), "utf8"),
);
const isTypedOrBroken = (ts: any) =>
  ts && typeof ts === "object" && "template" in ts && !(ts.template?.id === "custom" && ts.template?.version === 1 && Object.keys(ts.template).length === 2);

test("fixtures: web lintTemplate returns the resolver's ordered TPL_* codes for every templated case", () => {
  const typed = cases.filter((c) => isTypedOrBroken(c.ts));
  assert.ok(typed.length >= 20, "expected the shared fixtures to carry >= 20 templated cases");
  for (const c of typed) {
    assert.deepEqual(lintTemplate(c.ts).map(problemCode), c.codes, c.name);
  }
});

test("fixtures: the 4 launch types are all accepted as-is (btc_close_ok, btc_touch_ok, game_ok, nws_ok)", () => {
  for (const n of ["btc_close_ok", "btc_touch_ok", "game_ok", "nws_ok"]) {
    const c = cases.find((x) => x.name === n)!;
    assert.deepEqual(lintTemplate(c.ts), [], n);
    assert.ok(LAUNCH_TEMPLATES.includes(c.ts.template.id));
    // emitting exactly the template JSON: rebuilding from id+fields yields the identical sheet
    assert.deepEqual(buildTypedSheet(c.ts.template.id, c.ts.fields), c.ts, n);
  }
});

test("a sheet the resolver rejects is refused in the form with the same named error", () => {
  const c = cases.find((x) => x.name === "close_x_fraction")!;
  assert.throws(
    () => assertTemplateOk(c.ts),
    (e: any) => e instanceof TemplateRefusedError && e.message.startsWith("TPL_X_USD_NOT_WHOLE:"),
  );
  const g = cases.find((x) => x.name === "game_name_only_pick")!;
  assert.throws(() => assertTemplateOk(g.ts), (e: any) => e.message.startsWith("TPL_PICK_NO_TEAM_ID:"));
});

test("terms_hash: web hash == node crypto (services/common sha256Hex) == shasum (resolver sha_hex) for every fixture sheet", () => {
  for (const c of cases) {
    const terms = canonicalTerms(c.ts);
    const web = termsHash(terms);
    const svc = createHash("sha256").update(terms, "utf8").digest("hex");
    const cli = execFileSync("shasum", ["-a", "256"], { input: terms }).toString().split(" ")[0];
    assert.equal(web, svc, c.name);
    assert.equal(web, cli, c.name);
  }
});

test("canonicalTerms is key-order independent and stable", () => {
  assert.equal(canonicalTerms({ b: 1, a: { d: 1, c: [2, { z: 1, y: 2 }] } }), '{"a":{"c":[2,{"y":2,"z":1}],"d":1},"b":1}');
});

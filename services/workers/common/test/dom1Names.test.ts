// DOM1 (familiarcow 11-13: "All name references should just be familiarcow."): no personal name in tracked files. Allowed:
//  - .queue/ (internal, never published);
//  - contracts/** and resolver/** (frozen by release records; comments only, listed in spikes/dom1/REPORT.md);
//  - the legacy mainnet workers.dev web origin, ONLY on a line marked TODO-REMOVE (kept in CORS until the praetorial.com cutover is
//    confirmed; it is the live Cloudflare account subdomain, not prose).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const NAME = ["ty", "ler|", "bond", "95"].join(""); // built at runtime so this file does not match itself

test("DOM1: git grep finds no personal name outside .queue/, contracts/, resolver/ and TODO-REMOVE legacy-origin lines", () => {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-n", "-I", "-i", "-E", NAME, "--", ".", ":!.queue", ":!contracts", ":!resolver"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e: any) {
    if (e.status === 1) out = ""; // git grep: no match
    else throw e;
  }
  const bad = out.split("\n").filter(Boolean).filter((l) => !/TODO-REMOVE/.test(l));
  assert.deepEqual(bad.slice(0, 40), [], `${bad.length} line(s) still name a person`);
});

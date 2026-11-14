// MISS1: every live-DR scenario's offline tests run in `services npm test` (./test.sh fast). A salvaged or new DR dir
// whose test/ folder is not in the package.json glob would sit unrun and rot silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIVE_DR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICES = path.resolve(LIVE_DR, "../..");

test("every live-DR/<dir>/test folder is in the services npm test glob", () => {
  const script: string = JSON.parse(fs.readFileSync(path.join(SERVICES, "package.json"), "utf8")).scripts.test;
  const dirs = fs.readdirSync(LIVE_DR).filter((d) => fs.existsSync(path.join(LIVE_DR, d, "test")));
  assert.ok(dirs.includes("harness") && dirs.includes("DR1"), `found ${dirs}`);
  const missing = dirs.filter((d) => !script.includes(`'e2e/live-DR/${d}/test/**/*.test.ts'`));
  assert.deepEqual(missing, []);
});

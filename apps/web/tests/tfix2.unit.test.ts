// TFIX2 (familiarcow, mainnet bet #1, 2026-11-13): a render error right after a successful take blanked the whole app (React unmounts the
// root, the theme's CSS variables go with it, the page is plain white). The top-level CrashBoundary (src/CrashBoundary.tsx) must turn
// ANY render error into "Something went wrong. Reload" with a Reload button and, on a bet page, the bet's link; the error is logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CRASH_COPY, crashBetLink, crashLogLine } from "../lib/crashScreen";
import { REFUSED_SEAMS } from "../scripts/mainnetDeployGuard";
import { createChainClock } from "../lib/chainClock";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

test("crash screen copy: one plain sentence and a Reload button", () => {
  assert.equal(CRASH_COPY.title, "Something went wrong. Reload");
  assert.equal(CRASH_COPY.reload, "Reload");
  assert.match(CRASH_COPY.body, /money/i); // says what happened to the user's money (nothing is undone by a display error)
});

test("crashBetLink: on a bet page the bet's own link (query kept, so an invite still works); elsewhere none", () => {
  assert.deepEqual(crashBetLink("/bet/1", ""), { href: "/bet/1", label: "Open bet #1" });
  assert.deepEqual(crashBetLink("/bet/42", "?invite=ab12"), { href: "/bet/42?invite=ab12", label: "Open bet #42" });
  assert.deepEqual(crashBetLink("/bet/7/", ""), { href: "/bet/7", label: "Open bet #7" });
  assert.equal(crashBetLink("/", ""), null);
  assert.equal(crashBetLink("/account", "?asset=NEAR"), null);
  assert.equal(crashBetLink("/bet/abc", ""), null);
});

test("crashLogLine: the error's message and React's component stack in one console line", () => {
  const line = crashLogLine(new TypeError("x is undefined"), "\n    at BetPage\n    at App");
  assert.match(line, /^\[praetorial\] render crashed: TypeError: x is undefined/);
  assert.match(line, /at BetPage/);
  assert.equal(crashLogLine("boom", undefined), "[praetorial] render crashed: boom");
});

test("main.tsx: the CrashBoundary is the OUTERMOST element (it also catches errors in Privy, the theme and the toasts)", () => {
  const src = readFileSync(join(web, "src", "main.tsx"), "utf8");
  const render = src.slice(src.lastIndexOf("root.render("));
  assert.match(render, /^root\.render\(\s*<CrashBoundary>\s*<PrivyProvider/);
  assert.match(src, /import \{ CrashBoundary \} from "\.\/CrashBoundary"/);
});

test("the forced-crash e2e seam is refused by the mainnet deploy guard like every other seam", () => {
  assert.ok(REFUSED_SEAMS.includes("__e2eRenderCrash"));
});

// ---- the root cause: the chain clock had a fraction, BetPage did BigInt(nowMs) -> RangeError mid-take -> React unmounted the app ----
test("ROOT CAUSE: chainClock.nowMs() is whole milliseconds even though performance.now() has a fraction", async () => {
  let mono = 1234.567;
  const c = createChainClock({ readBlockMs: async () => 1_794_610_625_000, perfNow: () => mono });
  await c.sync();
  mono += 1001.86; // Chromium's performance.now() is sub-millisecond
  const now = c.nowMs()!;
  assert.equal(Number.isInteger(now), true, `nowMs() = ${now}`);
  assert.equal(now, 1_794_610_626_001);
  assert.doesNotThrow(() => BigInt(now) * 1_000_000n); // exactly what BetPage's take check does every second
  assert.equal(Number.isInteger((await c.ensure(60_000))!), true);
});

test("BetPage turns its clock into ns only through a whole number (BigInt of a fractional ms throws a RangeError)", () => {
  const src = readFileSync(join(web, "src", "components", "BetPage.tsx"), "utf8");
  assert.equal(/BigInt\(nowMs\)/.test(src), false, "BigInt(nowMs) must be BigInt(Math.floor(nowMs))");
  assert.match(src, /BigInt\(Math\.floor\(nowMs\)\) \* 1_000_000n/);
});

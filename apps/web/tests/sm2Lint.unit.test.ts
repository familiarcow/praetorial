// SM2 lint: a screen never reads Privy, the username registry, the contract's paused/shutdown flags, connectivity or a raw bet
// status to decide what to show or enable. It asks lib/appState (useGate / GateNotice from src/kit/Gate.tsx) for the cross-machine
// gates and lib/betView (+ betLifecycle / takeView) for the bet phase. Rules: spikes/sm2/STATES.md §Rules.
//
// ROOTS may read the sources (they BUILD the state the screens read). OFFENDERS is today's debt: every entry is tagged with the UI
// task that removes it. The test fails when (a) a file not listed starts reading a source, (b) a listed file reads it MORE often,
// or (c) a listed file stopped (delete its entry, so the debt only shrinks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

export const RULES = {
  privy: /\busePrivy\(|\buseWallets\(|\buseLoginWithEmail\(|from "@privy-io\//g,
  registry: /\bHttpUserRegistry\b|\.byAccount\(/g,
  "contract-flags": /\buseContractStatus\(/g,
  connectivity: /\buseOnline\(|navigator\.onLine/g,
  "bet-status": /\.status\s*(?:===|!==)\s*"[A-Z][A-Za-z]*"|switch\s*\(\s*[\w.]*\.status\s*\)/g,
} as const;
type Rule = keyof typeof RULES;

/** Composition roots: they turn the sources into AppCtx / the login machine itself. */
const ROOTS = new Set([
  "App.tsx", // builds AppCtx (authStateOf / accountStateOf / contract + liveState) and the fixes; owns the username lookup
  "kit/Gate.tsx", // the UI end of lib/appState
  "main.tsx", // mounts PrivyProvider
  "components/Login.tsx", // the Privy email/OTP form IS the login machine (A1 restyles it, it keeps driving Privy)
]);

type Task = "B1" | "V1" | "F3" | "F4" | "H1" | "C1" | "M1" | "A1" | "F5";
// C1 (web/c1): CreateOffer's copied-referee lookup moved to lib/createFlow copiedRefereeName; the list is now empty.
const OFFENDERS: Record<string, Partial<Record<Rule, { count: number; task: Task; why: string }>>> = {};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|jsx?)$/.test(n) ? [p] : [];
  });
}
/** Comments are not code: a rule mentioned in a comment is not a read. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function scan(): Map<string, Partial<Record<Rule, number>>> {
  const out = new Map<string, Partial<Record<Rule, number>>>();
  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    if (ROOTS.has(rel)) continue;
    const code = stripComments(readFileSync(f, "utf8"));
    for (const [rule, re] of Object.entries(RULES) as [Rule, RegExp][]) {
      const n = code.match(re)?.length ?? 0;
      if (n) out.set(rel, { ...(out.get(rel) ?? {}), [rule]: n });
    }
  }
  return out;
}

test("SM2 lint: no new screen reads Privy / registry / contract flags / connectivity / raw bet status to decide what to show", () => {
  const found = scan();
  const errors: string[] = [];
  for (const [file, rules] of found) {
    for (const [rule, n] of Object.entries(rules) as [Rule, number][]) {
      const allowed = OFFENDERS[file]?.[rule];
      if (!allowed) errors.push(`${file}: reads ${rule} (${n}x). Use useGate/GateNotice (lib/appState) or betView instead (spikes/sm2/STATES.md).`);
      else if (n > allowed.count) errors.push(`${file}: reads ${rule} ${n}x, allow-list says ${allowed.count} (${allowed.task} removes these; don't add more).`);
    }
  }
  for (const [file, rules] of Object.entries(OFFENDERS)) {
    for (const [rule, a] of Object.entries(rules) as [Rule, { count: number; task: Task }][]) {
      const n = found.get(file)?.[rule] ?? 0;
      if (n < a.count) errors.push(`${file}: ${rule} allow-list says ${a.count}, found ${n}. Lower it (${a.task} is paying the debt down).`);
    }
  }
  assert.deepEqual(errors, []);
});

test("SM2 lint: the rules catch what they claim to (a planted offender is reported)", () => {
  const sample = `const { authenticated } = usePrivy(); const r = new HttpUserRegistry(u); r.byAccount(a);
    const { paused } = useContractStatus(); const on = useOnline(); if (bet.status === "Open") {} switch (b.status) {}
    // usePrivy( in a comment is fine`;
  const code = stripComments(sample);
  const counts = Object.fromEntries(Object.entries(RULES).map(([k, re]) => [k, code.match(re)?.length ?? 0]));
  assert.deepEqual(counts, { privy: 1, registry: 2, "contract-flags": 1, connectivity: 1, "bet-status": 2 });
});

test("SM2 lint: every allow-listed offender names the UI task that removes it", () => {
  const tasks = new Set(["B1", "V1", "F3", "F4", "H1", "C1", "M1", "A1", "F5"]);
  for (const [file, rules] of Object.entries(OFFENDERS)) for (const [rule, a] of Object.entries(rules)) {
    assert.ok(a && tasks.has(a.task) && a.why.length > 10, `${file} ${rule}`);
  }
});

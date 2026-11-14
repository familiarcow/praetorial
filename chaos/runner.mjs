// Scenario runner: each scenario is (name, family, fn(ctx)) -> result
// object logged to chaos/results/log.jsonl. fn throws on hard failure;
// returns {verdict, notes, violations} on a completed run (pass or break).
import * as h from "./harness.mjs";
import { appendResult } from "./harness.mjs";
import path from "node:path";

const LOG_FILE = path.resolve(import.meta.dirname, "results/log.jsonl");
const DEFAULT_TIMEOUT_MS = 120_000;

export async function runScenario(family, name, fn, opts = {}) {
  // --family/--scenario filters (set by run.mjs via env before the
  // family module is invoked) skip without ever booting a sandbox.
  if (process.env.CHAOS_FAMILY_FILTER && process.env.CHAOS_FAMILY_FILTER !== family) return undefined;
  if (process.env.CHAOS_SCENARIO_FILTER && process.env.CHAOS_SCENARIO_FILTER !== name) return undefined;

  // Per-scenario timeout override (opts.timeoutMs): a handful of
  // scenarios legitimately need to fast-forward the sandbox chain past
  // the contract's real settlement_period/round-window (1h, sometimes
  // 24h), which costs real wall-clock time proportional to the number
  // of blocks produced (~8.5ms/block measured against this harness's
  // sandbox-launcher) -- that alone can exceed the 120s default. This
  // is a liveness budget for the TEST HARNESS only; it does not touch
  // any production timing constant in the contract.
  const timeoutMs = Number(opts.timeoutMs || process.env.CHAOS_SCENARIO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const ctx = await h.setupSandbox();
  const started = Date.now();
  let record;
  let timer;
  try {
    const result = await Promise.race([
      fn(ctx),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    record = {
      ts: new Date().toISOString(),
      family,
      name,
      verdict: result.verdict, // "pass" | "break" | "error"
      expected: result.expected,
      actual: result.actual,
      violations: result.violations ?? [],
      notes: result.notes ?? "",
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = /^TIMEOUT after/.test(err?.message ?? "");
    record = {
      ts: new Date().toISOString(),
      family,
      name,
      verdict: isTimeout ? "timeout" : "error",
      expected: "scenario ran to completion",
      actual: `threw: ${err?.message ?? err}`,
      violations: [],
      notes: err?.stack?.split("\n").slice(0, 5).join(" | ") ?? "",
      duration_ms: Date.now() - started,
    };
  } finally {
    await ctx.teardown().catch(() => {});
  }
  appendResult(LOG_FILE, record);
  const tag = record.verdict === "pass" ? "PASS" : record.verdict === "break" ? "BREAK" : record.verdict === "timeout" ? "TIMEOUT" : "ERROR";
  console.log(`[${tag}] ${family}/${name}${record.violations.length ? ` (${record.violations.length} invariant violations)` : ""}`);
  if (record.violations.length) {
    for (const v of record.violations) console.log("    violation:", JSON.stringify(v));
  }
  if (record.verdict !== "pass") console.log("    expected:", record.expected, "| actual:", record.actual);
  return record;
}

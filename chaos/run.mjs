#!/usr/bin/env node
// Single chaos entry point: node chaos/run.mjs [--family X] [--scenario Y] [--parallel N]
//
// Sweeps stale near-sandbox/sandbox-launcher processes ONCE up front (never
// mid-run -- that would kill sibling sandboxes of families running in
// parallel), then runs each requested family's scenarios.mjs run()
// function, with up to --parallel (default 3) families running their own
// sandbox concurrently. --family/--scenario filters are threaded through
// as env vars that runner.mjs's runScenario checks before booting a
// sandbox, so filtering is cheap and needs no changes to scenario files.
import path from "node:path";
import fs from "node:fs";
import { staleSweep } from "./harness.mjs";

const FAMILIES = {
  adversarial: "./scenarios/adversarial.mjs",
  d_audit8: "./scenarios/d_audit8_multi_round.mjs",
  d2: "./scenarios/d2_exhibit_timestamp.mjs",
  d3: "./scenarios/d3_rejudge_round_funding.mjs",
  d5: "./scenarios/d5_keeper_scoped_key.mjs",
  drain_payouts: "./scenarios/drain_payouts.mjs",
  economic: "./scenarios/economic.mjs",
  infra: "./scenarios/infra.mjs",
  time: "./scenarios/time.mjs",
  cross_asset_bond: "./scenarios/cross_asset_bond.mjs",
};

function parseArgs(argv) {
  const out = { parallel: 3 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--family") out.family = argv[++i];
    else if (argv[i] === "--scenario") out.scenario = argv[++i];
    else if (argv[i] === "--parallel") out.parallel = Number(argv[++i]);
  }
  return out;
}

async function runWithLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const families = args.family ? [args.family] : Object.keys(FAMILIES);
  for (const f of families) {
    if (!FAMILIES[f]) {
      console.error(`unknown family: ${f}. known: ${Object.keys(FAMILIES).join(", ")}`);
      process.exit(2);
    }
  }

  console.log(`[chaos] sweeping stale sandbox processes...`);
  staleSweep();

  if (args.scenario) process.env.CHAOS_SCENARIO_FILTER = args.scenario;

  const startedAll = Date.now();
  const outcomes = await runWithLimit(families, args.parallel, async (family) => {
    const started = Date.now();
    try {
      const mod = await import(FAMILIES[family]);
      await mod.run();
      return { family, ok: true, duration_s: (Date.now() - started) / 1000 };
    } catch (err) {
      return { family, ok: false, duration_s: (Date.now() - started) / 1000, error: err?.message ?? String(err) };
    }
  });

  // Collect this run's records from the shared log (everything written
  // since startedAll) rather than threading return values through, since
  // runScenario already appends a structured record per scenario.
  const LOG_FILE = path.resolve(import.meta.dirname, "results/log.jsonl");
  const lines = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean) : [];
  // Filter by family AND timestamp: two run.mjs invocations sharing this
  // log file concurrently (e.g. manual parallel testing) must not pick up
  // each other's records just because they overlap in time.
  const requestedFamilies = new Set(families);
  const records = lines
    .map((l) => JSON.parse(l))
    .filter((r) => new Date(r.ts).getTime() >= startedAll - 1000 && requestedFamilies.has(r.family));

  const resultsDir = path.resolve(import.meta.dirname, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const totalDuration = (Date.now() - startedAll) / 1000;
  fs.writeFileSync(
    path.join(resultsDir, "latest.json"),
    JSON.stringify({ ranAt: new Date(startedAll).toISOString(), totalDurationSeconds: totalDuration, families: outcomes, scenarios: records }, null, 2),
  );

  console.log(`\n[chaos] ${records.length} scenario(s) in ${totalDuration.toFixed(1)}s`);
  console.log("scenario".padEnd(45), "verdict".padEnd(10), "seconds");
  let anyRed = false;
  for (const r of records) {
    const sec = (r.duration_ms / 1000).toFixed(1);
    const verdict = r.verdict.toUpperCase();
    if (verdict !== "PASS") anyRed = true;
    console.log(`${r.family}/${r.name}`.padEnd(45), verdict.padEnd(10), sec);
  }
  for (const o of outcomes) {
    if (!o.ok) {
      anyRed = true;
      console.log(`${o.family} (family crashed)`.padEnd(45), "ERROR".padEnd(10), o.duration_s.toFixed(1));
    }
  }
  process.exit(anyRed ? 1 : 0);
}

main();

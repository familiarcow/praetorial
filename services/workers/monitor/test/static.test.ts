// CF1c RED: static guarantees for the monitor Worker bundle and config (same checks as the relayer's static test).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SERVICES, COMMON_VARS } from "../../../ops/src/serviceEnv.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MON = path.resolve(HERE, "..");
const COMMON = path.resolve(HERE, "../../common/src");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === "test" || e.name === "test-budget" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
const entry = path.join(MON, "src/index.ts");

test("worker bundle: no node:* / fs / sqlite / crypto / Buffer / process.env / near-api-js at runtime", async () => {
  const r = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, logLevel: "silent" });
  const out = r.outputFiles[0].text;
  for (const bad of [/\bnode:/, /require\(["'](fs|path|os|crypto|child_process|net|http)["']\)/, /from ["'](fs|path|os|crypto)["']/, /\bnode:sqlite\b/, /DatabaseSync/, /readFileSync|writeFileSync|appendFileSync/, /\bBuffer\b/, /process\.env/, /process\.on\(/]) {
    assert.ok(!bad.test(out), `bundle matches forbidden ${bad}`);
  }
  for (const input of Object.keys(r.metafile.inputs)) assert.ok(!/near-api-js|@near-js|node_modules\/borsh|tweetnacl/.test(input), `bundle pulls ${input}`);
  assert.ok(out.length < 1_000_000, "bundle unexpectedly large");
});

test("worker sources never import node builtins; the alert logic is the node monitor's (shared cores, no fork)", () => {
  for (const f of [...walk(MON), ...walk(COMMON)]) {
    const t = fs.readFileSync(f, "utf8");
    assert.ok(!/from ["']node:/.test(t) && !/from ["'](fs|path|os|crypto)["']/.test(t), `${f} imports a node builtin`);
  }
  const idx = fs.readFileSync(path.join(MON, "src/index.ts"), "utf8");
  for (const m of [/monitor\/src\/runnerCore/, /monitor\/src\/invariants/, /monitor\/src\/snapshot/, /monitor\/src\/storageHeadroom/, /monitor\/src\/relayerBudget/, /monitor\/src\/opsAlertsCore/, /monitor\/src\/stuckPayouts/]) assert.match(idx, m);
  const node = fs.readFileSync(path.resolve(HERE, "../../../monitor/src/runner.ts"), "utf8");
  assert.match(node, /from "\.\/runnerCore\.js"/, "node runner re-uses the same runAlertTick");
  assert.ok(!fs.existsSync(path.join(MON, "src/alerts.ts")) && !fs.existsSync(path.join(MON, "src/runner.ts")), "no forked alert logic in the Worker");
});

test("every env var the monitor worker reads is in the monitor:alerts serviceEnv row", () => {
  const row = SERVICES.find((s) => s.name === "monitor:alerts")!;
  const listed = new Set([...row.required, ...row.requiredOneOf.flat(), ...row.optional, ...COMMON_VARS]);
  const reads = new Set<string>();
  for (const f of walk(MON)) for (const m of fs.readFileSync(f, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) reads.add(m[1]);
  const toml = fs.readFileSync(path.join(MON, "wrangler.toml"), "utf8");
  for (const m of toml.matchAll(/\[\[durable_objects\.bindings\]\]\s*name\s*=\s*"([A-Z_]+)"/g)) reads.delete(m[1]);
  assert.ok(reads.size > 8, "scanner found too few env reads (self-check)");
  const missing = [...reads].filter((v) => !listed.has(v));
  assert.deepEqual(missing, [], `worker reads vars not in serviceEnv: ${missing.join(", ")}`);
  for (const must of ["MONITOR_RPC_PER_SEC", "MONITOR_MIN_TICK_INTERVAL_MS", "MONITOR_BATCH_BETS", "MONITOR_SERVICE", "ALERT_TELEGRAM_BOT_TOKEN"]) assert.ok(listed.has(must), `${must} not listed`);
});

test("wrangler.toml: no secrets, NO cron of its own, DO + sqlite migration, private (workers_dev=false)", () => {
  const t = fs.readFileSync(path.join(MON, "wrangler.toml"), "utf8");
  for (const re of [/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/, /\d{6,}:[A-Za-z0-9_-]{30,}/, /sk-[A-Za-z0-9]{16,}/, /private_key/i, /PRIVATE KEY/, /BOT_TOKEN\s*=\s*"[^"]{8,}/]) assert.ok(!re.test(t), `wrangler.toml matches ${re}`);
  assert.ok(![...t.matchAll(/crons\s*=/g)].length, "monitor Worker must not add a cron trigger");
  assert.ok(!/^\s*\[triggers\]/m.test(t));
  assert.match(t, /new_sqlite_classes\s*=\s*\["MonitorDO"\]/);
  assert.match(t, /name\s*=\s*"MONITOR"/);
  assert.match(t, /workers_dev\s*=\s*false/);
  assert.match(t, /compatibility_date/);
  assert.ok(!/node_compat|nodejs_compat/.test(t), "no node compat flag");
});

test("README documents testnet deploy: token via env only, secrets via wrangler secret put, dispatcher + CPU", () => {
  const t = fs.readFileSync(path.join(MON, "README.md"), "utf8");
  assert.match(t, /CLOUDFLARE_API_TOKEN/);
  assert.match(t, /wrangler secret put ALERT_TELEGRAM_BOT_TOKEN/);
  assert.match(t, /dispatcher/i);
  assert.match(t, /MONITOR_SERVICE/);
  assert.match(t, /5 ms|CPU/);
  assert.match(t, /testnet/i);
});

test("the keeper's shared dispatcher registers monitor-tick; keeper wrangler.toml keeps exactly one cron and binds MONITOR_SERVICE", async () => {
  const { JOBS } = await import("../../keeper/src/index.js");
  assert.ok(JOBS.some((j: any) => j.name === "monitor-tick"), JOBS.map((j: any) => j.name).join(","));
  const t = fs.readFileSync(path.resolve(HERE, "../../keeper/wrangler.toml"), "utf8").split(/^\[\[?env\.mainnet/m)[0] /* WKMAIN1: testnet (top-level) config only; mainnet is covered in common/test/deployConfig.test.ts */;
  const crons = [...t.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.equal(crons.length, 1);
  assert.match(t, /binding\s*=\s*"MONITOR_SERVICE"/);
});

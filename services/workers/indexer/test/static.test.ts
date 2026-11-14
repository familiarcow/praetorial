// CF1d RED: static guarantees for the indexer Worker bundle and config (same checks as the monitor/notifier static tests),
// the host-neutral splits that keep the node indexer unchanged, the dispatcher registration and the D1 schema file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SERVICES, COMMON_VARS } from "../../../ops/src/serviceEnv.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDX = path.resolve(HERE, "..");
const SVC = path.resolve(HERE, "../../..");
const COMMON = path.resolve(HERE, "../../common/src");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === "test" || e.name === "test-budget" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
const entry = path.join(IDX, "src/index.ts");

test("worker bundle: no node:* / fs / sqlite / crypto / Buffer / process.env / near-api-js at runtime", async () => {
  const r = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, logLevel: "silent" });
  const out = r.outputFiles[0].text;
  for (const bad of [/\bnode:/, /require\(["'](fs|path|os|crypto|child_process|net|http)["']\)/, /from ["'](fs|path|os|crypto)["']/, /\bnode:sqlite\b/, /DatabaseSync/, /createCipheriv|createDecipheriv|randomBytes|createHash/, /readFileSync|writeFileSync|appendFileSync|mkdirSync/, /\bBuffer\b/, /process\.env/, /process\.on\(/, /createServer\(/]) {
    assert.ok(!bad.test(out), `bundle matches forbidden ${bad}`);
  }
  for (const input of Object.keys(r.metafile.inputs)) assert.ok(!/near-api-js|@near-js|node_modules\/borsh|tweetnacl/.test(input), `bundle pulls ${input}`);
  assert.ok(out.length < 1_000_000, "bundle unexpectedly large");
});

test("worker sources never import node builtins; the refresh/board/governance logic is the node indexer's (shared cores, no fork)", () => {
  for (const f of [...walk(IDX), ...walk(COMMON), path.join(SVC, "common/src/txHistoryCore.ts"), path.join(SVC, "indexer/src/refreshCore.ts")]) {
    const t = fs.readFileSync(f, "utf8");
    assert.ok(!/from ["']node:/.test(t) && !/from ["'](fs|path|os|crypto)["']/.test(t), `${f} imports a node builtin`);
    assert.ok(!/\bBuffer\b|process\.env/.test(t.replace(/\/\/.*$/gm, "")), `${f} uses Buffer/process.env`);
  }
  // IDX2: the tick's merge + RPC clients live in src/merge.ts, shared by the tick (index.ts) and POST /refresh (refresh.ts)
  const idx = fs.readFileSync(path.join(IDX, "src/index.ts"), "utf8") + fs.readFileSync(path.join(IDX, "src/merge.ts"), "utf8");
  const refresh = fs.readFileSync(path.join(IDX, "src/refresh.ts"), "utf8").replace(/\/\/.*$/gm, "");
  for (const f of [fs.readFileSync(path.join(IDX, "src/index.ts"), "utf8"), refresh]) assert.match(f, /\bmergeReads\(/, "tick and refresh both merge via merge.ts");
  assert.ok(!/\bsameBet\b|\bconfirmTerminals\b|\bTERMINAL\b|INSERT INTO indexer_bets/.test(refresh), "refresh never forks the merge rules or the upsert");
  for (const m of [/indexer\/src\/refreshCore/, /indexer\/src\/board/, /indexer\/src\/governance/, /common\/terminalConfirmCore/, /\.\/historyCursor\.js/, /monitor\/src\/serviceAlerts/]) assert.match(idx, m);
  // IDX1: the incremental history fetch pages through the shared tx-indexer core (same postJson as the node fetch)
  assert.match(fs.readFileSync(path.join(IDX, "src/historyCursor.ts"), "utf8"), /from "@praetorial\/common\/txHistoryCore\.js"/);
  assert.ok(!/from "[^"]*indexer\/src\/server\.js"|from "[^"]*terminalConfirm\.js"|verifier\/src\/live\.js/.test(idx), "worker must use the host-neutral cores, not node-bound modules");
  // node side re-uses the cores (node behaviour and its tests unchanged)
  const nodeRefresh = fs.readFileSync(path.join(SVC, "indexer/src/refresh.ts"), "utf8");
  assert.match(nodeRefresh, /from "\.\/refreshCore\.js"/);
  assert.ok(!/async function confirmTerminals|function sameBet/.test(nodeRefresh), "confirmTerminals/sameBet live only in refreshCore");
  const live = fs.readFileSync(path.join(SVC, "verifier/src/live.ts"), "utf8");
  assert.match(live, /txHistoryCore/);
  assert.ok(!/async function postJson/.test(live), "postJson/history paging live only in txHistoryCore");
  assert.ok(!/node:|Buffer|process\./.test(fs.readFileSync(path.join(SVC, "common/src/txHistoryCore.ts"), "utf8").replace(/\/\/.*$/gm, "")));
});

test("every env var the indexer worker reads is in the indexer serviceEnv row", () => {
  const row = SERVICES.find((s) => s.name === "indexer")!;
  const listed = new Set([...row.required, ...row.requiredOneOf.flat(), ...row.optional, ...COMMON_VARS]);
  const reads = new Set<string>();
  for (const f of walk(IDX)) for (const m of fs.readFileSync(f, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) reads.add(m[1]);
  assert.ok(reads.size > 8, "scanner found too few env reads (self-check)");
  const missing = [...reads].filter((v) => !listed.has(v));
  assert.deepEqual(missing, [], `worker reads vars not in serviceEnv: ${missing.join(", ")}`);
  for (const must of ["INDEXER_DB", "INDEXER_SERVICE", "INDEXER_BATCH_BETS", "INDEXER_MAX_CONFIRMS_PER_TICK", "INDEXER_MIN_TICK_INTERVAL_MS", "INDEXER_GOVERNANCE_MIN_INTERVAL_MS", "INDEXER_RPC_PER_SEC"]) assert.ok(listed.has(must), `${must} not listed`);
});

test("wrangler.toml: no secrets, NO cron of its own, d1_databases INDEXER_DB with the real (non-secret) D1 id, no DO, no node compat", () => {
  const t = fs.readFileSync(path.join(IDX, "wrangler.toml"), "utf8");
  for (const re of [/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/, /\d{6,}:[A-Za-z0-9_-]{30,}/, /sk-[A-Za-z0-9]{16,}/, /private_key/i, /PRIVATE KEY/, /BOT_TOKEN\s*=\s*"[^"]{8,}/]) assert.ok(!re.test(t), `wrangler.toml matches ${re}`);
  assert.ok(![...t.matchAll(/crons\s*=/g)].length, "indexer Worker must not add a cron trigger");
  assert.ok(!/^\s*\[triggers\]/m.test(t));
  assert.match(t, /\[\[d1_databases\]\]/);
  assert.match(t, /binding\s*=\s*"INDEXER_DB"/);
  // CF1e: the D1 id is a public, non-secret resource id and is now the real one (placeholder guard: workers/common/test/deployConfig.test.ts).
  assert.match(t, /database_id\s*=\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/);
  assert.match(t, /migrations_dir\s*=\s*"migrations"/);
  assert.match(t, /name\s*=\s*"praetorial-indexer-testnet"/);
  assert.match(t, /compatibility_date/);
  assert.ok(!/node_compat|nodejs_compat|durable_objects/.test(t), "no node compat flag, no DO (D1 storage)");
});

test("D1 schema migration file exists under the worker dir and creates the tables the worker uses", () => {
  const dir = path.join(IDX, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length >= 1 && /^0001_/.test(files[0]), files.join(","));
  const init = fs.readFileSync(path.join(dir, files[0]), "utf8");
  for (const t of ["indexer_bets", "indexer_state", "indexer_governance", "indexer_lock"]) assert.match(init, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
  // IDX2: later migrations (0002_refresh...) add tables/columns; every table the source uses must be created by SOME migration, in order.
  assert.deepEqual(files.map((f) => f.slice(0, 4)), files.map((_, i) => String(i + 1).padStart(4, "0")), "migrations numbered 0001.. with no gap");
  const sql = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const src = fs.readFileSync(path.join(IDX, "src/index.ts"), "utf8") + fs.readdirSync(path.join(IDX, "src")).map((f) => fs.readFileSync(path.join(IDX, "src", f), "utf8")).join("\n");
  for (const m of src.matchAll(/\b(?:FROM|INTO|UPDATE)\s+(indexer_[a-z_]+)/g)) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${m[1]}\\b`), `${m[1]} used but not in migration`);
});

test("README documents testnet deploy: token via env only, D1 create + migrations apply, dispatcher + CPU", () => {
  const t = fs.readFileSync(path.join(IDX, "README.md"), "utf8");
  assert.match(t, /CLOUDFLARE_API_TOKEN/);
  assert.match(t, /wrangler d1 create/);
  assert.match(t, /d1 migrations apply/);
  assert.match(t, /REPLACE_WITH_D1_DATABASE_ID/);
  assert.match(t, /dispatcher/i);
  assert.match(t, /INDEXER_SERVICE/);
  assert.match(t, /5 ms|CPU/);
  assert.match(t, /testnet/i);
  assert.match(t, /CF1e/);
});

test("the keeper's shared dispatcher registers the indexer jobs; keeper wrangler.toml keeps exactly one cron and binds INDEXER_SERVICE", async () => {
  const { JOBS } = await import("../../keeper/src/index.js");
  const names = JOBS.map((j: any) => j.name);
  assert.ok(names.includes("indexer-tick") && names.includes("indexer-governance"), names.join(","));
  const t = fs.readFileSync(path.resolve(HERE, "../../keeper/wrangler.toml"), "utf8").split(/^\[\[?env\.mainnet/m)[0] /* WKMAIN1: testnet (top-level) config only; mainnet is covered in common/test/deployConfig.test.ts */;
  const crons = [...t.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.equal(crons.length, 1);
  assert.match(t, /binding\s*=\s*"INDEXER_SERVICE"\s*\nservice\s*=\s*"praetorial-indexer-testnet"/);
});

test("indexer jobs poke the service binding (POST /tick, POST /tick/governance), no-op when unbound, throw on a failing tick", async () => {
  const { indexerTickJob, indexerGovernanceJob } = await import("../src/job.js");
  const calls: string[] = [];
  const env: any = { INDEXER_SERVICE: { fetch: async (u: string, i: any) => { calls.push(`${i.method} ${new URL(u).pathname}`); return new Response("{}", { status: 200 }); } } };
  await indexerTickJob.run(env, 0); await indexerGovernanceJob.run(env, 0);
  assert.deepEqual(calls, ["POST /tick", "POST /tick/governance"]);
  await indexerTickJob.run({}, 0); // unbound: nothing to poke
  await assert.rejects(() => indexerTickJob.run({ INDEXER_SERVICE: { fetch: async () => new Response("x", { status: 500 }) } } as any, 0), /500/);
  assert.equal(indexerTickJob.everyMinutes, 1); assert.ok(indexerGovernanceJob.everyMinutes >= 2);
});

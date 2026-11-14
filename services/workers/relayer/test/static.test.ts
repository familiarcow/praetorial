// CF1b RED: static guarantees for the relayer Worker bundle and config.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SERVICES, COMMON_VARS } from "../../../ops/src/serviceEnv.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAYER = path.resolve(HERE, "..");
const COMMON = path.resolve(HERE, "../../common/src");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === "test" || e.name === "test-budget" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
const entry = path.join(RELAYER, "src/index.ts");

test("worker bundle: no node:* / fs / sqlite / crypto / Buffer / process.env / near-api-js / @near-js / borsh at runtime", async () => {
  const r = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, logLevel: "silent" });
  const out = r.outputFiles[0].text;
  for (const bad of [/\bnode:/, /require\(["'](fs|path|os|crypto|child_process|net|http)["']\)/, /from ["'](fs|path|os|crypto)["']/, /\bnode:sqlite\b/, /DatabaseSync/, /readFileSync|writeFileSync|appendFileSync/, /\bBuffer\b/, /process\.env/, /process\.on\(/]) {
    assert.ok(!bad.test(out), `bundle matches forbidden ${bad}`);
  }
  for (const input of Object.keys(r.metafile.inputs)) assert.ok(!/near-api-js|@near-js|node_modules\/borsh|tweetnacl/.test(input), `bundle pulls ${input}`);
  assert.ok(out.length < 1_000_000, "bundle unexpectedly large");
});

test("worker sources never import node builtins (and reuse, not copy, the node relayer's pure logic)", () => {
  for (const f of [...walk(RELAYER), ...walk(COMMON)]) {
    const t = fs.readFileSync(f, "utf8");
    assert.ok(!/from ["']node:/.test(t) && !/from ["'](fs|path|os|crypto)["']/.test(t), `${f} imports a node builtin`);
  }
  const idx = fs.readFileSync(path.join(RELAYER, "src/index.ts"), "utf8") + fs.readFileSync(path.join(RELAYER, "src/env.ts"), "utf8");
  assert.match(idx, /relayer\/src\/relayerCore/);
  assert.match(idx, /relayer\/src\/guardStoreCore/);
  assert.match(idx, /relayer\/src\/httpMap/);
  // policy is reused transitively: the shared core imports it (the Worker has no second copy)
  assert.match(fs.readFileSync(path.resolve(HERE, "../../../relayer/src/relayerCore.ts"), "utf8"), /from "\.\/policy\.js"/);
  assert.ok(!fs.existsSync(path.join(RELAYER, "src/policy.ts")), "no forked policy in the Worker");
});

test("every env var the relayer worker reads is in the relayer serviceEnv table", () => {
  // Same pattern as CF1a: the Worker bindings are listed in the service's existing row (one row per service, so
  // launchd generation and ops:check keep working); the node-only vars stay listed alongside.
  const worker = SERVICES.find((s) => s.name === "relayer")!;
  const listed = new Set([...worker.required, ...worker.requiredOneOf.flat(), ...worker.optional, ...COMMON_VARS]);
  const reads = new Set<string>();
  // reads via `env.X`, or by name through the env.ts helpers big("X") / num("X")
  for (const f of walk(RELAYER)) for (const m of fs.readFileSync(f, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]+)|\b(?:big|num)\("([A-Z][A-Z0-9_]+)"/g)) reads.add(m[1] ?? m[2]);
  const toml = fs.readFileSync(path.join(RELAYER, "wrangler.toml"), "utf8");
  for (const m of toml.matchAll(/\[\[durable_objects\.bindings\]\]\s*name\s*=\s*"([A-Z_]+)"/g)) reads.delete(m[1]);
  assert.ok(reads.size > 8, "scanner found too few env reads (self-check)");
  const missing = [...reads].filter((v) => !listed.has(v));
  assert.deepEqual(missing, [], `worker reads vars not in serviceEnv: ${missing.join(", ")}`);
  for (const must of ["RELAYER_PRIVATE_KEY", "RELAYER_ACCOUNT_ID", "RELAYER_DAILY_BUDGET_YOCTO", "INDEXER_URL", "RELAYER_SERVICE"]) assert.ok(reads.has(must), `${must} not read`);
  assert.ok(worker.required.includes("RELAYER_KEY_FILE"), "node relayer requirements unchanged");
});

test("wrangler.toml: no secrets, NO cron of its own (shared dispatcher), DO + sqlite migration", () => {
  const t = fs.readFileSync(path.join(RELAYER, "wrangler.toml"), "utf8");
  for (const re of [/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/, /\d{6,}:[A-Za-z0-9_-]{30,}/, /sk-[A-Za-z0-9]{16,}/, /private_key/i, /PRIVATE KEY/, /RELAYER_PRIVATE_KEY\s*=/, /BOT_TOKEN\s*=\s*"[^"]{8,}/]) assert.ok(!re.test(t), `wrangler.toml matches ${re}`);
  assert.ok(![...t.matchAll(/crons\s*=/g)].length, "relayer Worker must not add a cron trigger (account limit 5; keeper hosts the one dispatcher cron)");
  assert.ok(!/^\s*\[triggers\]/m.test(t));
  assert.match(t, /new_sqlite_classes\s*=\s*\["RelayerDO"\]/);
  assert.match(t, /name\s*=\s*"RELAYER"/);
  assert.match(t, /compatibility_date/);
  assert.ok(!/node_compat|nodejs_compat/.test(t), "no node compat flag");
});

test("README documents testnet deploy: token via env only, secrets via wrangler secret put, dispatcher + CPU", () => {
  const t = fs.readFileSync(path.join(RELAYER, "README.md"), "utf8");
  assert.match(t, /CLOUDFLARE_API_TOKEN/);
  assert.match(t, /wrangler secret put RELAYER_PRIVATE_KEY/);
  assert.match(t, /dispatcher/i);
  assert.match(t, /RELAYER_SERVICE/);
  assert.match(t, /5 ms|CPU/);
  assert.match(t, /testnet/i);
});

test("the keeper's shared dispatcher registers the relayer job; keeper wrangler.toml keeps exactly one cron", async () => {
  const { JOBS } = await import("../../keeper/src/index.js");
  assert.ok(JOBS.some((j: any) => j.name === "relayer-heartbeat"), JOBS.map((j: any) => j.name).join(","));
  const t = fs.readFileSync(path.resolve(HERE, "../../keeper/wrangler.toml"), "utf8").split(/^\[\[?env\.mainnet/m)[0] /* WKMAIN1: testnet (top-level) config only; mainnet is covered in common/test/deployConfig.test.ts */;
  const crons = [...t.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.equal(crons.length, 1);
  assert.match(t, /binding\s*=\s*"RELAYER_SERVICE"/);
});

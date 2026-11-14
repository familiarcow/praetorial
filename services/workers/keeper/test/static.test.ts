// CF1a RED: static guarantees for the Worker bundle and config.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SERVICES, COMMON_VARS } from "../../../ops/src/serviceEnv.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS = path.resolve(HERE, "../..");
const KEEPER = path.resolve(HERE, "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === "test" || e.name === "test-budget" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
}

test("worker bundle has no node:* / fs / sqlite / Buffer / process.env at runtime", async () => {
  const r = await build({ entryPoints: [path.join(KEEPER, "src/index.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, logLevel: "silent" });
  const out = r.outputFiles[0].text;
  for (const bad of [/\bnode:/, /require\(["'](fs|path|os|crypto|child_process|net|http)["']\)/, /from ["'](fs|path|os|crypto)["']/, /\bnode:sqlite\b/, /readFileSync|writeFileSync|appendFileSync/, /\bBuffer\b/, /process\.env/, /process\.on\(/]) {
    assert.ok(!bad.test(out), `bundle matches forbidden ${bad}`);
  }
  for (const input of Object.keys(r.metafile.inputs)) assert.ok(!/near-api-js/.test(input), `bundle pulls ${input}`);
  assert.ok(out.length < 1_000_000, "bundle unexpectedly large");
});

test("worker sources never import node builtins", () => {
  for (const f of walk(WORKERS)) {
    const t = fs.readFileSync(f, "utf8");
    assert.ok(!/from ["']node:/.test(t) && !/from ["'](fs|path|os|crypto)["']/.test(t), `${f} imports a node builtin`);
  }
});

test("every env var the worker reads is in the keeper serviceEnv table", () => {
  const keeper = SERVICES.find((s) => s.name === "keeper")!;
  const listed = new Set([...keeper.required, ...keeper.requiredOneOf.flat(), ...keeper.optional, ...COMMON_VARS]);
  const reads = new Set<string>();
  // Scope: the keeper Worker + the shared common code. Each other Worker (CF1b relayer, ...) is checked against
  // its own serviceEnv row by its own static test; they must not be forced into the keeper row.
  for (const f of [...walk(KEEPER), ...walk(path.join(WORKERS, "common"))]) for (const m of fs.readFileSync(f, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) reads.add(m[1]);
  // Durable Object namespace bindings (declared in wrangler.toml) are bindings, not env vars.
  const toml = fs.readFileSync(path.join(KEEPER, "wrangler.toml"), "utf8");
  for (const m of toml.matchAll(/\[\[durable_objects\.bindings\]\]\s*name\s*=\s*"([A-Z_]+)"/g)) reads.delete(m[1]);
  assert.ok(reads.size > 5, "scanner found no env reads (self-check)");
  const missing = [...reads].filter((v) => !listed.has(v));
  assert.deepEqual(missing, [], `worker reads vars not in serviceEnv: ${missing.join(", ")}`);
  assert.ok(reads.has("KEEPER_PRIVATE_KEY"));
});

test("wrangler.toml: no secrets, exactly one cron, DO + sqlite migration", () => {
  const t = fs.readFileSync(path.join(KEEPER, "wrangler.toml"), "utf8").split(/^\[\[?env\.mainnet/m)[0] /* WKMAIN1: testnet (top-level) config only; mainnet is covered in common/test/deployConfig.test.ts */;
  for (const re of [/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/, /\d{6,}:[A-Za-z0-9_-]{30,}/, /sk-[A-Za-z0-9]{16,}/, /private_key/i, /PRIVATE KEY/, /KEEPER_PRIVATE_KEY\s*=/, /BOT_TOKEN\s*=\s*"[^"]{8,}/]) assert.ok(!re.test(t), `wrangler.toml matches ${re}`);
  const crons = [...t.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.equal(crons.length, 1, "exactly one cron trigger (account limit is 5)");
  assert.match(t, /new_sqlite_classes\s*=\s*\["KeeperDO"\]/);
  assert.match(t, /compatibility_date/);
  assert.ok(!/node_compat|nodejs_compat/.test(t), "no node compat flag");
});

test("README documents testnet deploy with a Worker secret / env token, never committed", () => {
  const t = fs.readFileSync(path.join(KEEPER, "README.md"), "utf8");
  assert.match(t, /CLOUDFLARE_API_TOKEN/);
  assert.match(t, /wrangler secret put KEEPER_PRIVATE_KEY/);
  assert.match(t, /dispatcher/i);
  assert.match(t, /5 ms|CPU/);
});

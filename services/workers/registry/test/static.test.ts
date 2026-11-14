// CF1f RED: static guarantees for the registry Worker bundle/config + the shared core (node and Worker both use it).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REG = path.resolve(HERE, "..");
const NODE_REG = path.resolve(HERE, "../../../registry/src");
const active = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

test("worker bundle: no node:* / Buffer / fs / process.env / near-api-js at runtime", async () => {
  const r = await build({ entryPoints: [path.join(REG, "src/index.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, logLevel: "silent" });
  const out = r.outputFiles[0].text;
  for (const bad of [/\bnode:/, /from ["'](fs|path|os|crypto)["']/, /DatabaseSync/, /readFileSync|writeFileSync/, /\bBuffer\b/, /process\.env/]) assert.ok(!bad.test(out), `bundle matches forbidden ${bad}`);
  for (const input of Object.keys(r.metafile.inputs)) assert.ok(!/near-api-js|@near-js|node_modules\/bs58\//.test(input), `bundle pulls ${input}`);
  assert.ok(out.length < 1_000_000);
});

test("the node server and the Worker share ONE core (claim/search/lookup rules live in registry/src/core.ts only)", () => {
  assert.ok(fs.existsSync(path.join(NODE_REG, "core.ts")));
  const core = fs.readFileSync(path.join(NODE_REG, "core.ts"), "utf8") + fs.readFileSync(path.join(NODE_REG, "nep413Core.ts"), "utf8");
  assert.ok(!/from ["']node:/.test(core) && !/\bBuffer\b/.test(core), "core must be host-neutral (no node:*, no Buffer)");
  assert.match(fs.readFileSync(path.join(NODE_REG, "server.ts"), "utf8"), /from "\.\/core\.js"/);
  assert.match(fs.readFileSync(path.join(REG, "src/index.ts"), "utf8"), /registry\/src\/core/);
  for (const f of fs.readdirSync(path.join(REG, "src"))) assert.ok(!/from ["']node:/.test(fs.readFileSync(path.join(REG, "src", f), "utf8")), `${f} imports a node builtin`);
  assert.ok(!fs.existsSync(path.join(REG, "src/rules.ts")), "no forked rules in the Worker");
});

test("wrangler.toml: praetorial-registry-testnet, D1 praetorial-registry-testnet, no secrets, no cron, no placeholders, testnet", () => {
  const t = fs.readFileSync(path.join(REG, "wrangler.toml"), "utf8"), a = active(t);
  assert.match(a, /^name\s*=\s*"praetorial-registry-testnet"/m);
  assert.match(a, /binding\s*=\s*"REGISTRY_DB"/); assert.match(a, /database_name\s*=\s*"praetorial-registry-testnet"/);
  assert.match(a, /database_id\s*=\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/);
  assert.doesNotMatch(a, /REPLACE_|crons\s*=|ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|CLOUDFLARE_API_TOKEN/);
  assert.match(a, /NEAR_NETWORK_ID\s*=\s*"testnet"/); assert.match(a, /REGISTRY_ID\s*=\s*"[a-z0-9._-]+\.testnet"/);
  assert.doesNotMatch(a, /bondclinical|gogardenstate/);
});

test("every env var the registry worker reads is declared in wrangler.toml [vars] or is a known optional", () => {
  const src = fs.readFileSync(path.join(REG, "src/index.ts"), "utf8") + fs.readFileSync(NODE_REG + "/config.ts", "utf8");
  const read = new Set([...src.matchAll(/env\.(REGISTRY_[A-Z_]+|NEAR_[A-Z_]+)/g)].map((m) => m[1]).filter((v) => v !== "REGISTRY_DB")); // REGISTRY_DB is the D1 binding, not a var
  const optional = new Set(["REGISTRY_PORT", "REGISTRY_STORE_PATH", "REGISTRY_RATE_CAPACITY", "REGISTRY_RATE_REFILL_PER_SEC", "REGISTRY_TRUST_PROXY", "NEAR_RPC_URL", "REGISTRY_MAX_BODY_BYTES"]);
  const toml = active(fs.readFileSync(path.join(REG, "wrangler.toml"), "utf8"));
  for (const v of read) assert.ok(optional.has(v) || new RegExp(`^${v}\\s*=`, "m").test(toml), `${v} read but not in [vars]`);
  assert.match(toml, /^REGISTRY_CORS_ORIGINS\s*=/m);
});

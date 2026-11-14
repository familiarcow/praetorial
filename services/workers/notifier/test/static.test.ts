// CF1c2 RED: static guarantees for the notifier Worker bundle and config (same checks as the monitor/relayer static tests),
// plus the host-neutral splits (notifierCore, terminalConfirmCore, AlertRaiser) that keep the node notifier unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SERVICES, COMMON_VARS } from "../../../ops/src/serviceEnv.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOT = path.resolve(HERE, "..");
const SVC = path.resolve(HERE, "../../..");
const COMMON = path.resolve(HERE, "../../common/src");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === "test" || e.name === "test-budget" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
const entry = path.join(NOT, "src/index.ts");

test("worker bundle: no node:* / fs / sqlite / crypto / Buffer / process.env / near-api-js at runtime", async () => {
  const r = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, logLevel: "silent" });
  const out = r.outputFiles[0].text;
  for (const bad of [/\bnode:/, /require\(["'](fs|path|os|crypto|child_process|net|http)["']\)/, /from ["'](fs|path|os|crypto)["']/, /\bnode:sqlite\b/, /DatabaseSync/, /createCipheriv|createDecipheriv|randomBytes/, /readFileSync|writeFileSync|appendFileSync|mkdirSync/, /\bBuffer\b/, /process\.env/, /process\.on\(/]) {
    assert.ok(!bad.test(out), `bundle matches forbidden ${bad}`);
  }
  for (const input of Object.keys(r.metafile.inputs)) assert.ok(!/near-api-js|@near-js|node_modules\/borsh|tweetnacl/.test(input), `bundle pulls ${input}`);
  assert.ok(out.length < 1_000_000, "bundle unexpectedly large");
});

test("worker sources never import node builtins; the pipeline is the node notifier's (shared cores, no fork)", () => {
  for (const f of [...walk(NOT), ...walk(COMMON)]) {
    const t = fs.readFileSync(f, "utf8");
    assert.ok(!/from ["']node:/.test(t) && !/from ["'](fs|path|os|crypto)["']/.test(t), `${f} imports a node builtin`);
    assert.ok(!/\bBuffer\b|process\.env/.test(t.replace(/\/\/.*$/gm, "")), `${f} uses Buffer/process.env`);
  }
  const idx = fs.readFileSync(path.join(NOT, "src/index.ts"), "utf8");
  for (const m of [/notifier\/src\/notifierCore/, /notifier\/src\/confirm/, /notifier\/src\/highStakeRouter/, /common\/src\/terminalConfirmCore/, /monitor\/src\/serviceAlerts/]) assert.match(idx, m);
  assert.ok(!/from "[^"]*notifier\/src\/notifier\.js"|from "[^"]*terminalConfirm\.js"|notifier\/src\/contactStore\.js/.test(idx), "worker must use the host-neutral cores, not the node-bound modules");
  // node side: notifier.ts / terminalConfirm.ts re-export the cores (node behaviour and its tests unchanged)
  const nodeNotifier = fs.readFileSync(path.join(SVC, "notifier/src/notifier.ts"), "utf8");
  assert.match(nodeNotifier, /export \* from "\.\/notifierCore\.js"/);
  assert.ok(!/function computeNotices/.test(nodeNotifier), "computeNotices must live only in notifierCore");
  const nodeConfirm = fs.readFileSync(path.join(SVC, "common/src/terminalConfirm.ts"), "utf8");
  assert.match(nodeConfirm, /export \* from "\.\/terminalConfirmCore\.js"/);
  const core = fs.readFileSync(path.join(SVC, "common/src/terminalConfirmCore.ts"), "utf8");
  const coreCode = core.replace(/\/\/.*$/gm, ""); // comments may mention NearClient; imports may not
  assert.ok(!/from "[^"]*(nearClient|near-api-js|node:)/.test(coreCode), "terminalConfirmCore must be NearClient-free");
  assert.ok(!/from "\.\/(nearClient|config)\.js"/.test(coreCode), "terminalConfirmCore must not import NearClient/config");
  const notifierCore = fs.readFileSync(path.join(SVC, "notifier/src/notifierCore.ts"), "utf8");
  assert.ok(!/node:|from "fs"/.test(notifierCore));
});

test("serviceAlerts exposes a raiser interface (AlertRaiser) that node's ServiceAlertRaiser implements and confirm.ts accepts", async () => {
  const src = fs.readFileSync(path.join(SVC, "monitor/src/serviceAlerts.ts"), "utf8");
  assert.match(src, /export interface AlertRaiser/);
  assert.match(src, /class ServiceAlertRaiser implements AlertRaiser/);
  assert.ok(!/node:|from "fs"/.test(src), "serviceAlerts must stay host-neutral");
  const conf = fs.readFileSync(path.join(SVC, "notifier/src/confirm.ts"), "utf8");
  assert.match(conf, /raiser: AlertRaiser/);
  // behavioural: a plain-object raiser is accepted by the node confirm filter
  const { filterConfirmedTerminals } = await import("../../../notifier/src/confirm.js");
  const got: any[] = [];
  const out = await filterConfirmedTerminals(new Map(), { second: null, raiser: { async raise(a: any[]) { got.push(...a); return a; } }, cache: new Set() });
  assert.equal(out.size, 0);
});

test("terminalConfirmCore behaves exactly like the node module (same exports, same verdicts)", async () => {
  const core = await import("../../../common/src/terminalConfirmCore.js");
  const node = await import("../../../common/src/terminalConfirm.js");
  for (const k of ["confirmTerminalBet", "isConfirmableTerminal", "sameBetIdentity", "CONFIRMING_DISPLAY"]) assert.strictEqual((node as any)[k], (core as any)[k], k);
  assert.equal(core.secondRpcUrl(["a", "b", "c"]), "b"); assert.equal(core.secondRpcUrl(["a"]), null); assert.equal(core.secondRpcUrl(undefined), null);
});

test("every env var the notifier worker reads is in the notifier serviceEnv row", () => {
  const row = SERVICES.find((s) => s.name === "notifier")!;
  const listed = new Set([...row.required, ...row.requiredOneOf.flat(), ...row.optional, ...COMMON_VARS]);
  const reads = new Set<string>();
  for (const f of walk(NOT)) for (const m of fs.readFileSync(f, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) reads.add(m[1]);
  const toml = fs.readFileSync(path.join(NOT, "wrangler.toml"), "utf8");
  for (const m of toml.matchAll(/\[\[durable_objects\.bindings\]\]\s*name\s*=\s*"([A-Z_]+)"/g)) reads.delete(m[1]);
  assert.ok(reads.size > 8, "scanner found too few env reads (self-check)");
  const missing = [...reads].filter((v) => !listed.has(v));
  assert.deepEqual(missing, [], `worker reads vars not in serviceEnv: ${missing.join(", ")}`);
  for (const must of ["NOTIFIER_RPC_PER_SEC", "NOTIFIER_MIN_TICK_INTERVAL_MS", "NOTIFIER_BATCH_BETS", "NOTIFIER_MAX_SENDS_PER_TICK", "NOTIFIER_LOG_KEEP", "NOTIFIER_SERVICE", "NOTIFIER_CONTACT_KEY", "TELEGRAM_BOT_TOKEN"]) assert.ok(listed.has(must), `${must} not listed`);
});

test("wrangler.toml: no secrets, NO cron of its own, DO + sqlite migration, private (workers_dev=false)", () => {
  const raw = fs.readFileSync(path.join(NOT, "wrangler.toml"), "utf8");
  // MAINPREP1: NOTIFIER_ASSET_PRICES names the mainnet USDC token, a PUBLIC 64-hex NEP-141 account id ("nep141:<hex>"). Only that
  // exact prefixed form is exempt from the hex-secret check; a bare 64-hex value anywhere else still fails.
  const t = raw.replace(/nep141:[0-9a-f]{64}\b/g, "nep141:PUBLIC_TOKEN_ID");
  for (const re of [/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/, /\d{6,}:[A-Za-z0-9_-]{30,}/, /sk-[A-Za-z0-9]{16,}/, /private_key/i, /PRIVATE KEY/, /BOT_TOKEN\s*=\s*"[^"]{8,}/, /CONTACT_KEY\s*=\s*"[^"]{8,}/, /\b[0-9a-f]{64}\b/i]) assert.ok(!re.test(t), `wrangler.toml matches ${re}`);
  assert.ok(![...t.matchAll(/crons\s*=/g)].length, "notifier Worker must not add a cron trigger");
  assert.ok(!/^\s*\[triggers\]/m.test(t));
  assert.match(t, /name\s*=\s*"praetorial-notifier-testnet"/);
  assert.match(t, /new_sqlite_classes\s*=\s*\["NotifierDO"\]/);
  assert.match(t, /name\s*=\s*"NOTIFIER"/);
  assert.match(t, /workers_dev\s*=\s*false/);
  assert.match(t, /compatibility_date/);
  assert.ok(!/node_compat|nodejs_compat/.test(t), "no node compat flag");
});

test("README documents testnet deploy: token via env only, secrets via wrangler secret put, dispatcher + CPU + contact compatibility", () => {
  const t = fs.readFileSync(path.join(NOT, "README.md"), "utf8");
  assert.match(t, /CLOUDFLARE_API_TOKEN/);
  assert.match(t, /wrangler secret put NOTIFIER_CONTACT_KEY/);
  assert.match(t, /wrangler secret put TELEGRAM_BOT_TOKEN/);
  assert.match(t, /dispatcher/i);
  assert.match(t, /NOTIFIER_SERVICE/);
  assert.match(t, /5 ms|CPU/);
  assert.match(t, /testnet/i);
  assert.match(t, /AES-256-GCM/);
});

test("the keeper's shared dispatcher registers notifier-tick; keeper wrangler.toml keeps exactly one cron and binds NOTIFIER_SERVICE", async () => {
  const { JOBS } = await import("../../keeper/src/index.js");
  const names = JOBS.map((j: any) => j.name);
  assert.ok(names.includes("notifier-tick") && names.includes("monitor-tick") && names.includes("keeper"), names.join(","));
  const t = fs.readFileSync(path.resolve(HERE, "../../keeper/wrangler.toml"), "utf8").split(/^\[\[?env\.mainnet/m)[0] /* WKMAIN1: testnet (top-level) config only; mainnet is covered in common/test/deployConfig.test.ts */;
  const crons = [...t.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.equal(crons.length, 1);
  assert.match(t, /binding\s*=\s*"NOTIFIER_SERVICE"/);
  assert.match(t, /service\s*=\s*"praetorial-notifier-testnet"/);
  // the job pokes POST /tick over the binding and is a no-op when unbound
  const job = JOBS.find((j: any) => j.name === "notifier-tick")!;
  await job.run({} as any, 0);
  const calls: string[] = [];
  await job.run({ NOTIFIER_SERVICE: { fetch: async (u: string, i: any) => { calls.push(`${i.method} ${u}`); return new Response("{}"); } } } as any, 0);
  assert.deepEqual(calls, ["POST https://notifier.internal/tick"]);
  await assert.rejects(() => job.run({ NOTIFIER_SERVICE: { fetch: async () => new Response("x", { status: 500 }) } } as any, 0), /notifier tick failed/);
});

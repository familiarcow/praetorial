// LIVE2 step 3 RED/GREEN: the per-IP hourly cap is configurable per env (SOURCECHECK_IP_PER_HOUR). Testnet = 60, mainnet = 30 (SRCRL1c).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleSourceCheck, parseAllowedOrigins, type SourceCheckDeps } from "../src/core.js";
import { SourceCheckLimiter, memoryStore, IP_PER_HOUR, ipPerHourFromEnv } from "../src/limiter.js";
import { SourceCheckLimiterDO } from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://app.praetorial.test";

test("ipPerHourFromEnv: a positive whole number is used; anything else falls back to the default 10", () => {
  assert.equal(IP_PER_HOUR, 10);
  assert.equal(ipPerHourFromEnv("60"), 60);
  assert.equal(ipPerHourFromEnv(" 60 "), 60);
  for (const bad of [undefined, "", "0", "-5", "abc", "1.5", "1e3", 60.5, null]) assert.equal(ipPerHourFromEnv(bad as any), 10, String(bad));
  assert.equal(ipPerHourFromEnv("100000"), 10, "absurd values are refused (fail to the safe default)");
});

function deps(ipPerHour: number): SourceCheckDeps {
  return {
    allowedOrigins: parseAllowedOrigins(ORIGIN),
    limiter: new SourceCheckLimiter(memoryStore(), ipPerHour),
    ipPerHour,
    lint: () => ["lint off for this test"],
    chain: { pinnedAttestPubkeyHex: async () => "", execute: async () => ({}) },
    alert: async () => undefined,
    nowMs: () => 1_700_000_000_000,
  };
}
// a lint failure returns 422 BEFORE the limiter; so use a limiter-only probe via a passing lint and a failing chain (502 = consumed).
function passLint(d: SourceCheckDeps): SourceCheckDeps { return { ...d, lint: () => [], chain: { pinnedAttestPubkeyHex: async () => "00", execute: async () => ({ ok: false }) } }; }
const post = (d: SourceCheckDeps) => handleSourceCheck(new Request("https://w.example/sourcecheck", { method: "POST", headers: { origin: ORIGIN, "cf-connecting-ip": "1.1.1.1" }, body: JSON.stringify({ mode: "sourcecheck", terms: "{}" }) }), d);

test("60/hour: the 60th check runs, the 61st is a 429 whose reason names 60 and exposes retry-after to the browser", async () => {
  const d = passLint(deps(60));
  for (let i = 1; i <= 60; i++) assert.notEqual((await post(d)).status, 429, `call ${i}`);
  const r = await post(d); const b: any = await r.json();
  assert.equal(r.status, 429);
  assert.match(b.reason, /60 sourcechecks per hour/);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.match(r.headers.get("access-control-expose-headers") ?? "", /retry-after/i);
});

test("limiter DO honours the ipPerHour the Worker passes (capped by ipPerHourFromEnv)", async () => {
  const m = new Map<string, unknown>();
  const dobj = new SourceCheckLimiterDO({ storage: { get: async (k: string) => m.get(k) as any, put: async (k: string, v: unknown) => { m.set(k, v); } } });
  const call = async () => (await (await dobj.fetch(new Request("https://limiter/consume", { method: "POST", body: JSON.stringify({ ip: "1.1.1.1", nowMs: 0, ipPerHour: 60 }) }))).json()) as any;
  for (let i = 0; i < 60; i++) assert.equal((await call()).ok, true, `call ${i + 1}`);
  assert.equal((await call()).ok, false);
});

// SRCRL1c (PREMAIN1): mainnet per-IP cap is 30/hour, set in [env.mainnet.vars] (was unset = 10); testnet stays 60.
test("wrangler.toml: testnet sets SOURCECHECK_IP_PER_HOUR = 60; [env.mainnet.vars] sets it to 30 (SRCRL1c)", () => {
  const toml = fs.readFileSync(path.join(HERE, "../wrangler.toml"), "utf8");
  const [testnet, mainnet] = toml.split(/^\[env\.mainnet\]/m);
  assert.match(testnet, /^SOURCECHECK_IP_PER_HOUR\s*=\s*"60"\s*$/m);
  assert.equal((testnet.match(/^SOURCECHECK_IP_PER_HOUR\b/gm) ?? []).length, 1, "testnet sets it exactly once");
  // the value must sit in the [env.mainnet.vars] table itself (not in a later table, where wrangler would not read it as a var)
  const vars = mainnet.split(/^\[env\.mainnet\.vars\]\s*$/m)[1];
  assert.ok(vars !== undefined, "[env.mainnet.vars] table present");
  const varsTable = vars.split(/^\[/m)[0];
  assert.match(varsTable, /^SOURCECHECK_IP_PER_HOUR\s*=\s*"30"\s*$/m);
  assert.equal((mainnet.match(/^SOURCECHECK_IP_PER_HOUR\b/gm) ?? []).length, 1, "mainnet sets it exactly once");
  assert.equal(ipPerHourFromEnv("30"), 30, "the Worker reads 30 as 30 (not the fallback)");
});

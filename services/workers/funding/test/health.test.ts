// F1 + STACK1: GET /health is the shared identity body (+ keyConfigured: bool) and never echoes the 1Click key.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { configFromEnv, scrubbedLogger } from "../src/env.js";
import { assertHealth } from "../../common/test/healthAssert.js";

const KEY = "eyJhbGciOiJIUzI1NiJ9.FAKE-ONECLICK-PARTNER-JWT.sig0123456789";
const env = (o: Record<string, unknown> = {}): any => ({
  NEAR_NETWORK_ID: "mainnet", ESCROW_CONTRACT_ID: "bets.praetorial.near", GIT_SHA: "f1f1f1f1f1f1", ONECLICK_API_KEY: KEY,
  FUNDING_STORE: { idFromName() { throw new Error("/health must not touch the store"); } }, ...o,
});

test("funding /health: identity + keyConfigured true; the key never appears", async () => {
  const b = await assertHealth(await worker.fetch(new Request("https://f.test/health"), env()), { service: "funding", network: "mainnet", escrow: "bets.praetorial.near", sha: "f1f1f1f1f1f1", secrets: [KEY, "FAKE-ONECLICK"], tick: "absent" });
  assert.equal(b.keyConfigured, true);
  const b2 = await (await worker.fetch(new Request("https://f.test/health"), env({ ONECLICK_API_KEY: undefined }))).json() as any;
  assert.equal(b2.keyConfigured, false);
});

test("misconfigured BETTING_ASSET_IDS -> 500 on API routes, nothing leaks", async () => {
  const r = await worker.fetch(new Request("https://f.test/tokens"), env({ BETTING_ASSET_IDS: "nep141:a.near" }));
  assert.equal(r.status, 500);
  assert.ok(!(await r.text()).includes(KEY));
});

test("configFromEnv: mainnet real quotes only with an explicit FUNDING_DRY_ONLY=\"0\"; testnet always dry-only", () => {
  const ids = "nep141:a.near,nep141:b.near,nep141:c.near,nep141:d.near,nep141:e.near,nep141:f.near";
  assert.equal(configFromEnv({ NEAR_NETWORK_ID: "mainnet", BETTING_ASSET_IDS: ids, FUNDING_DRY_ONLY: "0" }).dryOnly, false);
  for (const v of [undefined, "", "1", "false", "no"]) assert.equal(configFromEnv({ NEAR_NETWORK_ID: "mainnet", BETTING_ASSET_IDS: ids, FUNDING_DRY_ONLY: v }).dryOnly, true, String(v));
  assert.equal(configFromEnv({ NEAR_NETWORK_ID: "testnet", BETTING_ASSET_IDS: ids, FUNDING_DRY_ONLY: "0" }).dryOnly, true);
  assert.deepEqual(configFromEnv({ BETTING_ASSET_IDS: ids, FUNDING_ALLOWED_ORIGINS: "*,https://a.test/,ftp://x" }).allowedOrigins, ["https://a.test"]);
});

test("scrubbedLogger redacts the key even if some value ever contained it", () => {
  const lines: string[] = [];
  scrubbedLogger(KEY, (l) => lines.push(l))({ evt: "x", oops: `Bearer ${KEY}` });
  assert.ok(!lines[0]!.includes(KEY));
  assert.match(lines[0]!, /<redacted>/);
});

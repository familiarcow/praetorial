// DEPLOYFIX (DOCS1 FOLLOWUPS 7): `npm run deploy:mainnet` must not silently turn 1Click Add money / Cash out / Convert off.
// The live mainnet bundle (2026-11-12, index-Cxt3Yv_k.js) was built with
//   VITE_FUNDING_URL:"https://funding.praetorial.com"
// but build:mainnet never set it and NETWORKS.mainnet.fundingUrl was "", so a rebuild from the script shipped fundingUrl "" (=
// "Adding money is unavailable"). The URL now lives in the network table (one source of truth, like the other mainnet URLs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NETWORKS, resolveNetwork } from "../lib/network";

const WEB = new URL("..", import.meta.url).pathname;
const ROOT = join(WEB, "..", "..");
const LIVE_FUNDING_URL = "https://funding.praetorial.com";
const scripts = () => (JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

/** The NAME=value assignments in front of `npm run build` in a package.json build script (what vite sees as import.meta.env). */
function scriptEnv(script: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const tok of script.split(/\s+/)) { const m = tok.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (!m) break; env[m[1]] = m[2]; }
  return env;
}

test("a mainnet build (exactly build:mainnet's env) gets the mainnet funding Worker URL, never empty", () => {
  const env = scriptEnv(scripts()["build:mainnet"]!);
  assert.equal(env.VITE_NETWORK_ID, "mainnet");
  // Nothing else in the environment: only what the script sets (a clean shell on deploy night).
  const n = resolveNetwork(env);
  assert.equal(n.networkId, "mainnet");
  assert.notEqual(n.fundingUrl, "", "build:mainnet would ship fundingUrl \"\" (1Click Add money / Cash out / Convert off)");
  assert.equal(n.fundingUrl, LIVE_FUNDING_URL);
});

test("the mainnet network table holds the funding URL (one source of truth) and it is the funding Worker's [env.mainnet] name", () => {
  assert.equal(NETWORKS.mainnet.fundingUrl, LIVE_FUNDING_URL);
  const toml = readFileSync(join(ROOT, "services/workers/funding/wrangler.toml"), "utf8");
  const mainnet = toml.split(/^\[env\.mainnet\]\s*$/m)[1]!;
  const name = mainnet.match(/^name\s*=\s*"([^"]+)"/m)![1];
  assert.equal(name, "praetorial-funding-mainnet");
  // DOM1: the URL is the funding Worker's custom domain (its one [env.mainnet] custom_domain route).
  const host = mainnet.match(/^routes\s*=\s*\[\{ pattern = "([^"]+)", custom_domain = true \}\]\s*$/m)![1];
  assert.equal(NETWORKS.mainnet.fundingUrl, `https://${host}`);
  // The Worker lets the mainnet web origin call it from a browser (else every call is a 403 and the UI says "unavailable").
  const origins = mainnet.match(/^FUNDING_ALLOWED_ORIGINS\s*=\s*"([^"]*)"/m)![1].split(",");
  assert.ok(origins.includes("https://praetorial.com"), origins.join(","));
  // The script does not set it a second time (one source of truth: the table).
  assert.doesNotMatch(scripts()["build:mainnet"]!, /FUNDING_URL/);
});

test("an explicit VITE_FUNDING_URL / FUNDING_URL still overrides the table (unchanged behaviour)", () => {
  assert.equal(resolveNetwork({ NETWORK_ID: "mainnet", VITE_FUNDING_URL: "https://f.example" }).fundingUrl, "https://f.example");
  assert.equal(resolveNetwork({ NETWORK_ID: "mainnet", FUNDING_URL: "" }).fundingUrl, LIVE_FUNDING_URL, "empty env value is ignored");
});

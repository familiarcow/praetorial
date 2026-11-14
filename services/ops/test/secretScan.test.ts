import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATTERNS: [string, RegExp][] = [
  ["telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/],
  ["near ed25519 key", /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/],
  ["sk- api key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["64-hex secret", /\b[0-9a-fA-F]{64}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test("no secret-looking strings anywhere under services/ops", () => {
  const hits: string[] = [];
  for (const f of walk(OPS)) {
    const text = fs.readFileSync(f, "utf8");
    for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(`${path.relative(OPS, f)}: ${name}`);
  }
  assert.deepEqual(hits, []);
});

test("README documents the setup order, proves/does-not-prove, and a placeholder-only testnet template", () => {
  const readme = fs.readFileSync(path.join(OPS, "README.md"), "utf8");
  for (const s of ["ops:check", "ops:test-alert", "ops:gen-launchd", "release record", "heartbeat", "does NOT prove", "NEAR_RPC_FALLBACKS", "HEARTBEAT_DIR", "ALERT_TELEGRAM_BOT_TOKEN"]) assert.ok(readme.includes(s), `README missing "${s}"`);
  assert.match(readme, /<[A-Z_]+>/);
});

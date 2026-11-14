// MAINPREP1: the mainnet deploy scripts are gated, deploy --env mainnet only, never touch routes, and never print secrets.
// Runs the real scripts with a stub wrangler (WRANGLER=<stub>) in DRY_RUN mode; no network except none (SKIP_CHAIN_CHECK=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts");
const stubDir = mkdtempSync(path.join(tmpdir(), "mp1-wr-"));
const STUB = path.join(stubDir, "wrangler-stub");
writeFileSync(STUB, "#!/bin/sh\necho \"STUB-WRANGLER $*\"\n"); chmodSync(STUB, 0o755);
const run = (script: string, env: Record<string, string>) =>
  spawnSync("bash", [path.join(SCRIPTS, script)], { encoding: "utf8", env: { ...process.env, PRAETORIAL_MAINNET_GO: "", DRY_RUN: "", WRANGLER: STUB, ONECLICK_ENV: path.join(stubDir, "no-such-oneclick.env"), ...env } });

test("MAINPREP1 deploy-mainnet.sh refuses without PRAETORIAL_MAINNET_GO=GO (and without DRY_RUN)", () => {
  const r = run("deploy-mainnet.sh", {});
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /PRAETORIAL_MAINNET_GO=GO/);
  assert.doesNotMatch(r.stdout, /STUB-WRANGLER/);
});

test("MAINPREP1 deploy-mainnet.sh refuses SKIP_CHAIN_CHECK on a real run", () => {
  const r = run("deploy-mainnet.sh", { PRAETORIAL_MAINNET_GO: "GO", SKIP_CHAIN_CHECK: "1" });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /dry runs only/);
});

test("MAINPREP1 deploy-mainnet.sh DRY_RUN: readiness checks pass, all eight deploy with --env mainnet, D1 migrations first, keeper last, no routes", () => {
  const r = run("deploy-mainnet.sh", { DRY_RUN: "1", SKIP_CHAIN_CHECK: "1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /mainnet config is deploy-ready \(0 findings\)/);
  const deploys = r.stdout.split("\n").filter((l) => /^DRY: .* deploy --env mainnet --var GIT_SHA:/.test(l)).map((l) => /cd (\w+) &&/.exec(l)![1]);
  assert.deepEqual(deploys, ["indexer", "notifier", "monitor", "relayer", "registry", "sourcecheck", "funding", "keeper"]);
  assert.match(r.stdout, /d1 migrations apply praetorial-indexer-mainnet --env mainnet --remote/);
  assert.match(r.stdout, /d1 migrations apply praetorial-registry-mainnet --env mainnet --remote/);
  assert.doesNotMatch(r.stdout, /route|custom.domain|--env testnet|praetorial\.com\//i);
  assert.doesNotMatch(r.stdout, /STUB-WRANGLER/, "dry run must not execute wrangler");
});

test("MAINPREP1 set-mainnet-secrets.sh DRY_RUN names every secret, never prints key material; refuses without GO", () => {
  const keys = mkdtempSync(path.join(tmpdir(), "mp1-keys-"));
  const SECRET = "ed25519:FAKEPRIVATEKEYMATERIALnotreal1234567890abcdefghijkLMNOP";
  for (const role of ["relayer", "keeper", "attest"]) { mkdirSync(path.join(keys, role)); writeFileSync(path.join(keys, role, "x.json"), JSON.stringify({ private_key: SECRET, public_key: "ed25519:pub" })); }
  writeFileSync(path.join(keys, "oneclick.env"), "ONECLICK_API_KEY=FAKEPRIVATEKEYMATERIALoneclick\n"); // F1: never the real operator secrets file
  const r = run("set-mainnet-secrets.sh", { DRY_RUN: "1", KEYS: keys, ALERTS_ENV: path.join(keys, "none.env"), ONECLICK_ENV: path.join(keys, "oneclick.env") });
  assert.equal(r.status, 0, r.stderr);
  for (const n of ["ONECLICK_API_KEY", "RELAYER_PRIVATE_KEY", "KEEPER_PRIVATE_KEY", "SOURCECHECK_ATTEST_PRIVATE_KEY", "NOTIFIER_CONTACT_KEY"]) assert.match(r.stdout, new RegExp(n));
  assert.doesNotMatch(r.stdout + r.stderr, /FAKEPRIVATEKEYMATERIAL/);
  assert.match(r.stderr, /ALERT_TELEGRAM_BOT_TOKEN/);
  const g = run("set-mainnet-secrets.sh", { KEYS: keys, ONECLICK_ENV: path.join(keys, "oneclick.env") });
  assert.equal(g.status, 3);
});

// F1: the funding Worker's ONECLICK_API_KEY is piped from $PRAETORIAL_SECRETS_DIR/praetorial-oneclick.env (ONECLICK_ENV) to
// `wrangler secret put ONECLICK_API_KEY --env mainnet` on stdin: exact value, never on a command line, never printed.
function fakeKeys() {
  const keys = mkdtempSync(path.join(tmpdir(), "f1-keys-"));
  for (const role of ["relayer", "keeper", "attest"]) { mkdirSync(path.join(keys, role)); writeFileSync(path.join(keys, role, "x.json"), JSON.stringify({ private_key: "ed25519:FAKEPRIVATEKEYMATERIALnotreal1234567890abcdefghijkLMNOP" })); }
  return keys;
}
const ONECLICK = "eyJhbGciOiJIUzI1NiJ9.F1FAKEONECLICKPARTNERJWT.c2lnbmF0dXJl";

test("F1 set-mainnet-secrets.sh DRY_RUN names funding ONECLICK_API_KEY and never prints its value", () => {
  const keys = fakeKeys(); const env1 = path.join(keys, "oneclick.env"); writeFileSync(env1, `ONECLICK_API_KEY=${ONECLICK}\n`);
  const r = run("set-mainnet-secrets.sh", { DRY_RUN: "1", KEYS: keys, ALERTS_ENV: path.join(keys, "none.env"), ONECLICK_ENV: env1 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cd funding .*ONECLICK_API_KEY --env mainnet/);
  assert.doesNotMatch(r.stdout + r.stderr, /F1FAKEONECLICK/);
});

test("F1 set-mainnet-secrets.sh (GO, stub wrangler) pipes exactly the key on stdin (export/quotes stripped), output never shows it", () => {
  const keys = fakeKeys(); const cap = mkdtempSync(path.join(tmpdir(), "f1-cap-"));
  const stub = path.join(cap, "wr"); writeFileSync(stub, `#!/bin/sh\nif [ "$1" = secret ] && [ "$2" = put ]; then cat > "${cap}/$3"; fi\nexit 0\n`); chmodSync(stub, 0o755);
  for (const line of [`ONECLICK_API_KEY=${ONECLICK}`, `export ONECLICK_API_KEY="${ONECLICK}"`, `# comment\nOTHER=x\nONECLICK_API_KEY='${ONECLICK}'\r`]) {
    const env1 = path.join(keys, "oneclick.env"); writeFileSync(env1, `${line}\n`);
    const r = run("set-mainnet-secrets.sh", { PRAETORIAL_MAINNET_GO: "GO", KEYS: keys, ALERTS_ENV: path.join(keys, "none.env"), ONECLICK_ENV: env1, WRANGLER: stub });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(path.join(cap, "ONECLICK_API_KEY"), "utf8"), ONECLICK, line);
    assert.match(r.stdout, /set funding ONECLICK_API_KEY/);
    assert.doesNotMatch(r.stdout + r.stderr, /F1FAKEONECLICK/);
  }
});

test("F1 set-mainnet-secrets.sh fails (exit 1) when the oneclick env file or its ONECLICK_API_KEY line is missing, without printing the file", () => {
  const keys = fakeKeys(); const env1 = path.join(keys, "oneclick.env"); writeFileSync(env1, "SOMETHING_ELSE=F1FAKEONECLICKVALUE\n");
  for (const f of [env1, path.join(keys, "missing.env")]) {
    const r = run("set-mainnet-secrets.sh", { DRY_RUN: "1", KEYS: keys, ALERTS_ENV: path.join(keys, "none.env"), ONECLICK_ENV: f });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /ONECLICK_API_KEY/);
    assert.doesNotMatch(r.stdout + r.stderr, /F1FAKEONECLICKVALUE/);
  }
});

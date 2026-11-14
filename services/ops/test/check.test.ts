import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOps, readRelease, runCheckCli } from "../src/check.js";
import { SECRET_MARK, TESTNET_RECORD, MAINNET_RECORD, testnetEnv, mainnetEnv, tmpDir, writeEnvFile, writeRelease, capture } from "./helpers.js";

const tnRel = { escrow: "praetorial-esc.testnet", resolver: "praetorial-res.testnet" };
const mnRel = { escrow: "praetorial.near", resolver: "resolver.praetorial.near" };
const fails = (r: ReturnType<typeof checkOps>) => r.findings.filter((f) => f.verdict === "FAIL");

test("readRelease: freeze-record shapes per network; placeholders and missing ids are errors", () => {
  const d = tmpDir();
  assert.deepEqual(readRelease(writeRelease(d, TESTNET_RECORD), "testnet"), tnRel);
  assert.deepEqual(readRelease(writeRelease(d, MAINNET_RECORD, "m.json"), "mainnet"), mnRel);
  assert.throws(() => readRelease(writeRelease(d, { testnet_escrow: { account: "PENDING FRZ1b" } }, "p.json"), "testnet"), /escrow/i);
  assert.throws(() => readRelease(writeRelease(d, { commit: "abc" }, "n.json"), "testnet"), /escrow/i);
  assert.throws(() => readRelease(writeRelease(d, TESTNET_RECORD), "mainnet"), /escrow/i);
  assert.throws(() => readRelease(d + "/nope.json", "testnet"), /release/i);
});

test("good testnet env passes", () => {
  const r = checkOps({ network: "testnet", env: testnetEnv(), release: tnRel });
  assert.deepEqual(fails(r), []);
  assert.equal(r.ok, true);
});

test("good mainnet env passes", () => {
  const r = checkOps({ network: "mainnet", env: mainnetEnv(), release: mnRel });
  assert.deepEqual(fails(r), []);
});

test("different escrow id in ESCROW_CONTRACT_ID fails", () => {
  const r = checkOps({ network: "testnet", env: { ...testnetEnv(), ESCROW_CONTRACT_ID: "other.testnet" }, release: tnRel });
  assert.equal(r.ok, false);
  assert.ok(fails(r).some((f) => f.name === "ESCROW_CONTRACT_ID" && /escrow/i.test(f.reason)));
});

test("ESCROW_CONTRACTS naming any other id fails; matching id with version passes", () => {
  const base: Record<string, string> = testnetEnv(); delete base.ESCROW_CONTRACT_ID;
  // The treasury runner requireEnv()s ESCROW_CONTRACT_ID directly, so it is the only service that still needs it.
  const only = checkOps({ network: "testnet", env: { ...base, ESCROW_CONTRACTS: "praetorial-esc.testnet@v2" }, release: tnRel });
  assert.deepEqual(fails(only).map((f) => `${f.service}:${f.name}`), ["treasury:ESCROW_CONTRACT_ID"]);
  assert.equal(checkOps({ network: "testnet", env: { ...base, ESCROW_CONTRACT_ID: "praetorial-esc.testnet", ESCROW_CONTRACTS: "praetorial-esc.testnet@v2" }, release: tnRel }).ok, true);
  const bad = checkOps({ network: "testnet", env: { ...base, ESCROW_CONTRACTS: "praetorial-esc.testnet@v2,old.testnet@v1" }, release: tnRel });
  assert.equal(bad.ok, false);
  assert.ok(fails(bad).some((f) => f.name === "ESCROW_CONTRACTS"));
});

test("no escrow var at all fails", () => {
  const e: Record<string, string> = testnetEnv(); delete e.ESCROW_CONTRACT_ID;
  assert.equal(checkOps({ network: "testnet", env: e, release: tnRel }).ok, false);
});

test("NEAR_NETWORK_ID disagreeing with --network (or unset) fails", () => {
  assert.equal(checkOps({ network: "mainnet", env: { ...mainnetEnv(), NEAR_NETWORK_ID: "testnet" }, release: mnRel }).ok, false);
  const e: Record<string, string> = testnetEnv(); delete e.NEAR_NETWORK_ID;
  const r = checkOps({ network: "testnet", env: e, release: tnRel });
  assert.ok(fails(r).some((f) => f.name === "NEAR_NETWORK_ID"));
});

test("mainnet: any id ending .testnet fails", () => {
  const r = checkOps({ network: "mainnet", env: { ...mainnetEnv(), KEEPER_ACCOUNT_ID: "keeper.testnet" }, release: mnRel });
  assert.ok(fails(r).some((f) => f.name === "KEEPER_ACCOUNT_ID" && /testnet/.test(f.reason)));
  const r2 = checkOps({ network: "mainnet", env: { ...mainnetEnv(), USDC_TOKEN_ID: "usdc.fakes.testnet" }, release: mnRel });
  assert.ok(fails(r2).some((f) => f.name === "USDC_TOKEN_ID"));
  const r3 = checkOps({ network: "mainnet", env: mainnetEnv(), release: { escrow: "praetorial.testnet", resolver: mnRel.resolver } });
  assert.equal(r3.ok, false);
});

test("mainnet: empty/blank NEAR_RPC_FALLBACKS fails (D-RPC1 needs >=1); testnet does not need it", () => {
  for (const v of [undefined, "", " , "]) {
    const e: Record<string, string> = { ...mainnetEnv() };
    if (v === undefined) delete e.NEAR_RPC_FALLBACKS; else e.NEAR_RPC_FALLBACKS = v;
    const r = checkOps({ network: "mainnet", env: e, release: mnRel });
    assert.ok(fails(r).some((f) => f.name === "NEAR_RPC_FALLBACKS"), `value ${JSON.stringify(v)}`);
  }
  assert.equal(checkOps({ network: "testnet", env: testnetEnv(), release: tnRel }).ok, true);
});

test("HEARTBEAT_DIR unset fails for each MON4 service (not treasury/indexer)", () => {
  const e: Record<string, string> = testnetEnv(); delete e.HEARTBEAT_DIR;
  const r = checkOps({ network: "testnet", env: e, release: tnRel });
  const svcs = fails(r).filter((f) => f.name === "HEARTBEAT_DIR").map((f) => f.service).sort();
  assert.deepEqual(svcs, ["keeper", "monitor:alerts", "notifier", "relayer"]);
});

test("mainnet: both Telegram alert vars required; testnet only warns", () => {
  for (const drop of ["ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID"]) {
    const e: Record<string, string> = { ...mainnetEnv() }; delete e[drop];
    assert.ok(fails(checkOps({ network: "mainnet", env: e, release: mnRel })).some((f) => f.name === drop), drop);
  }
  assert.equal(checkOps({ network: "testnet", env: testnetEnv(), release: tnRel }).ok, true);
});

test("missing required per-service var fails and names the service", () => {
  const e: Record<string, string> = testnetEnv(); delete e.KEEPER_KEY_FILE;
  const r = checkOps({ network: "testnet", env: e, release: tnRel });
  assert.ok(fails(r).some((f) => f.service === "keeper" && f.name === "KEEPER_KEY_FILE"));
});

test("empty value counts as unset", () => {
  const r = checkOps({ network: "testnet", env: { ...testnetEnv(), KEEPER_KEY_FILE: "" }, release: tnRel });
  assert.equal(r.ok, false);
});

test("CLI: exit 0 ok, never prints a value, prints names + verdicts", async () => {
  const d = tmpDir();
  const env = writeEnvFile(d, testnetEnv()); const rel = writeRelease(d, TESTNET_RECORD);
  const c = capture();
  const code = await runCheckCli(["--network", "testnet", "--env-file", env, "--release", rel], c.io);
  assert.equal(code, 0);
  const t = c.text();
  assert.ok(!t.includes(SECRET_MARK));
  assert.ok(!t.includes("/keys/keeper.json"), "paths/values must not be printed");
  assert.match(t, /NOTIFIER_CONTACT_KEY/); assert.match(t, /\bok\b/);
});

test("CLI: exit 1 on config error; offending values not echoed", async () => {
  const d = tmpDir();
  const env = writeEnvFile(d, { ...testnetEnv(), ESCROW_CONTRACT_ID: "other.testnet" }); const rel = writeRelease(d, TESTNET_RECORD);
  const c = capture();
  assert.equal(await runCheckCli(["--network", "testnet", "--env-file", env, "--release", rel], c.io), 1);
  assert.ok(!c.text().includes(SECRET_MARK));
  assert.ok(!c.text().includes("other.testnet"), "offending value must not be echoed");
});

test("CLI: exit 1 when env file or release is unreadable / release id missing", async () => {
  const d = tmpDir();
  const rel = writeRelease(d, TESTNET_RECORD); const env = writeEnvFile(d, testnetEnv());
  assert.equal(await runCheckCli(["--network", "testnet", "--env-file", d + "/none", "--release", rel], capture().io), 1);
  assert.equal(await runCheckCli(["--network", "testnet", "--env-file", env, "--release", d + "/none"], capture().io), 1);
  assert.equal(await runCheckCli(["--network", "mainnet", "--env-file", env, "--release", rel], capture().io), 1);
});

test("CLI: exit 2 on usage errors", async () => {
  const d = tmpDir(); const env = writeEnvFile(d, testnetEnv()); const rel = writeRelease(d, TESTNET_RECORD);
  for (const argv of [[], ["--network", "testnet"], ["--network", "devnet", "--env-file", env, "--release", rel], ["--network", "testnet", "--env-file", env], ["--bogus"], ["--network", "testnet", "--env-file", env, "--release", rel, "--wat"]]) {
    assert.equal(await runCheckCli(argv, capture().io), 2, JSON.stringify(argv));
  }
});

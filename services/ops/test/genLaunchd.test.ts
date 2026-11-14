import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePlists, runGenLaunchdCli } from "../src/genLaunchd.js";
import { SERVICES } from "../src/serviceEnv.js";
import { SECRET_MARK, testnetEnv, tmpDir, writeEnvFile, capture } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPTS = { servicesDir: "/srv/praetorial/services", envFile: "/etc/praetorial/svc.env", logsDir: "/var/log/praetorial", nodePath: "/opt/homebrew/bin/node", wrapperPath: "/srv/out/praetorial-run.sh" };

test("one plist per service, plus the wrapper script", () => {
  const g = generatePlists(OPTS);
  assert.deepEqual(g.plists.map((p) => p.service), SERVICES.map((s) => s.name));
  assert.deepEqual(g.plists.map((p) => p.fileName), ["com.praetorial.keeper.plist", "com.praetorial.indexer.plist", "com.praetorial.notifier.plist", "com.praetorial.relayer.plist", "com.praetorial.monitor-alerts.plist", "com.praetorial.treasury.plist"]);
  assert.match(g.wrapper.content, /^#!\/bin\/bash/);
  assert.match(g.wrapper.content, /set -a/); assert.match(g.wrapper.content, /exec "\$@"/);
});

test("snapshot: keeper plist", () => {
  const keeper = generatePlists(OPTS).plists.find((p) => p.service === "keeper")!;
  assert.equal(keeper.content, fs.readFileSync(path.join(HERE, "fixtures/keeper.plist.snap"), "utf8"));
});

test("every plist: KeepAlive, RunAtLoad, ThrottleInterval 10, log paths, WorkingDirectory, node --import tsx runner", () => {
  for (const p of generatePlists(OPTS).plists) {
    const c = p.content; const s = SERVICES.find((x) => x.name === p.service)!;
    assert.match(c, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(c, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(c, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    assert.match(c, /<key>WorkingDirectory<\/key>\s*<string>\/srv\/praetorial\/services<\/string>/);
    assert.match(c, /<key>StandardOutPath<\/key>\s*<string>\/var\/log\/praetorial\/[^<]+\.out\.log<\/string>/);
    assert.match(c, /<key>StandardErrorPath<\/key>\s*<string>\/var\/log\/praetorial\/[^<]+\.err\.log<\/string>/);
    for (const part of ["/etc/praetorial/svc.env", "/opt/homebrew/bin/node", "--import", "tsx", `/srv/praetorial/services/${s.runner}`]) assert.ok(c.includes(`<string>${part}</string>`), `${p.service} missing ${part}`);
    assert.ok(!c.includes("EnvironmentVariables"), "no inline env in plists");
  }
});

test("no env values are ever inlined (CLI reads env file, plists only carry its path)", async () => {
  const d = tmpDir(); const out = path.join(d, "out");
  const f = writeEnvFile(d, { ...testnetEnv(), ALERT_TELEGRAM_BOT_TOKEN: SECRET_MARK });
  const c = capture();
  assert.equal(await runGenLaunchdCli(["--env-file", f, "--out", out], c.io, { servicesDir: "/srv/praetorial/services" }), 0);
  const files = fs.readdirSync(out);
  assert.equal(files.filter((n) => n.endsWith(".plist")).length, SERVICES.length);
  assert.ok(files.includes("praetorial-run.sh"));
  for (const n of files) { const fp = path.join(out, n); if (fs.statSync(fp).isFile()) assert.ok(!fs.readFileSync(fp, "utf8").includes(SECRET_MARK), n); }
  assert.ok(!c.text().includes(SECRET_MARK));
  assert.ok(fs.statSync(path.join(out, "praetorial-run.sh")).mode & 0o100, "wrapper is executable");
  assert.ok(fs.readFileSync(path.join(out, "com.praetorial.keeper.plist"), "utf8").includes(f));
});

test("CLI usage/config errors: exit 2 usage, exit 1 missing env file", async () => {
  const d = tmpDir();
  assert.equal(await runGenLaunchdCli([], capture().io, {}), 2);
  assert.equal(await runGenLaunchdCli(["--env-file", "x"], capture().io, {}), 2);
  assert.equal(await runGenLaunchdCli(["--env-file", d + "/none", "--out", d + "/o"], capture().io, {}), 1);
});

test("plutil -lint passes on every plist (lint step skipped only when plutil is absent)", (t) => {
  const has = spawnSync("sh", ["-c", "command -v plutil"]).status === 0;
  if (!has) { t.diagnostic("plutil absent: lint step skipped"); return; }
  const d = tmpDir();
  for (const p of generatePlists(OPTS).plists) {
    const fp = path.join(d, p.fileName); fs.writeFileSync(fp, p.content);
    const r = spawnSync("plutil", ["-lint", fp], { encoding: "utf8" });
    assert.equal(r.status, 0, `${p.fileName}: ${r.stdout}${r.stderr}`);
  }
});

// PUB1: `publish-snapshot` exports `git archive <ref>`, scans it for secrets, writes PUBLISH-MANIFEST.json. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.ts");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const git = (cwd: string, ...a: string[]) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", ...a], { cwd, encoding: "utf8" });

// Fake secrets are assembled at runtime so this test file itself never matches the scanner.
const FAKE_SK = "sk" + "-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
const FAKE_ED = "ed25519" + ":" + "3".repeat(44);
const ENV_VAL = "zzEnvValueNotARealSecret123456";

function repo(files: Record<string, string>) {
  const d = tmp("pub1-repo-");
  git(d, "init", "-q", "-b", "main");
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  git(d, "add", "-A", "-f");
  git(d, "commit", "-q", "-m", "x");
  return d;
}
function lic(content = "MIT placeholder\n") { const f = join(tmp("pub1-lic-"), "LICENSE"); writeFileSync(f, content); return f; }
function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, "publish-snapshot", "--repo", cwd, ...args], { cwd: join(here, "..", ".."), encoding: "utf8" });
}
const emptyOut = () => join(tmp("pub1-out-"), "snap");
const manifest = (out: string) => JSON.parse(readFileSync(join(out, "PUBLISH-MANIFEST.json"), "utf8"));

test("clean repo: exports, manifest has ref/commit/tree/counts/clean scan", () => {
  const d = repo({ "a.txt": "hello\n", "src/b.ts": "export const x = 1;\n" });
  const out = emptyOut();
  const r = run(d, ["--ref", "HEAD", "--out", out, "--license", lic()]);
  assert.equal(r.status, 0, r.stderr);
  const m = manifest(out);
  assert.equal(m.ref, "HEAD");
  assert.equal(m.commit, git(d, "rev-parse", "HEAD").stdout.trim());
  assert.equal(m.tree, git(d, "rev-parse", "HEAD^{tree}").stdout.trim());
  assert.equal(m.excluded_count, 0);
  assert.equal(m.scan.status, "clean");
  assert.equal(m.scan.hits.length, 0);
  assert.ok(existsSync(join(out, "a.txt")));
  assert.ok(existsSync(join(out, "LICENSE")));
  assert.ok(m.file_count >= 2);
});

test("refuses non-empty out dir", () => {
  const d = repo({ "a.txt": "x\n" });
  const out = tmp("pub1-full-"); writeFileSync(join(out, "keep"), "1");
  const r = run(d, ["--ref", "HEAD", "--out", out, "--license", lic()]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REFUSED.*not empty/i);
  assert.deepEqual(readdirSync(out), ["keep"]);
});

test("refuses missing, absent and empty license", () => {
  const d = repo({ "a.txt": "x\n" });
  let r = run(d, ["--ref", "HEAD", "--out", emptyOut()]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /--license/);
  r = run(d, ["--ref", "HEAD", "--out", emptyOut(), "--license", "/nonexistent/LICENSE"]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /license/i);
  r = run(d, ["--ref", "HEAD", "--out", emptyOut(), "--license", lic("")]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /license.*empty/i);
});

test("planted fake key -> refused with file:line + rule, value never printed", () => {
  const d = repo({ "ok.txt": "fine\n", "cfg/app.ts": `line1\nconst k = "${FAKE_SK}";\n` });
  const out = emptyOut();
  const r = run(d, ["--ref", "HEAD", "--out", out, "--license", lic()]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /cfg\/app\.ts:2/);
  assert.match(r.stderr + r.stdout, /sk-/);
  assert.ok(!(r.stderr + r.stdout).includes(FAKE_SK));
  const m = manifest(out);
  assert.notEqual(m.scan.status, "clean");
  assert.equal(m.scan.hits[0].path, "cfg/app.ts");
  assert.equal(m.scan.hits[0].line, 2);
  assert.ok(!JSON.stringify(m).includes(FAKE_SK));
});

test("other rules: ed25519 private_key, PEM, AKIA, ghp_, github_pat_, xox, telegram", () => {
  const cases: Record<string, string> = {
    ed: `{"private_key": "${FAKE_ED}"}`,
    pem: "-----BEGIN " + "PRIVATE KEY-----",
    aws: "AKIA" + "ABCDEFGHIJKLMNOP",
    ghp: "ghp" + "_" + "a".repeat(36),
    pat: "github" + "_pat_" + "a".repeat(30),
    slack: "xox" + "b-" + "1234567890-abcdefghij",
    tg: "123456789" + ":" + "A".repeat(35),
    ant: "sk" + "-ant-" + "api03-" + "a".repeat(30),
  };
  const d = repo(Object.fromEntries(Object.entries(cases).map(([k, v]) => [`f_${k}.txt`, v + "\n"])));
  const out = emptyOut();
  const r = run(d, ["--ref", "HEAD", "--out", out, "--license", lic()]);
  assert.notEqual(r.status, 0);
  const m = manifest(out);
  const hit = new Set(m.scan.hits.map((h: { path: string }) => h.path));
  for (const k of Object.keys(cases)) assert.ok(hit.has(`f_${k}.txt`), `no hit for ${k}`);
});

test("short ed25519 dummy is not a hit", () => {
  const d = repo({ "t.ts": `const o = { private_key: "ed25519:y" };\n` });
  assert.equal(run(d, ["--ref", "HEAD", "--out", emptyOut(), "--license", lic()]).status, 0);
});

test("allowlist: path+rule match passes, reason required, other path still fails", () => {
  const d = repo({ "fixtures/fake.rs": `let k = "${FAKE_SK}";\n` });
  const al = join(tmp("pub1-al-"), "allow.json");
  writeFileSync(al, JSON.stringify([{ path: "fixtures/fake.rs", rule: "sk-key", reason: "redaction test fixture" }]));
  const out = emptyOut();
  const r = run(d, ["--ref", "HEAD", "--out", out, "--license", lic(), "--allowlist", al]);
  assert.equal(r.status, 0, r.stderr);
  const m = manifest(out);
  assert.equal(m.scan.status, "clean");
  assert.equal(m.scan.allowlisted.length, 1);

  writeFileSync(al, JSON.stringify([{ path: "fixtures/fake.rs", rule: "pem-private-key", reason: "wrong rule" }]));
  assert.notEqual(run(d, ["--ref", "HEAD", "--out", emptyOut(), "--license", lic(), "--allowlist", al]).status, 0);

  writeFileSync(al, JSON.stringify([{ path: "fixtures/fake.rs", rule: "sk-key" }]));
  const r2 = run(d, ["--ref", "HEAD", "--out", emptyOut(), "--license", lic(), "--allowlist", al]);
  assert.notEqual(r2.status, 0); assert.match(r2.stderr, /reason/);
});

test("node_modules excluded and counted", () => {
  const d = repo({ "a.txt": "x\n", "node_modules/p/i.js": "1\n", "services/node_modules/q/j.js": `${FAKE_SK}\n`, "services/node_modules/q/k.js": "2\n" });
  const out = emptyOut();
  const r = run(d, ["--ref", "HEAD", "--out", out, "--license", lic()]);
  assert.equal(r.status, 0, r.stderr);
  const m = manifest(out);
  assert.equal(m.excluded_count, 3);
  assert.ok(!existsSync(join(out, "node_modules")));
  assert.ok(!existsSync(join(out, "services", "node_modules")));
});

test("--secrets-env exact-value match: reports file:line + KEY only", () => {
  const d = repo({ "docs/n.md": `note\nvalue is ${ENV_VAL} here\n` });
  const envd = tmp("pub1-env-");
  const e = join(envd, "x.env");
  writeFileSync(e, `SHORT=abc\nMY_TOKEN="${ENV_VAL}"\n# C=${"q".repeat(20)}\n`);
  const out = emptyOut();
  const r = run(d, ["--ref", "HEAD", "--out", out, "--license", lic(), "--secrets-env", e]);
  assert.notEqual(r.status, 0);
  const all = r.stdout + r.stderr;
  assert.match(all, /docs\/n\.md:2/);
  assert.match(all, /MY_TOKEN/);
  assert.ok(!all.includes(ENV_VAL));
  const raw = readFileSync(join(out, "PUBLISH-MANIFEST.json"), "utf8");
  assert.ok(!raw.includes(ENV_VAL));
  const m = JSON.parse(raw);
  assert.equal(m.scan.hits[0].key, "MY_TOKEN");
  assert.notEqual(m.scan.status, "clean");
});

test("missing --secrets-env file is refused (never silently skipped)", () => {
  const d = repo({ "a.txt": "x\n" });
  const r = run(d, ["--ref", "HEAD", "--out", emptyOut(), "--license", lic(), "--secrets-env", "/nonexistent/x.env"]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /secrets-env/);
});

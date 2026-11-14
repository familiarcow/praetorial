// PUB1: export `git archive <ref>` to an empty dir, exclude node_modules, scan for secrets, write PUBLISH-MANIFEST.json.
// Scans the snapshot tree only (NOT git history). Secret values are never printed or written.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ReleaseError } from "./gen.js";

export interface PublishOpts { ref: string; out: string; license: string; secretsEnv: string[]; allowlist?: string; repo?: string }
export interface Hit { path: string; line: number; rule: string; key?: string }
interface AllowEntry { path: string; rule: string; reason: string }

const RULES: Array<[string, RegExp]> = [
  ["sk-ant-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["sk-key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["ghp-token", /\bghp_[A-Za-z0-9]{30,}/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ["aws-akia", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[bp]-[A-Za-z0-9-]{10,}/],
  ["telegram-bot-token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["pem-private-key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["ed25519-key", /(?:private_key|secret_key)["']?\s*[:=]\s*["']?ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/],
];

export function parseEnvValues(file: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (v.length >= 16) out.push({ key: m[1], value: v });
  }
  return out;
}

function loadAllowlist(file?: string): AllowEntry[] {
  if (!file) return [];
  if (!existsSync(file)) throw new ReleaseError(`--allowlist file not found`);
  const arr = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(arr)) throw new ReleaseError("allowlist must be a JSON array");
  return arr.map((e: Partial<AllowEntry>, i) => {
    if (!e?.path || !e.rule) throw new ReleaseError(`allowlist entry ${i}: path and rule are required`);
    if (!e.reason || !String(e.reason).trim()) throw new ReleaseError(`allowlist entry ${i} (${e.path}): a reason is required`);
    return { path: e.path, rule: e.rule, reason: e.reason };
  });
}

function walk(dir: string, base: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isDirectory()) walk(p, base, acc);
    else if (st.isFile()) acc.push(relative(base, p).split("\\").join("/"));
  }
  return acc;
}

export function publishSnapshot(o: PublishOpts) {
  if (!o.ref) throw new ReleaseError("--ref is required");
  if (!o.out) throw new ReleaseError("--out is required");
  if (!o.license) throw new ReleaseError("--license is required");
  if (!existsSync(o.license) || !statSync(o.license).isFile()) throw new ReleaseError("license file not found");
  if (statSync(o.license).size === 0) throw new ReleaseError("license file is empty");
  if (existsSync(o.out) && readdirSync(o.out).length > 0) throw new ReleaseError(`out dir ${o.out} is not empty`);
  for (const e of o.secretsEnv) if (!existsSync(e)) throw new ReleaseError(`--secrets-env file not found: ${e}`);
  const allow = loadAllowlist(o.allowlist);
  const cwd = o.repo ?? process.cwd();
  const g = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  let commit: string, tree: string;
  try { commit = g("rev-parse", "--verify", `${o.ref}^{commit}`); tree = g("rev-parse", "--verify", `${o.ref}^{tree}`); }
  catch { throw new ReleaseError(`cannot resolve ref ${o.ref}`); }

  mkdirSync(o.out, { recursive: true });
  const r = spawnSync("sh", ["-c", 'git archive "$1" | tar -x -C "$2"', "sh", commit, o.out], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new ReleaseError("git archive/extract failed");

  // exclude node_modules
  let files = walk(o.out, o.out);
  const nm = files.filter((f) => f.split("/").includes("node_modules"));
  const nmDirs = new Set(nm.map((f) => { const p = f.split("/"); return p.slice(0, p.indexOf("node_modules") + 1).join("/"); }));
  for (const d of nmDirs) rmSync(join(o.out, d), { recursive: true, force: true });
  files = walk(o.out, o.out);
  copyFileSync(o.license, join(o.out, "LICENSE"));

  const envVals = o.secretsEnv.flatMap((f) => parseEnvValues(f));
  const hits: Hit[] = [];
  const allowlisted: Array<Hit & { reason: string }> = [];
  const add = (h: Hit) => {
    const a = allow.find((e) => e.path === h.path && e.rule === h.rule);
    if (a) allowlisted.push({ ...h, reason: a.reason }); else hits.push(h);
  };
  for (const f of files) {
    const lines = readFileSync(join(o.out, f)).toString("latin1").split("\n");
    lines.forEach((ln, i) => {
      for (const [rule, re] of RULES) if (re.test(ln)) add({ path: f, line: i + 1, rule });
      const seen = new Set<string>();
      for (const ev of envVals) if (!seen.has(ev.key) && ln.includes(ev.value)) { seen.add(ev.key); add({ path: f, line: i + 1, rule: "env-value", key: ev.key }); }
    });
  }
  const manifest = {
    ref: o.ref, commit, tree,
    file_count: files.length + 1, // + LICENSE
    excluded_count: nm.length,
    scan: { status: hits.length === 0 ? "clean" : "dirty", hits, allowlisted, history_scanned: false, secrets_env_files: o.secretsEnv.length, secrets_env_values: envVals.length },
  };
  writeFileSync(join(o.out, "PUBLISH-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

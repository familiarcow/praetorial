// CF1e: tail all five testnet Workers for N seconds and write a SANITIZED per-invocation summary
// (worker, trigger, outcome, cpuTime ms, wallTime ms) to tail/summary.json. Raw events (they carry client IPs) go to $TMPDIR only.
// usage: node collect_tail.mjs <seconds>   (CLOUDFLARE_* in env)
import { spawn } from "node:child_process";
import fs from "node:fs";
const secs = Number(process.argv[2] ?? 240);
const dir = new URL(".", import.meta.url).pathname;
const tmp = process.env.TMPDIR ?? "/tmp";
const names = ["keeper", "relayer", "monitor", "notifier", "indexer"];
const procs = names.map((n) => {
  const out = fs.openSync(`${tmp}/cf1e-${n}.raw`, "w");
  return spawn("npx", ["wrangler", "tail", "--format", "json"], { cwd: `${dir}../../workers/${n}`, stdio: ["ignore", out, "ignore"] });
});
await new Promise((r) => setTimeout(r, secs * 1000));
for (const p of procs) p.kill("SIGINT");
await new Promise((r) => setTimeout(r, 3000));
const rows = [];
for (const n of names) {
  const txt = fs.readFileSync(`${tmp}/cf1e-${n}.raw`, "utf8");
  // wrangler prints concatenated pretty JSON objects; split on top-level "}\n{"
  const parts = txt.split(/\n(?=\{\n)/).map((s) => s.trim()).filter(Boolean);
  for (const s of parts) {
    let e; try { e = JSON.parse(s); } catch { continue; }
    const ev = e.event ?? {};
    const trigger = ev.cron ? `cron ${ev.cron}` : ev.request ? `${ev.request.method} ${new URL(ev.request.url).pathname}` : ev.rpcMethod ? `rpc ${ev.rpcMethod}` : Object.keys(ev).join(",") || "other";
    rows.push({ worker: e.scriptName, trigger, outcome: e.outcome, cpuMs: e.cpuTime, wallMs: e.wallTime, ts: e.eventTimestamp, exceptions: (e.exceptions ?? []).length, logs: (e.logs ?? []).map((l) => (l.message ?? []).join(" ").slice(0, 200)) });
  }
}
rows.sort((a, b) => a.ts - b.ts);
fs.mkdirSync(`${dir}tail`, { recursive: true });
fs.writeFileSync(`${dir}tail/summary.json`, JSON.stringify(rows, null, 1));
const byW = {};
for (const r of rows) { const w = (byW[r.worker] ??= { n: 0, maxCpu: 0, fails: 0 }); w.n++; w.maxCpu = Math.max(w.maxCpu, r.cpuMs ?? 0); if (r.outcome !== "ok") w.fails++; }
console.log(JSON.stringify(byW));

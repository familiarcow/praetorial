// CF1e2: tail ONE worker at a time (multi-worker tail only delivered indexer events). Sanitized rows -> tail/<worker>.json
// usage: node collect_one.mjs <worker> <seconds> [url-to-hit-every-10s]   (CLOUDFLARE_* in env)
import { spawn } from "node:child_process";
import fs from "node:fs";
const [n, secs, url] = [process.argv[2], Number(process.argv[3] ?? 330), process.argv[4]];
const dir = new URL(".", import.meta.url).pathname;
const tmp = process.env.TMPDIR ?? "/tmp";
const out = fs.openSync(`${tmp}/cf1e2-${n}.raw`, "w");
const p = spawn("npx", ["wrangler", "tail", "--format", "json"], { cwd: `${dir}../../workers/${n}`, stdio: ["ignore", out, "ignore"] });
const end = Date.now() + secs * 1000;
await new Promise((r) => setTimeout(r, 15000));
while (Date.now() < end) { if (url) { try { await fetch(url); } catch {} } await new Promise((r) => setTimeout(r, 10000)); }
p.kill("SIGINT");
await new Promise((r) => setTimeout(r, 3000));
const txt = fs.readFileSync(`${tmp}/cf1e2-${n}.raw`, "utf8");
const rows = [];
for (const s of txt.split(/\n(?=\{\n)/).map((x) => x.trim()).filter(Boolean)) {
  let e; try { e = JSON.parse(s); } catch { continue; }
  const ev = e.event ?? {};
  const trigger = ev.cron ? `cron ${ev.cron}` : ev.request ? `${ev.request.method} ${new URL(ev.request.url).pathname}` : ev.rpcMethod ? `rpc ${ev.rpcMethod}` : Object.keys(ev).join(",") || "other";
  rows.push({ worker: e.scriptName, entrypoint: e.entrypoint, trigger, outcome: e.outcome, cpuMs: e.cpuTime, wallMs: e.wallTime, ts: e.eventTimestamp, exceptions: (e.exceptions ?? []).length });
}
fs.writeFileSync(`${dir}tail/${n}.json`, JSON.stringify(rows, null, 1));
console.log(n, rows.length, "events");

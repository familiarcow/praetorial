#!/usr/bin/env node
// CF1f / D-CF1F1: summarize a `wrangler tail praetorial-registry-testnet --format json` capture (single-worker tail).
// usage: node count_outcomes.mjs [tail_registry.json]   (default: tail_registry.json next to this script)
// PASS = >= 60 requests, >= 1 POST /claim, zero exceededCpu, zero non-ok outcomes. cpuTime p50/max are recorded (max > 8 ms alone is not a failure).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
function* jsonValues(text) {
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { if (depth > 0) inStr = true; continue; }
    if (c === "{") { if (depth++ === 0) start = i; }
    else if (c === "}" && depth > 0 && --depth === 0) { try { yield JSON.parse(text.slice(start, i + 1)); } catch { /* skip partial */ } }
  }
}
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
export function summarizeTail(text) {
  const outcomes = {}, byRoute = {}; const cpu = []; let events = 0, claims = 0;
  for (const e of jsonValues(text)) {
    if (typeof e !== "object" || !("outcome" in e)) continue;
    events++; outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
    if (typeof e.cpuTime === "number") cpu.push(e.cpuTime);
    const r = e.event?.request;
    if (r) {
      const p = new URL(r.url).pathname;
      const route = `${r.method} ${p.startsWith("/lookup/account") ? "/lookup/account" : p.startsWith("/lookup/username") ? "/lookup/username" : p}`;
      byRoute[route] = (byRoute[route] ?? 0) + 1;
      if (r.method === "POST" && p === "/claim") claims++;
    }
  }
  return { events, claims, outcomes, byRoute, exceededCpu: outcomes.exceededCpu ?? 0, nonOk: events - (outcomes.ok ?? 0), cpuP50: pct(cpu, 0.5), cpuMax: cpu.length ? Math.max(...cpu) : null };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "tail_registry.json");
  const s = summarizeTail(fs.readFileSync(file, "utf8"));
  const pass = s.events >= 60 && s.claims >= 1 && s.exceededCpu === 0 && s.nonOk === 0;
  console.log(`file: ${path.basename(file)}`);
  console.log(`events: ${s.events}`);
  console.log(`POST /claim events: ${s.claims}`);
  console.log(`by route: ${JSON.stringify(s.byRoute)}`);
  console.log(`outcomes: ${JSON.stringify(s.outcomes)}`);
  console.log(`exceededCpu: ${s.exceededCpu}`);
  console.log(`non-ok: ${s.nonOk}`);
  console.log(`cpuTime ms p50: ${s.cpuP50}  max: ${s.cpuMax}`);
  console.log(`RESULT: ${pass ? "PASS" : "FAIL"} (need >= 60 requests, >= 1 claim, 0 exceededCpu, 0 non-ok)`);
  process.exit(pass ? 0 : 1);
}

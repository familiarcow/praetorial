#!/usr/bin/env node
// CF1e3 / D-CF1E3a: summarize a `wrangler tail praetorial-indexer-testnet --format json` capture.
// usage: node count_outcomes.mjs [tail_indexer.json]   (default: tail_indexer.json next to this script)
// Prints: event count, POST /tick count, counts per outcome, exceededCpu count, non-ok count, cpuTime p50/max (ms).
// PASS = >= 60 ticks, zero exceededCpu, zero non-ok. Exit code 0 on PASS, 1 otherwise (CLI only).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Split concatenated JSON values (pretty or one-per-line) by brace depth, string-aware.
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
  const outcomes = {}; const cpu = []; let events = 0, ticks = 0;
  for (const e of jsonValues(text)) {
    if (typeof e !== "object" || !("outcome" in e)) continue;
    events++;
    outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
    if (typeof e.cpuTime === "number") cpu.push(e.cpuTime);
    const r = e.event?.request;
    if (r && r.method === "POST" && /\/tick$/.test(new URL(r.url).pathname)) ticks++;
  }
  const exceededCpu = outcomes.exceededCpu ?? 0;
  const nonOk = events - (outcomes.ok ?? 0);
  return { events, ticks, outcomes, exceededCpu, nonOk, cpuP50: pct(cpu, 0.5), cpuMax: cpu.length ? Math.max(...cpu) : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "tail_indexer.json");
  const s = summarizeTail(fs.readFileSync(file, "utf8"));
  const pass = s.ticks >= 60 && s.exceededCpu === 0 && s.nonOk === 0;
  console.log(`file: ${path.basename(file)}`);
  console.log(`events: ${s.events}`);
  console.log(`POST /tick events: ${s.ticks}`);
  console.log(`outcomes: ${JSON.stringify(s.outcomes)}`);
  console.log(`exceededCpu: ${s.exceededCpu}`);
  console.log(`non-ok: ${s.nonOk}`);
  console.log(`cpuTime ms p50: ${s.cpuP50}  max: ${s.cpuMax}`);
  console.log(`RESULT: ${pass ? "PASS" : "FAIL"} (need >= 60 ticks, 0 exceededCpu, 0 non-ok)`);
  process.exit(pass ? 0 : 1);
}

// MISS1: evidence salvaged from unmerged branches and worktree leftovers must stay consistent with what the docs claim.
// - CS1: every screenshot CASE-STUDIES.md cites is backed by the on-chain snapshot it was rendered from (render/<label>.json).
// - live-DR: a rehearsal README still marked WAITING carries its final on-chain state (read-only check), so no run is left
//   looking unfinished-but-fine.
// - MON1: the design note's stuck-payout threshold is the one the monitor Worker ships.
// - R2 corpus: the salvaged result docs link only to files that are in the repo (the 130 MB corpus itself stays out).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const PHASE_STATUS: Record<string, string> = { taken: "Taken", ruled: "Proposed", challenged: "Challenged", settled: "Settled" };

test("CS1: every cited screenshot has its bet snapshot, in the phase its label names, one bet per case", () => {
  const md = read("spikes/cs1/CASE-STUDIES.md");
  const labels = [...new Set([...md.matchAll(/shots\/([a-z0-9-]+)-(?:375|1280)\.png/g)].map((m) => m[1]))];
  assert.ok(labels.length >= 14, `only ${labels.length} cited labels`);
  const betOfCase = new Map<string, number>();
  for (const label of labels) {
    const m = label.match(/^(.+)-\d-(taken|ruled|challenged|settled)$/);
    assert.ok(m, `unexpected label ${label}`);
    const file = `spikes/cs1/render/${label}.json`;
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} missing`);
    const snap = JSON.parse(read(file));
    assert.equal(snap.betId, snap.bet.envelope.bet_id, label);
    assert.equal(snap.bet.status, PHASE_STATUS[m[2]], `${label}: status`);
    if (m[2] !== "taken") assert.ok(snap.bet.outcome, `${label}: a ruled/settled bet has an outcome`);
    const prev = betOfCase.get(m[1]);
    if (prev !== undefined) assert.equal(snap.betId, prev, `${label}: same case, different bet`);
    betOfCase.set(m[1], snap.betId);
  }
});

test("live-DR: a README still marked WAITING records the bet's final on-chain state (run/chain_final_miss1.json)", () => {
  const liveDr = path.join(ROOT, "services/e2e/live-DR");
  const waiting = fs.readdirSync(liveDr).filter((d) => /^DR\d+$/.test(d) && /WAITING/.test(fs.readFileSync(path.join(liveDr, d, "README.md"), "utf8").split("\n").slice(0, 4).join("\n")));
  for (const d of ["DR3", "DR4", "DR7", "DR8"]) assert.ok(waiting.includes(d), `${d} (salvaged, ended WAITING) not found: ${waiting}`);
  for (const d of waiting) {
    const readme = fs.readFileSync(path.join(liveDr, d, "README.md"), "utf8");
    const i = readme.indexOf("## Final on-chain state");
    assert.ok(i > 0, `${d}: README has no final on-chain state section`);
    const snapFile = path.join(liveDr, d, "run", "chain_final_miss1.json");
    assert.ok(fs.existsSync(snapFile), `${d}: run/chain_final_miss1.json missing`);
    const snap = JSON.parse(fs.readFileSync(snapFile, "utf8"));
    const section = readme.slice(i);
    assert.match(section, new RegExp(`Bet ${snap.bet_id}\\b`), `${d}: section does not name bet ${snap.bet_id}`);
    assert.ok(section.includes(snap.status), `${d}: section does not state the chain status ${snap.status}`);
    if (snap.outcome) assert.ok(section.includes(snap.outcome), `${d}: section does not state the outcome ${snap.outcome}`);
  }
});

test("MON1 notes: the documented stuck-payout threshold (10 min) is what the monitor Worker ships, testnet and mainnet", () => {
  const notes = read("spikes/mon1/NOTES.md");
  assert.match(notes, /ALERT_STUCK_PAYOUT_MS` \(default 600000\)/);
  assert.match(notes, /## Threshold: 10 minutes/);
  const toml = read("services/workers/monitor/wrangler.toml");
  assert.equal([...toml.matchAll(/^ALERT_STUCK_PAYOUT_MS = "600000"$/gm)].length, 2);
});

test("R2 corpus results: the salvaged docs exist and every relative link resolves inside the repo", () => {
  const dir = "docs/evidence/r2-corpus";
  assert.ok(fs.existsSync(path.join(ROOT, dir, "README.md")), `${dir}/README.md missing`);
  const docs = fs.readdirSync(path.join(ROOT, dir), { recursive: true }).map(String).filter((f) => f.endsWith(".md"));
  const bad: string[] = [];
  for (const f of docs) {
    for (const m of read(path.join(dir, f)).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(m[1])) continue; // http(s), mailto
      if (!fs.existsSync(path.join(ROOT, dir, path.dirname(f), m[1]))) bad.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

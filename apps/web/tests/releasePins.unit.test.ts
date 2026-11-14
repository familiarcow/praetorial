// WT1b (a)+(b): the release pins must be the REAL ones, and drift fails loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sha256 } from "js-sha256";
import release from "../lib/release.json";
import { loadReleaseConfig, pinnedKeysMismatch } from "../lib/releaseConfig";
import { checkOpenPins } from "../lib/openPins";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const mainRs = readFileSync(join(repo, "resolver/wasm-bin/src/main.rs"), "utf8");
const konst = (n: string) => {
  const m = mainRs.match(new RegExp(`pub const ${n}: &str = "([^"]+)";`));
  assert.ok(m, `${n} not found in resolver/wasm-bin/src/main.rs`);
  return m![1];
};

test("(a) release.json models are the resolver's pinned judges (D-JUDGE6), primary first", () => {
  assert.deepEqual(release.models, [konst("PRIMARY_JUDGE_MODEL"), konst("SECOND_JUDGE_MODEL")]);
});

test("(a) models_snapshot_hash = sha256 of the compact JSON array of the real pinned list", () => {
  const list = [konst("PRIMARY_JUDGE_MODEL"), konst("SECOND_JUDGE_MODEL")];
  assert.equal(loadReleaseConfig().models_snapshot_hash, sha256(JSON.stringify(list)));
});

// EXP2: the current record is the committed pointer resolver/release/CURRENT, not git timestamps (a squashed
// public export adds every record in one commit, so timestamps all tie). With history, the pointer must name one
// of the newest-added records (adding a record without moving CURRENT fails). Rebuild records (`rebuild_of`,
// written by the public export) are not releases and never make the pointer stale.
function selectCurrentRecord(pointer: string, files: string[], addedAt: Record<string, number>): string {
  assert.ok(files.includes(pointer), `resolver/release/CURRENT names ${pointer}, which is not a record`);
  const newest = Math.max(...files.map((f) => addedAt[f] ?? 0));
  const tied = files.filter((f) => (addedAt[f] ?? 0) === newest);
  assert.ok(tied.includes(pointer), `stale pointer: resolver/release/CURRENT names ${pointer} but the newest record is ${tied.join(", ")}`);
  return pointer;
}

function newestRecord(): { file: string; rec: any } {
  const dir = join(repo, "resolver/release");
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  const files = readdirSync(dir).filter((f) => /^record-.*\.json$/.test(f) && !("rebuild_of" in read(f)));
  const addedAt: Record<string, number> = {};
  for (const f of files)
    addedAt[f] = Number(execFileSync("git", ["log", "-1", "--format=%ct", "--", `resolver/release/${f}`], { cwd: repo }).toString().trim() || 0);
  const file = selectCurrentRecord(readFileSync(join(dir, "CURRENT"), "utf8").trim(), files, addedAt);
  return { file, rec: read(file) };
}

test("(b) EXP2: a squashed tree (every record added at the same second) still selects the CURRENT record", () => {
  const files = ["record-0723fe2.json", "record-a1f4091.json", "record-f5695b9.json"];
  const tie = Object.fromEntries(files.map((f) => [f, 1763100000]));
  assert.equal(selectCurrentRecord("record-f5695b9.json", files, tie), "record-f5695b9.json");
  assert.equal(selectCurrentRecord("record-f5695b9.json", files, {}), "record-f5695b9.json"); // no git at all
});

test("(b) EXP2: a stale or dangling CURRENT pointer fails", () => {
  const files = ["record-old.json", "record-new.json"];
  assert.throws(() => selectCurrentRecord("record-old.json", files, { "record-old.json": 1, "record-new.json": 2 }), /stale pointer/);
  assert.throws(() => selectCurrentRecord("record-gone.json", files, {}), /not a record/);
  assert.equal(selectCurrentRecord("record-new.json", files, { "record-old.json": 1, "record-new.json": 2 }), "record-new.json");
});

test("(b) release.json resolver_wasm_hash equals the newest resolver/release record's wasm sha256", () => {
  const { file, rec } = newestRecord();
  assert.match(rec.hash, /^[0-9a-f]{64}$/);
  assert.equal(release.resolver_wasm_hash, rec.hash, `release.json is not pinned to ${file}`);
  assert.ok(release.release_record.includes(file), `release_record should name ${file}`);
  for (const b of rec.builds) assert.equal(b.sha256, rec.hash);
});

const rel = loadReleaseConfig();
const good = ["a".repeat(64), "b".repeat(64), rel.resolver_wasm_hash];

test("(b) open flow refuses with a clear message when the contract's pinned wasm hash differs", async () => {
  const bad = ["a", "b", "f6c24165f2ca9c24555d9edaa90aa2fd1ef26ad52035780895f5c502a52bdd17"];
  const r = await checkOpenPins(async () => bad, rel);
  assert.ok(r && /refusing to open/.test(r) && r.includes(bad[2]) && r.includes(rel.resolver_wasm_hash), String(r));
});

test("(b) open flow proceeds when the pin matches; a failing view call also refuses", async () => {
  assert.equal(await checkOpenPins(async () => good, rel), null);
  const r = await checkOpenPins(async () => { throw new Error("rpc down"); }, rel);
  assert.ok(r && /refusing to open/.test(r) && /rpc down/.test(r));
  assert.equal(pinnedKeysMismatch(good, rel), null);
});

test("(b) App.tsx open handler runs the pin check before building the envelope", () => {
  const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
  const s = app.indexOf("const openBet = async") /* MODAL1c1: the handler moved out of the button into openBet */;
  const h = app.slice(s, app.indexOf("signRawHash", s));
  const a = h.indexOf("checkOpenPins");
  assert.ok(a >= 0, "handler does not call checkOpenPins");
  assert.ok(a < h.indexOf("buildOpenEnvelope"), "pin check must precede buildOpenEnvelope");
});

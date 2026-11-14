// DOCS5: the submission README, docs/BETS.md and the in-app Docs tell the same story with the same numbers.
// - The settled-bet counts are recomputed here from docs/BETS.md (one row per bet, each with its own explorer link) and must equal
//   lib/settledBets.ts, the README's numbers line and the What / Hackathon pages.
// - A bet is never labelled mainnet with a testnet link, or the other way round.
// - Only the 4 tracks; no link into spikes/ (left out of the public export); no prediction-market comparison; no "40+".
// Report: spikes/docs5/REPORT.md.
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTLED, MAINNET_BETS, settledLine } from "../lib/settledBets";
import { MAINNET_STATUS } from "../lib/mainnetEvidence";
import { ESCROW_RELEASE } from "../lib/docsFacts";
import { RESOLVER_WASM_HASH } from "../lib/about";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const norm = (s: string) => s.replace(/\s+/g, " ");
const README_RAW = read("README.md");
const README = norm(README_RAW);
const BETS = read("docs/BETS.md");
/** Every .md under docs/, recursively. */
const mdUnder = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => {
  const p = `${dir}/${f}`;
  return statSync(join(ROOT, p)).isDirectory() ? mdUnder(p) : f.endsWith(".md") ? [p] : [];
});
const DOCS_MD = mdUnder("docs").map((p) => [p, read(p)] as const);

const { default: DocsPage } = await import("../src/components/docs/DocsPage");
type Page = "what" | "verification" | "intents" | "trust" | "hackathon";
const PAGES: Page[] = ["what", "verification", "intents", "trust", "hackathon"];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const ALL = Object.fromEntries(PAGES.map((p) => [p, text(renderToStaticMarkup(React.createElement(DocsPage, { page: p, navigate: () => {}, loggedOut: true })))])) as Record<Page, string>;

/** The "Settled" table of docs/BETS.md: one row per bet. */
function settledRows() {
  const sec = BETS.slice(BETS.indexOf("## Settled"), BETS.indexOf("## Replays"));
  return sec.split("\n").filter((l) => /^\| \d+ \|/.test(l)).map((l) => {
    const c = l.split(/(?<!\\)\|/).map((x) => x.trim());
    return { n: Number(c[1]), bet: c[2]!, kind: c[4]!, outcome: c[5]!, how: c[6]!, stake: c[7]!, tx: c[8]! };
  });
}

test("DOCS5 BETS.md: the settled table's own counts equal lib/settledBets.ts", () => {
  const rows = settledRows();
  assert.equal(rows.length, SETTLED.total);
  assert.deepEqual(rows.map((r) => r.n), rows.map((_, i) => i + 1), "rows numbered 1..n");
  const n = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  assert.equal(n((r) => r.bet.startsWith("mainnet")), SETTLED.onMainnet);
  assert.equal(n((r) => r.bet.startsWith("testnet")), SETTLED.onTestnet);
  assert.equal(n((r) => r.how.startsWith("AI judge")), SETTLED.aiJudge);
  assert.equal(n((r) => /conceded/.test(r.how) && r.how.startsWith("AI judge")), SETTLED.aiThenConceded);
  assert.equal(n((r) => r.how === "Human referee"), SETTLED.referee);
  assert.equal(n((r) => r.how.startsWith("Conceded")), SETTLED.conceded);
  assert.equal(n((r) => r.how.startsWith("Refunded")), SETTLED.deadlineVoid);
  assert.equal(n((r) => r.outcome === "YES"), SETTLED.yes);
  assert.equal(n((r) => r.outcome === "NO"), SETTLED.no);
  assert.equal(n((r) => r.outcome === "VOID"), SETTLED.void);
  assert.equal(n((r) => r.kind === "Custom"), SETTLED.custom);
  assert.equal(n((r) => r.kind !== "Custom"), SETTLED.builtIn);
  assert.equal(SETTLED.aiJudge + SETTLED.referee + SETTLED.conceded + SETTLED.deadlineVoid, SETTLED.total);
  assert.equal(SETTLED.yes + SETTLED.no + SETTLED.void, SETTLED.total);
});

test("DOCS5 BETS.md: every row links its own network's explorer (never a testnet bet labelled mainnet)", () => {
  for (const r of settledRows()) {
    const links = [...r.tx.matchAll(/\((https:\/\/[^)]+)\)/g)].map((m) => m[1]!);
    assert.ok(links.length > 0, `row ${r.n} has a tx link`);
    for (const u of links) {
      if (r.bet.startsWith("mainnet")) assert.match(u, /^https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/, `row ${r.n}`);
      else assert.match(u, /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/, `row ${r.n}`);
    }
  }
  assert.match(BETS, /## Replays/);
});

test("DOCS5 README: the settled-bets numbers line equals docs/BETS.md; the table's mainnet rows link mainnet, the rest link testnet", () => {
  assert.ok(README.includes(norm(settledLine("md"))), `README has: ${settledLine("md")}`);
  const sec = README_RAW.slice(README_RAW.indexOf("## Bets Praetorial has settled"), README_RAW.indexOf("### Verify a ruling yourself"));
  const rows = sec.split("\n").filter((l) => l.startsWith("| ") && !/^\| (Bet|---)/.test(l));
  assert.ok(rows.length >= 9 && rows.length <= 12, `about 10 bets in the README table (${rows.length})`);
  for (const r of rows) {
    const links = [...r.matchAll(/\((https:\/\/[^)]+)\)/g)].map((m) => m[1]!);
    assert.ok(links.length > 0, r.slice(0, 60));
    for (const u of links) assert.match(u, r.startsWith("| Mainnet") ? /^https:\/\/nearblocks\.io\/txns\// : /^https:\/\/testnet\.nearblocks\.io\/txns\//, r.slice(0, 60));
  }
  assert.ok(rows[0]!.startsWith("| Mainnet #1") && rows[1]!.startsWith("| Mainnet #2"), "mainnet bets 1 and 2 first");
  // the "same code" line quotes the real release hashes
  assert.match(README, new RegExp(`Same escrow code \\(sha256 \`${ESCROW_RELEASE.sha256.slice(0, 8)}…\`\\) and judge program \\(\`${RESOLVER_WASM_HASH.slice(0, 8)}…\`\\)`));
  // every testnet bet in the README table is on frz3 (the escrow that ran the mainnet judge program), so the "same code" line is true for it
  // (each testnet row links at least one tx that docs/BETS.md lists on a frz3 row)
  const frz3Lines = BETS.split("\n").filter((l) => /^\| \d+ \| testnet \(frz3\) #\d+ \|/.test(l));
  for (const r of rows.filter((x) => !x.startsWith("| Mainnet"))) {
    const hashes = [...r.matchAll(/testnet\.nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]+)/g)].map((m) => m[1]!);
    assert.ok(hashes.some((h) => frz3Lines.some((l) => l.includes(h))), `README row is a frz3 bet listed in docs/BETS.md: ${r.slice(0, 60)}`);
  }
});

test("DOCS5 README: 'check every claim' table, verify-bet first, numbers line, no history caveat, no manual npm ci", () => {
  assert.match(README, /## Check every claim in 5 minutes/);
  assert.match(README, /`node scripts\/verify-bet\.mjs --network mainnet 1` \| `12 PASS, 0 FAIL, 0 SKIP`/);
  assert.match(README, /`"keys":\[\]`/);
  assert.match(README, new RegExp(`${RESOLVER_WASM_HASH.slice(0, 16)}…${RESOLVER_WASM_HASH.slice(-7)}`));
  assert.match(README, new RegExp(`${ESCROW_RELEASE.sha256.slice(0, 16)}…${ESCROW_RELEASE.sha256.slice(-8)}`));
  assert.match(README, /By the numbers/);
  assert.doesNotMatch(README, /needs full history|full history \(two checks/i);
  const quick = README_RAW.slice(README_RAW.indexOf("## Quick start"), README_RAW.indexOf("## Architecture"));
  assert.doesNotMatch(quick, /cd apps\/web && npm ci/, "test.sh installs apps/web deps itself now");
  assert.match(README, /DEMO_POST_URL/, "the demo link placeholder stays for the PM");
  assert.match(README, /hosted demo stays up through at least 2026-11-25/);
});

test("DOCS5: only the 4 tracks, in the README and the Hackathon page", () => {
  const tracks = ["Unstoppable DeFi", "Privacy & Private AI", "Real-World Money", "Open Innovation"];
  const sec = README_RAW.slice(README_RAW.indexOf("## Tracks"), README_RAW.indexOf("## Roadmap"));
  assert.deepEqual([...sec.matchAll(/^- \*\*([^*]+?)\.\*\*/gm)].map((m) => m[1]), tracks);
  for (const t of tracks) assert.ok(ALL.hackathon.includes(t), `hackathon: ${t}`);
  for (const [where, t] of [["README", README], ["hackathon", ALL.hackathon]] as const)
    assert.doesNotMatch(t, /AI Swarms|Agent Economy|Social Money|Autonomous Business|AI Security/, where);
});

test("DOCS5: no README/docs link into spikes/ (not part of the public export)", () => {
  for (const [where, t] of [["README.md", README_RAW], ...DOCS_MD] as const) assert.doesNotMatch(t, /spikes\//, where);
});

test("DOCS5: no prediction-market comparison, no '40+', no hype words, anywhere a judge reads", () => {
  // docs/evidence/ is excluded: it is research evidence copied verbatim (R2 used settled public markets as a test-data source, by name).
  const texts = [["README.md", README_RAW], ...DOCS_MD.filter(([p]) => !p.startsWith("docs/evidence/")), ...PAGES.map((p) => [p, ALL[p]] as const)] as const;
  for (const [where, t] of texts) {
    assert.doesNotMatch(t, /polymarket|\bUMA\b|prediction market/i, where);
    assert.doesNotMatch(t, /\b40\+/, where);
    assert.doesNotMatch(t, /revolutionary|seamless|cutting-edge|any chain\b|uncensored/i, where);
  }
});

test("DOCS5 in-app Docs: the real mainnet bets and the settled line replace 'no mainnet bet'", () => {
  assert.equal(MAINNET_STATUS.betCount, MAINNET_BETS.length);
  for (const p of PAGES) {
    assert.doesNotMatch(ALL[p], /No mainnet bet|no settled mainnet bet|none yet/i, p);
  }
  for (const p of ["what", "hackathon"] as const) {
    assert.ok(ALL[p].includes(settledLine("text")), `${p} has the settled line`);
    assert.match(ALL[p], /bet 1[^.]*ruled NO[^.]*settled/i, p);
    assert.match(ALL[p], /bet 2[^.]*hackathon[^.]*awaiting its ruling/i, p);
  }
  assert.match(ALL.trust, /Mainnet bet 1 settled/);
});

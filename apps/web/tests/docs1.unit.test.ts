// DOCS1: the Docs pages. Each page renders (server-side, no login, no wallet); the facts the pages print equal their sources (release
// records, network table, asset table); every command block has a CLAIMS.md entry; no secret or private name is in the Docs source.
// Routes / redirects: tests/docs1Routes.unit.test.ts. Browser (logged out, nav, /about redirect, every link): tests/docs1.spec.ts.
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_PAGES } from "../lib/docs";
import { DOCS_COMMANDS, ESCROW_RELEASE, RESOLVER_RELEASE, MAINNET, TESTNET, TODO, EXTERNAL_ORIGINS } from "../lib/docsFacts";
import { NETWORKS } from "../lib/network";
import { ASSET_TABLE, LAUNCH_MAX_PER_SIDE } from "../lib/assets";
import { feeRows } from "../lib/about";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const DOCS_SRC = join(WEB, "src/components/docs");
const docsSources = readdirSync(DOCS_SRC).filter((f) => f.endsWith(".tsx")).map((f) => ({ f, src: readFileSync(join(DOCS_SRC, f), "utf8") }));
// DOCS2 took the Docs over: a command's claim entry may be in DOCS1's or DOCS2's CLAIMS.md (both are public and test-checked).
const CLAIMS = read("spikes/docs1/CLAIMS.md") + "\n" + read("spikes/docs2/CLAIMS.md");

const { default: DocsPage } = await import("../src/components/docs/DocsPage");
const render = (page: (typeof DOCS_PAGES)[number]["id"], loggedOut = true) =>
  renderToStaticMarkup(React.createElement(DocsPage, { page, navigate: () => {}, loggedOut }));

test("DOCS1: every Docs page renders logged out, with the Docs sub-nav (one entry per page, the current one marked) and a Log in link", () => {
  for (const p of DOCS_PAGES) {
    const h = render(p.id);
    assert.match(h, new RegExp(`data-testid="docs-${p.id}"`), p.id);
    assert.match(h, /data-testid="docs-public-head"/, p.id);
    assert.match(h, /data-testid="docs-login"/, p.id);
    for (const q of DOCS_PAGES) assert.match(h, new RegExp(`data-testid="docs-nav-${q.id}"`), `${p.id} nav has ${q.id}`);
    assert.equal((h.match(/aria-current="page"/g) ?? []).length, 1, p.id);
    assert.match(h, new RegExp(`<h1>${p.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h1>`), p.id);
  }
  assert.doesNotMatch(render("what", false), /docs-public-head/, "logged in: the app nav, not the public header");
});

test("DOCS1 page 1: the one-diagram lifecycle (create, take, deadline, judge, then payout or refund) and the custom-bet guide link", () => {
  const h = render("what");
  const order = ["create", "take", "deadline", "judge", "payout", "refund"].map((id) => h.indexOf(`data-testid="flow-${id}"`));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(h, /href="\/guide\/custom-bet"/);
  for (const id of ["how", "fees", "know"]) assert.match(h, new RegExp(`data-testid="about-${id}"`), id); // About's copy, reused
});

test("DOCS1 page 2: every safeguard the spec lists is on the verification page, plus About's models and verify rows", () => {
  const h = render("verification");
  for (const id of ["terms", "contract", "code-decides", "burden", "two-models", "tee", "run-order", "disputes", "failsafe"]) {
    assert.match(h, new RegExp(`data-testid="safeguard-${id}"`), id);
  }
  for (const id of ["models", "verify"]) assert.match(h, new RegExp(`data-testid="about-${id}"`), id);
  assert.match(h, /href="\/docs\/trust"/);
  assert.match(h, new RegExp(`nearblocks\\.io/address/${MAINNET.escrow.replace(/\./g, "\\.")}`));
});

test("DOCS1 page 3: the token table is generated from the asset table and the release limits (not typed in)", () => {
  const h = render("intents");
  const fees = new Map(feeRows(ASSET_TABLE.map((a) => a.symbol)).map((r) => [r.symbol, r]));
  for (const a of ASSET_TABLE) {
    const row = new RegExp(`data-testid="docs-asset-${a.symbol}"[\\s\\S]*?</tr>`).exec(h)?.[0] ?? "";
    assert.ok(row, a.symbol);
    assert.ok(row.includes(fees.get(a.symbol)!.minStake), `${a.symbol} min stake`);
    assert.ok(row.includes(fees.get(a.symbol)!.minFee), `${a.symbol} min fee`);
    const yes = (n: "mainnet" | "testnet") => !!a.ids[n] && !a.disabledReason?.[n];
    assert.match(row, new RegExp(`data-label="Mainnet">${yes("mainnet") ? "Yes" : "No"}<`), a.symbol);
    assert.match(row, new RegExp(`data-label="Testnet">${yes("testnet") ? "Yes" : "No"}<`), a.symbol);
  }
  assert.equal((h.match(/data-testid="docs-asset-[A-Z]+"/g) ?? []).length, ASSET_TABLE.length);
  // b0nd's brief said "$1,000 per side"; the release config has NO stake cap (D-CAP3), so the page must say so, not invent a cap.
  assert.ok(ASSET_TABLE.every((a) => (a.maxStakePerSide ?? LAUNCH_MAX_PER_SIDE) === LAUNCH_MAX_PER_SIDE));
  assert.match(h, /no maximum stake per side at launch/);
  assert.doesNotMatch(h, /1,000/);
});

test("DOCS1 page 4 (Trust): eight trust layers, the NOT-trusted list, twelve verify steps, the limits; anything not possible says so", () => {
  const h = render("trust");
  for (const id of ["chain", "outlayer", "nearai", "sources", "intents", "privy", "relayer", "frontend"]) assert.match(h, new RegExp(`data-testid="trust-row-${id}"`), id);
  assert.match(h, /data-testid="trust-not-trusted"/);
  assert.equal((h.match(/data-testid="trust-step-/g) ?? []).length, 12);
  assert.match(h, /data-testid="trust-step-keys"[\s\S]*?Not possible for you yet/);
  assert.match(h, /No separate prompt hash is stored on chain/);
  assert.match(h, /Re-running it yourself: not possible end to end yet/);
  for (const id of ["nondeterminism", "tee", "nearai", "unaudited"]) assert.match(h, new RegExp(`data-testid="limit-${id}"`), id);
  assert.match(h, /data-testid="trust-prompt-system"/); // the prompt itself is published (from the resolver source, generated)
});

test("DOCS1 page 5 (Hackathon): rules, status table with the mainnet ids from config, TODO placeholders for familiarcow, team, limits", () => {
  const h = render("hackathon");
  assert.match(h, /14 November, 23:59 UTC/);
  assert.match(h, /@NEARProtocol and #NEARHackathon/);
  for (const id of ["escrow", "judge", "intents", "funding", "registry", "web"]) assert.match(h, new RegExp(`data-testid="hack-status-${id}"`), id);
  assert.ok(h.includes(MAINNET.escrow) && h.includes(MAINNET.registryId) && h.includes(MAINNET.intents));
  for (const t of Object.values(TODO)) assert.ok(h.includes(t), t);
  assert.match(h, /Built from public sources only/);
});

test("DOCS1: the facts the Docs print equal their sources (release records, network table)", () => {
  const rel = JSON.parse(read("release/mainnet-night/release-mainnet.json"));
  assert.equal(ESCROW_RELEASE.sha256, rel.escrow_wasm_sha256);
  assert.equal(ESCROW_RELEASE.codeHashB58, rel.escrow_code_hash_b58);
  assert.equal(ESCROW_RELEASE.record, rel.escrow_record);
  assert.equal(rel.mainnet_escrow.account, MAINNET.escrow);
  const rec = JSON.parse(read(ESCROW_RELEASE.record));
  assert.equal(rec.hash, ESCROW_RELEASE.sha256);
  assert.ok(rec.commit.startsWith(ESCROW_RELEASE.commit));
  const web = JSON.parse(readFileSync(join(WEB, "lib/release.mainnet.json"), "utf8"));
  assert.equal(RESOLVER_RELEASE.record, web.release_record);
  const rrec = JSON.parse(read(RESOLVER_RELEASE.record));
  assert.equal(rrec.hash, web.resolver_wasm_hash);
  assert.ok(rrec.commit.startsWith(RESOLVER_RELEASE.commit));
  const args = JSON.parse(read("release/mainnet-night/args.mainnet.json"));
  assert.equal(MAINNET.registryId, args.registry);
  assert.equal(MAINNET.intents, args.intents);
  assert.equal(TESTNET?.escrow, NETWORKS.testnet.escrow);
});

test("DOCS1: every command block on the Docs has a CLAIMS.md entry (cmd:<id>), and every <Cmd id> used exists", () => {
  const used = new Set(docsSources.flatMap(({ src }) => [...src.matchAll(/<Cmd id="([^"]+)"/g)].map((m) => m[1]!)));
  const ids = new Set(DOCS_COMMANDS.map((c) => c.id));
  for (const u of used) assert.ok(ids.has(u), `<Cmd id="${u}"> has no DOCS_COMMANDS entry`);
  for (const c of DOCS_COMMANDS) {
    assert.ok(used.has(c.id), `command ${c.id} is defined but not on any page`);
    assert.ok(CLAIMS.includes(`cmd:${c.id}`), `CLAIMS.md has no entry for cmd:${c.id}`);
  }
  for (const t of Object.values(TODO)) assert.ok(CLAIMS.includes(t), `CLAIMS.md TODO list misses "${t}"`);
});

test("DOCS1: external links are only the public origins listed in lib/docsFacts.ts EXTERNAL_ORIGINS", () => {
  for (const p of DOCS_PAGES) {
    for (const m of render(p.id).matchAll(/href="([^"]+)"/g)) {
      const href = m[1]!.replace(/&amp;/g, "&");
      if (href.startsWith("/")) continue; // internal: resolved in the browser test (tests/docs1.spec.ts)
      assert.ok(EXTERNAL_ORIGINS.includes(new URL(href).origin), `${p.id}: ${href}`);
    }
  }
});

test("DOCS1: public repo hygiene: no secret, key, private vault or internal note name in the Docs source or the claims file", () => {
  const all = [...docsSources.map((d) => d.src), readFileSync(join(WEB, "lib/docs.ts"), "utf8"), readFileSync(join(WEB, "lib/docsFacts.ts"), "utf8"), CLAIMS];
  for (const s of all) {
    assert.doesNotMatch(s, /\.herm[e]s|secrets\/|vault|PRIVY_TEST|ONECLICK_API_KEY|ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|BEGIN [A-Z ]*PRIVATE KEY/i);
  }
});

test("DOCS1: the external-origin allow-list covers the public addresses the Docs quote (docsPublic.json is the one list)", async () => {
  const { NEAR_AI_GUIDE, NEAR_INTENTS_DOCS } = await import("../lib/docsFacts");
  for (const u of [NEAR_AI_GUIDE, NEAR_INTENTS_DOCS, "https://nearhackathon.com", "https://nearblocks.io/address/x", "https://testnet.nearblocks.io/address/x"]) {
    assert.ok(EXTERNAL_ORIGINS.includes(new URL(u).origin), u);
  }
  for (const o of EXTERNAL_ORIGINS) assert.match(o, /^https:\/\/[a-z0-9.-]+$/);
});

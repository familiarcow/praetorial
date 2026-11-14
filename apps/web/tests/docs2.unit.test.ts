// DOCS2: the Docs describe the MAINNET deployment. Evidence is data (lib/mainnetEvidence.ts, lib/caseStudies.ts) and the pages render
// it; nothing is shown as proven without a transaction or bet id; testnet appears only as labelled rehearsals. Mainnet ids equal the
// release args and the Workers' config; the release record's filled fields equal the chain-verified values in spikes/docs2/CLAIMS.md.
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAINNET } from "../lib/docsFacts";
import { MAINNET_EVIDENCE, MAINNET_STATUS, CLAIM_IDS, effectiveStatus, txUrl, type Evidence } from "../lib/mainnetEvidence";
import { CASE_STUDIES, orderedCases, caseLabel, type CaseStudy } from "../lib/caseStudies";
import ACCOUNTS from "../lib/mainnetAccounts.json" with { type: "json" };

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const CLAIMS = read("spikes/docs2/CLAIMS.md");
const CASES_VERIFIED = read("spikes/docs2/CASES-VERIFIED.md");
const B58_TX = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const { default: DocsPage } = await import("../src/components/docs/DocsPage");
const { AchievementCards, CaseStudyList } = await import("../src/components/docs/HackathonPage");
const render = (page: "what" | "verification" | "intents" | "trust" | "hackathon") =>
  renderToStaticMarkup(React.createElement(DocsPage, { page, navigate: () => {}, loggedOut: true }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** Each card (<li class="docs-card">) of a list rendered on its own, as its own HTML chunk. */
const cards = (html: string) => html.split(/(?=<li class="docs-card")/).slice(1);

// ------------------------------------------------------------------ release record and accounts

test("DOCS2: release-mainnet.json args_sha256 = sha256 of args.mainnet.json (= the new() args in the deploy tx, CLAIMS.md)", () => {
  const rel = JSON.parse(read("release/mainnet-night/release-mainnet.json"));
  const sha = createHash("sha256").update(readFileSync(join(ROOT, rel.args_file))).digest("hex");
  assert.equal(rel.args_sha256, sha);
  assert.ok(CLAIMS.includes(sha), "CLAIMS.md records the chain check of the args hash");
  for (const k of ["outcome_run_tx", "attest_run_tx"]) {
    assert.match(rel.outlayer[k], B58_TX, k);
    assert.ok(CLAIMS.includes(rel.outlayer[k]), `${k} is chain-checked in CLAIMS.md`);
  }
  const keys = JSON.parse(read("release/mainnet-night/args.mainnet.json"));
  assert.equal(rel.outlayer.upload_url, `${keys.outlayer_config.wasm_base_url}/${keys.resolver_wasm_hash}.wasm`);
});

test("DOCS2: lib/mainnetAccounts.json = the release args, the network table and the mainnet Workers' config", () => {
  const args = JSON.parse(read("release/mainnet-night/args.mainnet.json"));
  assert.equal(ACCOUNTS.escrow, MAINNET.escrow);
  assert.equal(ACCOUNTS.guardian, args.guardian);
  assert.equal(ACCOUNTS.feeAccount, args.fee_account);
  assert.equal(ACCOUNTS.keeper, args.keeper);
  assert.equal(ACCOUNTS.operator, args.operator);
  assert.equal(ACCOUNTS.registry, args.registry);
  assert.equal(ACCOUNTS.registry, MAINNET.registryId);
  assert.equal(ACCOUNTS.intents, args.intents);
  assert.equal(ACCOUNTS.outlayer, args.outlayer);
  assert.equal(ACCOUNTS.aiKeyOwner, args.outlayer_config.secrets_account_id);
  assert.ok(args.outlayer_config.wasm_base_url.includes(`/${ACCOUNTS.wasmUploader}/`));
  const toml = (f: string, k: string) => [...read(f).matchAll(new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, "gm"))].map((m) => m[1]);
  assert.ok(toml("services/workers/relayer/wrangler.toml", "RELAYER_ACCOUNT_ID").includes(ACCOUNTS.relayer));
  assert.ok(toml("services/workers/sourcecheck/wrangler.toml", "ATTEST_ACCOUNT_ID").includes(ACCOUNTS.attestSigner));
});

// ------------------------------------------------------------------ mainnet evidence: no "Proven" without a tx or bet id

test("DOCS2: every mainnet claim (a)-(h) has evidence; proven/partial ones carry a tx or bet id, in-progress ones say what will prove it", () => {
  assert.deepEqual(CLAIM_IDS, ["judge", "signed-keys", "immutable", "reproducible", "failsafe", "disputes", "intents", "verifier"]);
  for (const id of CLAIM_IDS) {
    const e = MAINNET_EVIDENCE[id];
    assert.ok(e, id);
    for (const t of e.txs) {
      assert.match(t.hash, B58_TX, `${id} ${t.hash}`);
      assert.ok(CLAIMS.includes(t.hash), `${id}: tx ${t.hash} is chain-checked in spikes/docs2/CLAIMS.md`);
    }
    if (e.status === "in-progress") assert.ok(e.pending && /mainnet/i.test(e.pending), `${id} says what mainnet run will prove it`);
    else assert.ok(e.txs.length + e.betIds.length > 0, `${id} is ${e.status} with no tx or bet id`);
    if (e.status === "partial") assert.ok(e.pending, `${id}: partial says what is still pending`);
  }
  // As of the DOCS2 chain read there is no mainnet bet, so nothing that needs a bet may be proven yet.
  if ((MAINNET_STATUS.betCount as number) === 0) {
    for (const id of ["judge", "failsafe", "disputes", "intents"] as const) assert.equal(MAINNET_EVIDENCE[id].status, "in-progress", id);
    for (const id of CLAIM_IDS) assert.deepEqual(MAINNET_EVIDENCE[id].betIds, [], id);
  }
});

test("DOCS2: effectiveStatus never lets a claim show as proven without a tx or bet id", () => {
  const bare: Evidence = { status: "proven", txs: [], betIds: [], shows: "x" };
  assert.equal(effectiveStatus(bare), "in-progress");
  assert.equal(effectiveStatus({ ...bare, status: "partial", pending: "mainnet x" }), "in-progress");
  assert.equal(effectiveStatus({ ...bare, betIds: [1] }), "proven");
  assert.equal(effectiveStatus({ ...bare, txs: [{ hash: "9gFoypqaFzHEnUmkecG6NarvzoH8fdg8Bn2TPfy34NpX", label: "deploy" }] }), "proven");
  assert.equal(txUrl("mainnet", "abc"), "https://nearblocks.io/txns/abc");
  assert.equal(txUrl("testnet", "abc"), "https://testnet.nearblocks.io/txns/abc");
});

test("DOCS2 Hackathon: eight achievement cards (a)-(h) in order; a card says Proven only next to at least one nearblocks.io tx link or bet id", () => {
  const h = render("hackathon");
  const ids = [...h.matchAll(/class="docs-card" data-testid="achievement-([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...CLAIM_IDS]);
  for (const card of cards(renderToStaticMarkup(React.createElement(AchievementCards, {})))) {
    const status = /data-status="([a-z-]+)"/.exec(card)![1];
    const links = (card.match(/href="https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}"/g) ?? []).length;
    if (/Proven on mainnet/.test(text(card))) assert.ok(links > 0 || /data-bet-id=/.test(card), `card without a tx link says Proven: ${card.slice(0, 120)}`);
    if (status === "in-progress") {
      assert.match(text(card), /In progress/);
      assert.match(text(card), /mainnet run pending/i);
      assert.doesNotMatch(text(card), /Proven on mainnet/);
    }
    assert.doesNotMatch(card, /testnet\.nearblocks/, "a mainnet card never links testnet as proof");
  }
  assert.match(text(h), /Proven on mainnet/); // the contract lock is
});

test("DOCS2 Hackathon: a proven claim stripped of its txs renders as In progress (the rule is enforced at render, not only in data)", () => {
  const forged = { ...MAINNET_EVIDENCE, immutable: { ...MAINNET_EVIDENCE.immutable, txs: [] } };
  const h = renderToStaticMarkup(React.createElement(AchievementCards, { evidence: forged }));
  const card = cards(h).find((c) => c.includes('achievement-immutable'))!;
  assert.match(card, /data-status="in-progress"/);
  assert.doesNotMatch(text(card), /Proven on mainnet/);
});

// ------------------------------------------------------------------ case studies

test("DOCS2 case studies: every case has at least one tx link of its own network, testnet ones are labelled Testnet rehearsal, every hash is verified", () => {
  assert.ok(CASE_STUDIES.length >= 3);
  for (const c of CASE_STUDIES) {
    assert.ok(c.txs.length > 0, `${c.id} has no tx`);
    assert.ok(["mainnet", "testnet"].includes(c.network), c.id);
    for (const t of c.txs) {
      assert.match(t.hash, B58_TX, `${c.id} ${t.hash}`);
      assert.ok(CASES_VERIFIED.includes(t.hash), `${c.id}: ${t.hash} is RPC-verified in spikes/docs2/CASES-VERIFIED.md`);
    }
    if (c.network === "testnet") assert.equal(caseLabel(c), "Testnet rehearsal");
  }
  assert.equal([...render("hackathon").matchAll(/class="docs-card" data-testid="case-/g)].length, CASE_STUDIES.length);
  const list = cards(renderToStaticMarkup(React.createElement(CaseStudyList, {})));
  assert.equal(list.length, CASE_STUDIES.length);
  for (const card of list) {
    const net = /data-network="(mainnet|testnet)"/.exec(card)![1];
    const own = net === "testnet" ? /href="https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}"/ : /href="https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}"/;
    assert.match(card, own, `case card without a ${net} tx link`);
    if (net === "testnet") {
      assert.match(text(card), /Testnet rehearsal/);
      assert.doesNotMatch(card, /href="https:\/\/nearblocks\.io\//, "a testnet case links only the testnet explorer");
    }
    assert.match(text(card), /What happened/);
    assert.match(text(card), /What it proves/);
  }
});

test("DOCS2 case studies: a case with no tx is not rendered; mainnet cases render first; the rendered order follows the data", () => {
  const t = CASE_STUDIES.find((c) => c.network === "testnet")!;
  const main: CaseStudy = { ...t, id: "m-smoke", network: "mainnet", title: "Mainnet smoke", txs: [{ label: "finalize", hash: "9gFoypqaFzHEnUmkecG6NarvzoH8fdg8Bn2TPfy34NpX" }] };
  const empty: CaseStudy = { ...t, id: "no-tx", txs: [] };
  assert.deepEqual(orderedCases([t, main, empty]).map((c) => c.id), ["m-smoke", t.id]);
  const h = renderToStaticMarkup(React.createElement(CaseStudyList, { cases: [t, main, empty] }));
  assert.deepEqual([...h.matchAll(/data-testid="case-([a-z0-9-]+)"/g)].map((m) => m[1]), ["m-smoke", t.id]);
  assert.match(h, /data-testid="case-m-smoke"[\s\S]*?Mainnet/);
  assert.doesNotMatch(h, /case-no-tx/);
});

test("DOCS2 public hygiene: the evidence data carries no private wording, vault or operator path", () => {
  const src = [read("apps/web/lib/caseStudies.ts"), read("apps/web/lib/mainnetEvidence.ts"), read("apps/web/lib/mainnetAccounts.json"), CLAIMS, CASES_VERIFIED, read("docs/VERIFY.md")];
  for (const s of src) assert.doesNotMatch(s, /vault|~\/|\/Users\/|\.queue\/|overnight\.md|PROGRESS\.md|secrets\/|ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/i);
});

// ------------------------------------------------------------------ facts (cap, fees, withdraw, bond) and mainnet-first pages

test("DOCS2 facts: no per-side cap; min $10 per side; fee 1% with a $0.50 minimum (limits.md); withdraw both networks, 1Click mainnet only", () => {
  const limits = read("release/mainnet-night/limits.md");
  assert.match(limits, /10000000 = \$10\.00/);
  assert.match(limits, /500000 = \$0\.50/);
  const h = text(render("hackathon"));
  assert.match(h, /no maximum stake per side/i);
  assert.match(h, /\$10 per side/);
  assert.match(h, /1% per side, at least \$0\.50/);
  assert.doesNotMatch(h, /1,000 per side|\$1,000/);
  const i = text(render("intents"));
  assert.match(i, /Cash out to your NEAR wallet[^|]*Mainnet and testnet/);
  assert.match(i, /Cash out to another chain[^|]*Mainnet/);
});

test("DOCS2 facts: the challenge bond is 10% of the pot (lib.rs:2408), and the stale 5% doc-comments are named as known errors", () => {
  const lib = read("contracts/escrow/src/lib.rs").split("\n");
  assert.match(lib[2407]!, /pot \* 1_000 \/ BPS_DENOM/);
  assert.match(lib[1559]!, /5% of pot_for_challenger/);
  for (const page of ["verification", "trust"] as const) assert.match(text(render(page)), /10% of the pot/);
  const t = text(render("trust"));
  assert.match(t, /lib\.rs:1560/);
  assert.match(t, /5%/);
  assert.match(read("docs/VERIFY.md"), /lib\.rs:1560[\s\S]{0,200}5%|5%[\s\S]{0,200}lib\.rs:1560/);
});

test("DOCS2 mainnet-first: every page names the mainnet escrow; the Trust status names the settled mainnet bet (DOCS5; it said 'No mainnet bet yet' at bet_count 0) and does not use testnet as proof", () => {
  for (const p of ["what", "verification", "intents", "trust", "hackathon"] as const) assert.ok(render(p).includes(MAINNET.escrow), p);
  const t = text(render("trust"));
  assert.doesNotMatch(t, /we ran the per-bet checks below on a settled testnet bet/i);
  assert.match(t, /Mainnet bet 1 settled on 13 November/);
  assert.doesNotMatch(t, /No mainnet bet yet/);
  assert.match(t, new RegExp(`bet_count[^.]*${MAINNET_STATUS.betCount}`));
  for (const k of ["guardian", "keeper", "relayer", "attestSigner", "aiKeyOwner", "registry"] as const) {
    assert.ok(render("hackathon").includes(ACCOUNTS[k]), `hackathon lists ${k}`);
  }
  // The deploy, key removal and the key-binding runs are linked on the Trust page.
  const th = render("trust");
  for (const id of ["immutable", "signed-keys"] as const) for (const tx of MAINNET_EVIDENCE[id].txs) assert.ok(th.includes(`nearblocks.io/txns/${tx.hash}`), `${id} ${tx.label}`);
  assert.doesNotMatch(text(render("hackathon")), /Testnet only|Mainnet and testnet/); // the status table is mainnet-only now
});

// ------------------------------------------------------------------ docs/VERIFY.md and scripts/verify-bet.mjs

test("DOCS2 docs/VERIFY.md: E1's current record is the deployed mainnet one, examples use mainnet ids, no private reference", () => {
  const v = read("docs/VERIFY.md");
  assert.match(v, /Current record `record-84f23c8\.json`[^\n]*caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f/);
  assert.doesNotMatch(v, /Current record `record-8580ca7/);
  assert.match(v, /bets\.praetorial\.near/);
  assert.match(v, /--network mainnet --escrow bets\.praetorial\.near/);
  for (const tx of [...MAINNET_EVIDENCE.immutable.txs, ...MAINNET_EVIDENCE["signed-keys"].txs]) assert.ok(v.includes(tx.hash), tx.label);
  assert.doesNotMatch(v, /--networkId testnet/);
});

test("DOCS2 scripts/verify-bet.mjs: defaults to mainnet and points at the Docs, not the old About page", () => {
  const s = read("scripts/verify-bet.mjs");
  assert.match(s, /flags\.network \?\? file\?\.network \?\? "mainnet"/);
  assert.doesNotMatch(s, /About page/);
  assert.match(s, /\/docs\/trust/);
  assert.match(s.split("\n").slice(0, 10).join("\n"), /default: mainnet|default mainnet/i);
});

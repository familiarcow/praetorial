// COPY1: every public claim true before the web deploy. Each test pins one row of spikes/close1/CLOSEOUT.md §3 (rows 3-9, 12-15),
// the SECREV1 disclosures (SR-C1, SR-C2, SR-C4: Trust page "Known limits" and README "Known limits"), and the cross-asset wording
// (CLOSEOUT §1 #4). The overclaim must be gone from every rendered Docs page, lib/about.ts, README and the docs it names, and the
// honest wording must be there. Report: spikes/copy1/REPORT.md.
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ABOUT } from "../lib/about";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const norm = (s: string) => s.replace(/\s+/g, " ");
const README = norm(read("README.md"));
const VERIFY = norm(read("docs/VERIFY.md"));
const RT1B = norm(read("docs/REDTEAM-RT1b.md"));
const OPEN_ENVELOPE = read("apps/web/lib/openEnvelope.ts");

const { default: DocsPage } = await import("../src/components/docs/DocsPage");
type Page = "what" | "verification" | "intents" | "trust" | "hackathon";
const PAGES: Page[] = ["what", "verification", "intents", "trust", "hackathon"];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (page: Page) => text(renderToStaticMarkup(React.createElement(DocsPage, { page, navigate: () => {}, loggedOut: true })));
const ALL = Object.fromEntries(PAGES.map((p) => [p, render(p)])) as Record<Page, string>;
const ABOUT_TEXT = norm(JSON.stringify(ABOUT));
const everywhere = [...PAGES.map((p) => [p, ALL[p]] as const), ["lib/about.ts", ABOUT_TEXT] as const, ["README.md", README] as const];

test("COPY1 row 3: README says the hackathon-submission tag WILL mark the submitted commit (it doesn't exist yet)", () => {
  assert.doesNotMatch(README, /tag marks the submitted commit/);
  assert.match(README, /`hackathon-submission` tag will mark the submitted commit/);
});

test("COPY1 row 4: the 8/8 PASS claim names the --release record it needs (without it the check is 7/8)", () => {
  for (const m of README.matchAll(/8\/8 PASS/g)) {
    const before = README.slice(Math.max(0, m.index! - 160), m.index!);
    assert.match(before, /check-deployed-stack --network mainnet --release release\/mainnet-night\/release-mainnet\.json/);
  }
});

test("COPY1 row 5 + CLOSEOUT §1 #4: the contract supports a different token per side; the app creates same-token bets for now", () => {
  assert.match(OPEN_ENVELOPE, /taker_options: \[\]/, "the app still opens same-token offers only; if this changes, update the Docs wording");
  for (const [where, t] of everywhere) {
    assert.doesNotMatch(t, /each side can use a different token/i, where);
    assert.doesNotMatch(t, /Both sides of a bet can use different tokens/i, where);
    assert.doesNotMatch(t, /or the same value in another token/i, where);
  }
  for (const p of ["intents", "hackathon"] as const) {
    assert.match(ALL[p], /contract supports each side using a different token/i, p);
    assert.match(ALL[p], /app creates same-token bets for now/i, p);
  }
});

test("COPY1 row 6: a final YES/NO pays the winner unless no ruling can be made in time (e.g. the 3 paid runs used up early): then both are refunded", () => {
  // the run-order sentence stays (it is true), but never on its own: the caveat follows it
  assert.match(ALL.verification, /keep the answer they like\. A final YES or NO pays the winner, unless no ruling can be made in time/);
  const caveat = /unless no ruling can be made in time \(for example someone uses up the 3 paid runs early\); then both sides are refunded/i;
  assert.match(ALL.verification, caveat, "Verification › Strict run order");
  assert.match(README, caveat, "README What it is");
  const payout = norm(JSON.stringify(ABOUT.find((s) => s.id === "how")!.steps!.find((s) => s.title === "Payout")));
  assert.match(payout, caveat, "About › Payout");
});

test("COPY1 row 7: stakes never go to the wrong side, but a challenge bond can be lost (link to Trust › Known limits)", () => {
  assert.doesNotMatch(ALL.verification, /the money goes back to each side, never to the wrong one/);
  assert.match(ALL.verification, /Stakes go back to each side, never to the wrong one\. A challenge bond can be lost: see Trust › Known limits ?\./);
  const html = renderToStaticMarkup(React.createElement(DocsPage, { page: "verification", navigate: () => {}, loggedOut: true }));
  assert.match(html, /href="\/docs\/trust#known-limits"/, "the link goes to the Trust page's Known limits");
});

test("COPY1 row 8: 7-day retries only for built-in bet types; a custom bet whose source can't be read is refunded (VOID) at once", () => {
  const right = /For built-in bet types the judge retries for up to 7 days\. For custom bets, a source that can't be read ends the bet as a refund \(VOID\)\./;
  for (const [where, t] of everywhere) {
    assert.doesNotMatch(t, /tries again later \(for up to 7 days/i, where);
    assert.doesNotMatch(t, /after (its|the) retries,? up to 7 days\)/i, where);
    assert.doesNotMatch(t, /after retries of up to 7 days/i, where);
  }
  for (const p of ["what", "verification", "trust", "hackathon"] as const) assert.match(ALL[p], right, p);
  const refunds = norm(JSON.stringify(ABOUT.find((s) => s.id === "how")!.steps!.find((s) => s.title === "Refunds")));
  assert.match(refunds, right, "About › Refunds");
});

test("COPY1 row 9: a page one bettor controls can't make the result YES or NO, but it can force a refund (VOID)", () => {
  assert.doesNotMatch(ALL.trust, /A page one bettor controls can't make the result alone\./);
  assert.match(ALL.trust, /A page one bettor controls can't make the result YES or NO, but it can force a refund \(VOID\)\./);
});

test("COPY1 row 12: VERIFY.md says mainnet E4 is read from the 4 recorded txs; a live re-run is testnet-only", () => {
  assert.match(VERIFY, /On mainnet, E4 is checked by reading the 4 recorded report-pubkey txs; a live re-run is testnet-only\./);
});

test("COPY1 row 13: RT1b's 'no attack paid a wrong party' is marked superseded in part by SECREV1 SR-C1/SR-C2", () => {
  assert.match(RT1B, /Superseded in part by SECREV1 SR-C1\/SR-C2 \(High\)/);
});

test("COPY1 row 14: README says two different models (the current pairs happen to be from different companies)", () => {
  assert.doesNotMatch(README, /two AI models from different companies/i);
  assert.match(README, /two different AI models/i);
  assert.match(README, /current pairs are from different companies/i);
});

test("COPY1 row 15: a refund has no protocol fee, but the small terms-storage charge is not refunded", () => {
  for (const [where, t] of everywhere) {
    assert.doesNotMatch(t, /no fee is charged/i, where);
    assert.doesNotMatch(t, /no fee is taken/i, where);
    assert.doesNotMatch(t, /stake back with no fee[.,]/i, where);
  }
  const right = /no protocol fee; the small terms-storage charge is not refunded/i;
  for (const [where, t] of [["README", README], ["verification", ALL.verification], ["hackathon", ALL.hackathon], ["about", ABOUT_TEXT]] as const)
    assert.match(t, right, where);
});

test("COPY1 disclosure: Trust › Known limits names SR-C1, SR-C2 (mitigated in the app) and SR-C4 in plain words, with the planned fix", () => {
  assert.match(ALL.trust, /Known limits/);
  assert.match(ALL.trust, /Stakes are never paid to the wrong side/);
  // SR-C1
  assert.match(ALL.trust, /3 paid runs/);
  assert.match(ALL.trust, /refunded at its deadline instead of paid/);
  assert.match(ALL.trust, /next escrow version/i);
  // SR-C2
  assert.match(ALL.trust, /without stored terms/i);
  assert.match(ALL.trust, /The app never makes these and won't take them/);
  assert.match(ALL.trust, /challenge bond/i);
  // SR-C4
  assert.match(ALL.trust, /custom bet.*can't be read.*VOID/i);
  assert.match(ALL.trust, /check that the sources can be read before/i);
});

test("COPY1 disclosure: README › Known limits says the same", () => {
  const limits = README.slice(README.indexOf("## Known limits"));
  assert.match(limits, /Stakes are never paid to the wrong side/);
  assert.match(limits, /3 paid runs/);
  assert.match(limits, /without stored terms/i);
  assert.match(limits, /won't take them/);
  assert.match(limits, /custom bet.*can't be read.*VOID/i);
  assert.match(limits, /next escrow version/i);
  assert.match(limits, /contract supports each side using a different token; the app creates same-token bets for now/i);
});

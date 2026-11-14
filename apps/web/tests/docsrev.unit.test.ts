// DOCSREV: independent re-check of the Docs before the mainnet deploy (spikes/docsrev/REVIEW.md). Each test pins one WRONG/OVERCLAIM
// row of that review: the overclaim must be gone from every rendered Docs page (and the About copy they embed), and the honest wording
// must be there. Where the truth lives in code (the escrow's guardian- and operator-gated methods), the test reads the code, so a new
// admin power can't be added to the contract without the Docs saying so.
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ABOUT } from "../lib/about";
import { GUARDIAN_POWERS, OPERATOR_POWERS } from "../lib/docsFacts";
import ACCOUNTS from "../lib/mainnetAccounts.json" with { type: "json" };

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "../..");
const ESCROW_SRC = readFileSync(join(ROOT, "contracts/escrow/src/lib.rs"), "utf8");

const { default: DocsPage } = await import("../src/components/docs/DocsPage");
type Page = "what" | "verification" | "intents" | "trust" | "hackathon";
const PAGES: Page[] = ["what", "verification", "intents", "trust", "hackathon"];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (page: Page) => text(renderToStaticMarkup(React.createElement(DocsPage, { page, navigate: () => {}, loggedOut: true })));
const ALL = Object.fromEntries(PAGES.map((p) => [p, render(p)])) as Record<Page, string>;
const ABOUT_TEXT = JSON.stringify(ABOUT);
const everywhere = [...PAGES.map((p) => [p, ALL[p]] as const), ["lib/about.ts ABOUT", ABOUT_TEXT] as const];
const norm = (s: string) => s.replace(/\s+/g, " ");

/** The public escrow methods whose first check is `predecessor == self.<role>`. */
function gated(role: "guardian" | "operator"): string[] {
  const out: string[] = [];
  const re = /pub fn ([a-z_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ESCROW_SRC))) {
    const body = ESCROW_SRC.slice(m.index, m.index + 400);
    if (new RegExp(`predecessor_account_id\\(\\)\\s*==\\s*self\\.${role}\\b`).test(body)) out.push(m[1]!);
  }
  return out;
}

/** Each guardian-gated method, and the words GUARDIAN_POWERS must use for it. */
const GUARDIAN_WORDS: Record<string, RegExp> = {
  pause_new_offers: /pause/i, unpause_new_offers: /resume/i,
  propose_params: /fee and stake limits/i, cancel_params: /fee and stake limits/i,
  propose_judge_pair: /model pair/i, cancel_judge_pair: /model pair/i,
  propose_asset: /add a token/i, cancel_asset: /add a token/i, disable_asset_for_new_bets: /close a token to new bets/i,
  set_guardian: /hand the guardian role/i, cancel_guardian: /hand the guardian role/i,
  emergency_shutdown: /shut the escrow down/i,
};

test("DOCSREV F1: every guardian-only escrow method is named in GUARDIAN_POWERS (read from contracts/escrow/src/lib.rs)", () => {
  const g = gated("guardian");
  assert.ok(g.length >= 10, `found the guardian gates (${g.join(", ")})`);
  for (const fn of g) {
    assert.ok(GUARDIAN_WORDS[fn], `guardian method ${fn} has no Docs wording: add it to GUARDIAN_POWERS and GUARDIAN_WORDS`);
    assert.match(GUARDIAN_POWERS, GUARDIAN_WORDS[fn]!, fn);
  }
});

test("DOCSREV F1: the pages that list the guardian's powers list all of them, and none says it has only three", () => {
  for (const p of ["verification", "trust", "hackathon"] as const) assert.ok(ALL[p].includes(norm(GUARDIAN_POWERS)), `${p} shows GUARDIAN_POWERS`);
  for (const [where, t] of everywhere) {
    assert.doesNotMatch(t, /three switches/i, where);
    assert.doesNotMatch(t, /can only pause/i, where);
  }
  const verify = JSON.stringify(ABOUT.find((s) => s.id === "verify"));
  assert.match(verify, /model pair/i, "About's Frozen code bullet names the judge-pair power");
  assert.match(verify, /token/i, "About's Frozen code bullet names the token power");
});

test("DOCSREV F2: the operator's one power (closing an untaken offer) is on the Trust and Hackathon pages", () => {
  assert.deepEqual(gated("operator"), ["reclaim"]);
  assert.match(OPERATOR_POWERS, /offer nobody has taken/i);
  assert.match(OPERATOR_POWERS, /full/i);
  for (const p of ["trust", "hackathon"] as const) {
    assert.ok(ALL[p].includes(ACCOUNTS.operator), `${p} names ${ACCOUNTS.operator}`);
    assert.ok(ALL[p].includes(norm(OPERATOR_POWERS)), `${p} shows OPERATOR_POWERS`);
  }
  assert.doesNotMatch(ALL.trust, /we can't change a bet, its terms or its ruling/);
});

test("DOCSREV F3: payouts name every receiver (fee and storage to the fee account, a challenge's run cost to the keeper)", () => {
  assert.match(ESCROW_SRC, /"bond_round_cost_to_keeper"/);
  assert.match(ESCROW_SRC, /"fee_and_storage"/);
  assert.match(ALL.trust, /run cost/i);
  assert.match(ALL.trust, /storage charge/i);
  for (const [where, t] of everywhere) assert.doesNotMatch(t, /money can only go to you or the other person/i, where);
});

test("DOCSREV F4: an emergency shutdown refunds only bets whose ruling isn't final (emergency_refund skips Finalized)", () => {
  assert.match(ESCROW_SRC, /already Finalized; nothing scheduled/);
  for (const [where, t] of everywhere) {
    for (const over of [/refunds? every bet/i, /refund of any bet/i, /every bet is refunded/i, /every bet can be refunded/i])
      assert.doesNotMatch(t, over, where);
  }
  assert.match(ALL.verification, /already final/i);
});

test("DOCSREV F5: the judge claims match the resolver (single-model audit for data-feed bets, no 7-day promise for every bet, no fingerprint in the signature)", () => {
  for (const [where, t] of everywhere) {
    for (const over of [/Two AI models read the named sources and must agree/i, /word for word/i, /tries again for up to 7 days/i, /keeps trying for up to 7 days/i,
      /retries for up to 7 days, then VOID/i, /together with the program's fingerprint/i, /Each AI ruling comes from a pair of models/i])
      assert.doesNotMatch(t, over, where);
  }
  assert.match(ALL.verification, /one model/i, "the template audit (one model, can only confirm or force VOID) is described");
  assert.match(ALL.what, /one model/i);
});

test("DOCSREV F6: the hackathon rules say what nearhackathon.com says (no official criteria; development still running)", () => {
  assert.doesNotMatch(ALL.hackathon, /Judging covers/);
  assert.match(ALL.hackathon, /past NEAR hackathons/i);
  assert.doesNotMatch(ALL.hackathon, /Development ran/);
});

test("DOCSREV F7: smaller overclaims are gone (terms change, token list, Privy, verify-escrow exit code)", () => {
  for (const [where, t] of everywhere) {
    assert.doesNotMatch(t, /nobody can change the terms afterwards/i, where);
    assert.doesNotMatch(t, /accepts exactly the tokens above/i, where);
  }
  assert.match(ALL.trust, /concede/i, "a stolen login can concede a live bet");
  assert.match(ALL.trust, /exit code 3/i, "verify-escrow exits 3 when E4 is skipped");
});

test("DOCSREV F8: the mainnet verify-bet command passes --offline (without it E4 always FAILs: the escrow has no keys, so no OutLayer home can exist)", async () => {
  const { docsCommand } = await import("../lib/docsFacts");
  const cli = readFileSync(join(ROOT, "services/verifier/src/cli.ts"), "utf8");
  assert.match(cli, /use --offline to SKIP E4|--offline: live E4 is not run/);
  assert.match(docsCommand("verify-bet-full").text, /--network mainnet .*--offline\b/);
});

test("DOCSREV F9: the Trust page says NEAR AI signer binding doesn't work today (reports name models in model_name; the verifier reads .model)", () => {
  const attest = readFileSync(join(ROOT, "services/verifier/src/attest.ts"), "utf8");
  if (/m\?\.model === "string"/.test(attest) && !/model_name/.test(attest)) {
    assert.match(ALL.trust, /model_name/, "while attest.ts reads only .model, the page must say the live binding fails");
  }
});

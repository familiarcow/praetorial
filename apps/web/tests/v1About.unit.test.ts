// V1: About › "How to verify a bet" — numbered steps a non-developer can follow, a developer box with the checker, and only claims
// spikes/v1/CLAIMS.md found TRUE (the PARTLY/FALSE ones reworded so the site never overstates).
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ABOUT, RESOLVER_WASM_HASH_SHORT } from "../lib/about";

const v = ABOUT.find((s) => s.id === "verify")!;
const text = JSON.stringify(v);

test("About verify: numbered steps anyone can follow, starting from the bet page", () => {
  assert.equal(v.title, "How to verify a bet");
  assert.ok(v.steps && v.steps.length >= 5, "numbered steps");
  for (const w of [/Activity/, /Verify/, /NearBlocks/, /Download verification file/, /fingerprint/, /checker/]) assert.match(JSON.stringify(v.steps), w);
});

test("About verify: a developer box with the exact checker command and where to download it", () => {
  assert.ok(v.dev);
  assert.equal(v.dev!.scriptHref, "/verify-bet.mjs");
  assert.match(v.dev!.command, /^node verify-bet\.mjs <bet id> praetorial-bet-<bet id>-verification\.json$/);
  assert.match(v.dev!.text, /PASS, FAIL or SKIP/);
  assert.match(v.dev!.text, /no dependencies/i);
});

test("About verify: the FALSE / PARTLY claims are gone and the honest wording is there (spikes/v1/CLAIMS.md)", () => {
  for (const over of [/open program/i, /proven to come from that exact program/i, /Nobody, including us, can change its answer/i, /so nobody can change how bets are paid/i, /proves which program it is running/i])
    assert.doesNotMatch(text, over);
  for (const honest of [/source code is not public yet/i, /OutLayer's promise/i, /checked once, at deploy/i, /doesn't re-check/i, /can't be edited|can't change a ruling after it is signed/i, /emergency/i, /24 hour notice/i])
    assert.match(text, honest);
  assert.match(text, new RegExp(RESOLVER_WASM_HASH_SHORT));
  assert.match(text, /FastFS/);
  assert.match(text, /OutLayer/);
  assert.match(readFileSync(new URL("../../../spikes/v1/CLAIMS.md", import.meta.url), "utf8"), /\*\*FALSE\*\*/);
});

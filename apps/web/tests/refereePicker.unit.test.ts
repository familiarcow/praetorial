// WT1b (c): D-REFUI1 referee picker model (mock registry; no backend exists yet).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MockUserRegistry, MOCK_REGISTRY, DECIDER_CHOICES, pickReferee, checkRegistered, refereeTakeAgreementLine } from "../lib/refereeRegistry";
import * as registryMod from "../lib/refereeRegistry";
import { validateReferee } from "../lib/referee";

const reg = new MockUserRegistry([{ username: "Alice", account: "alice.testnet" }, { username: "bob", account: "bob.testnet" }]);

test("username search is case-insensitive, accepts a leading @, empty query returns nothing", async () => {
  assert.deepEqual((await reg.search("ALI")).map((u) => u.account), ["alice.testnet"]);
  assert.deepEqual((await reg.search("@bo")).map((u) => u.username), ["bob"]);
  assert.deepEqual(await reg.search("  "), []);
  assert.deepEqual(await reg.search("zed"), []);
});

test("registered users only: an unregistered account is refused with a clear message", async () => {
  assert.equal(await checkRegistered(reg, { mode: "human", referee: "alice.testnet" }), null);
  const e = await checkRegistered(reg, { mode: "human", referee: "rando.testnet" });
  assert.match(e!, /not a registered user/);
  assert.match((await checkRegistered(reg, { mode: "human" }))!, /Pick/);
  assert.equal(await checkRegistered(reg, { mode: "ai" }), null);
});

test("FE4 (UX-4/UX-17): the choice is {mode: ai|human, referee?}; the picker offers 'The AI decides' | 'A person decides' in plain English", () => {
  const p = pickReferee({ username: "alice", account: "alice.testnet" });
  assert.deepEqual(p.choice, { mode: "human", referee: "alice.testnet" });
  assert.ok(!("acceptance" in p), "no acceptance step exists (D-RFW1)");
  assert.equal(p.username, "alice");
  assert.deepEqual(DECIDER_CHOICES.map((d) => d.label), ["The AI decides", "A person decides"]);
  for (const d of DECIDER_CHOICES) assert.ok(!/Source|FinalSay|Witness/.test(d.blurb) && d.blurb.length > 20);
  assert.equal((registryMod as any).roleLabel, undefined, "the role label helper is gone (UX-17)");
  assert.equal((registryMod as any).DEFAULT_REFEREE_MODE, undefined);
});

test("D-RFW1/UX-18: no acceptance step exists; the review line names the referee and says taking the bet means agreeing", () => {
  for (const gone of ["fundingBlockedByReferee", "refereeAcceptanceLine"]) assert.equal((registryMod as any)[gone], undefined, gone + " must be deleted");
  const line = refereeTakeAgreementLine({ mode: "human", referee: "alice.testnet" }, "alice");
  assert.match(line, /@alice/);
  assert.match(line, /alice\.testnet/);
  assert.match(line, /taking this bet means (you )?agree/i);
  assert.ok(!/waiting|accept/i.test(line));
  assert.equal(refereeTakeAgreementLine({ mode: "ai" }), "");
});

test("referee is still never the maker or the named taker", () => {
  const c = { mode: "human" as const, referee: "alice.testnet" };
  assert.deepEqual(validateReferee(c, { maker: "maker.testnet", taker: "taker.testnet" }), []);
  assert.match(validateReferee(c, { maker: "alice.testnet", taker: null })[0], /can't pick yourself/);
  assert.match(validateReferee(c, { maker: "maker.testnet", taker: "alice.testnet" })[0], /cannot be the taker/);
});

test("mock registry ships usable dev users", async () => {
  assert.ok((await MOCK_REGISTRY.search("alic")).length >= 2);
});

test("UI wiring: CreateOffer uses the registry picker; ReviewCard shows username + tail + UX-18 line; Open has no referee gate", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const co = readFileSync(join(here, "../src/components/CreateOffer.tsx"), "utf8") + readFileSync(join(here, "../src/components/WhoDecides.tsx"), "utf8"); // BET1c: the block moved to WhoDecides
  const rc = readFileSync(join(here, "../src/components/ReviewCard.tsx"), "utf8");
  assert.ok(co.includes('data-testid="referee-search"') && co.includes("pickReferee") && co.includes("checkRegistered"));
  // C1 (PEOPLE RULE): the referee is "@alice" (no account tail); a taker's agreement line is a Full terms row of lib/reviewCard.ts
  const rm = readFileSync(join(here, "../lib/reviewCard.ts"), "utf8");
  assert.ok(rm.includes('add("agreement"') && rm.includes("Taking this bet means you agree to"));
  assert.ok(!rc.includes("refereeTakeAgreementLine") && !rm.includes("accountTail"));
  assert.ok(!/waiting for|refereeAcceptance/i.test(rc), "no waiting-for-acceptance text on the review card");
  assert.ok(!/waiting for|must accept/i.test(co), "no acceptance wording in CreateOffer");
  const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
  for (const gone of ["fundingBlockedByReferee", "mock-referee-accept", "referee-block", "RefereeAcceptance", "refereeAcceptance", "refereeBlock"]) {
    assert.ok(!app.includes(gone), "App.tsx must not contain " + gone);
  }
});

test("Open button enabled with a Person referee picked and no acceptance, when every other check passes", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // C1 (SM2 gap C1-2): the Open button's condition is lib/createFlow openButton, fed by App.
  const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
  const i = app.indexOf("openButton({");
  const call = app.slice(i, app.indexOf("})", i));
  assert.ok(/checkState: sourceCheck/.test(call) && /hasAttestation: !!attestation/.test(call) && /address: nearAddress/.test(call), "other checks stay");
  assert.ok(!/referee/i.test(call), "no referee term in the Open button input");
  const lib = readFileSync(join(here, "../lib/createFlow.ts"), "utf8");
  const fn = lib.slice(lib.indexOf("export function openButton"), lib.indexOf("export function openProgress"));
  assert.ok(/a\.checkState !== "ok"/.test(fn) && /!a\.hasAttestation/.test(fn) && /!a\.address/.test(fn));
  assert.ok(!/referee/i.test(fn), "no referee term in the Open disabled condition");
});

// FE4 (S4 / UX-4, UX-5, UX-15, UX-17, UX-18, D-UX21): the resolver model {mode: "ai" | "human", referee?}, its validation,
// the tip lines (amount from the contract tip rule), the invite text, and the picker's wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AI_CHOICE, humanChoice, refereeAccount, validateReferee, accountMatches, isUsableAccount, refereeTipLine, refereeCostLine, inviteText, type RefereeChoice } from "../lib/referee";
import { tailOf, resultRowLabel, searchHint } from "../lib/refereeRegistry";
import release from "../lib/release.json";

const here = dirname(fileURLToPath(import.meta.url));
const ctx = (o: Record<string, unknown> = {}) => ({ maker: "maker.testnet", taker: null as string | null, feeAccount: "fee.testnet", ...o });

test("model: AI is the default; human carries the referee account; the old none/Human/role shapes are gone", () => {
  assert.deepEqual(AI_CHOICE, { mode: "ai" });
  assert.deepEqual(humanChoice("bob.testnet"), { mode: "human", referee: "bob.testnet" });
  assert.equal(refereeAccount(AI_CHOICE), null);
  assert.equal(refereeAccount(humanChoice(" bob.testnet ")), "bob.testnet");
  assert.equal(refereeAccount({ mode: "human" }), null);
  const src = readFileSync(join(here, "../lib/referee.ts"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/"none"|Witness|FinalSay/.test(src));
});

test("validation: AI always passes; human needs a pick that is not the maker, the named taker or the fee account", () => {
  assert.deepEqual(validateReferee(AI_CHOICE, ctx()), []);
  assert.match(validateReferee({ mode: "human" }, ctx())[0], /Pick someone, or switch back to the AI/);
  assert.deepEqual(validateReferee(humanChoice("bob.testnet"), ctx()), []);
  assert.match(validateReferee(humanChoice("maker.testnet"), ctx())[0], /can't pick yourself/);
  assert.match(validateReferee(humanChoice("t.testnet"), ctx({ taker: "t.testnet" }))[0], /Referee cannot be the taker/);
  assert.match(validateReferee(humanChoice("fee.testnet"), ctx())[0], /can't be a referee/);
  assert.deepEqual(validateReferee(humanChoice("fee.testnet"), ctx({ feeAccount: null })), []); // unknown fee account: the contract still refuses
});

test("an implicit account shown as its 8-char tail still matches the maker (self-pick) but is not usable as a referee", () => {
  const maker = "ab".repeat(28) + "12345678";
  assert.equal(maker.length, 64);
  assert.ok(accountMatches(maker, "12345678"));
  assert.ok(!accountMatches(maker, "87654321"));
  assert.ok(accountMatches("bob.testnet", "bob.testnet"));
  assert.match(validateReferee(humanChoice("12345678"), { maker, taker: null })[0], /can't pick yourself/);
  assert.ok(isUsableAccount("bob.testnet") && isUsableAccount(maker));
  assert.ok(!isUsableAccount("12345678") && !isUsableAccount(""));
});

test("tail + row label: username and account tail only, never an email", () => {
  assert.equal(tailOf("ab".repeat(28) + "12345678"), "12345678");
  assert.equal(tailOf("bob.testnet"), "bob.testnet");
  assert.equal(resultRowLabel({ username: "bob", account: "bob.testnet" }), "@bob \u00b7 bob.testnet");
});

test("tip lines come from the contract tip rule amount and are plain English (UX-5/UX-15)", () => {
  assert.equal(refereeTipLine("0.50", "USDC"), "You pay 0.50 USDC to the referee when the bet ends, whatever the result. That is the same as the platform fee on your stake.");
  const off = refereeCostLine({ tipOn: false, stake: "10.00", tip: "0.50", symbol: "USDC" });
  const on = refereeCostLine({ tipOn: true, stake: "10.00", tip: "0.50", symbol: "USDC" });
  assert.notEqual(off, on);
  assert.match(off, /No tip/);
  assert.match(on, /0\.50 USDC/);
  assert.match(on, /out of your 10\.00 USDC stake/); // carved from the tipper's own stake, its own line
});

test("hints and invite text: UX-1 'join Praetorial'; empty search prompt", () => {
  assert.equal(searchHint(""), "Start typing a username.");
  assert.equal(searchHint("zz"), "No one with that name");
  assert.match(inviteText("https://praetorial.example"), /join Praetorial/i);
  assert.match(inviteText("https://praetorial.example"), /https:\/\/praetorial\.example/);
});

test("release.json pins the fee account (matches release/draft-args.<network>.json)", () => {
  const args = JSON.parse(readFileSync(join(here, `../../../release/draft-args.${release.network}.json`), "utf8"));
  assert.equal((release as any).fee_account, args.fee_account);
});

test("UI wiring: no acceptance step, tip + cost line, invite text, registry from REGISTRY_URL", () => {
  const co = readFileSync(join(here, "../src/components/CreateOffer.tsx"), "utf8") + readFileSync(join(here, "../src/components/WhoDecides.tsx"), "utf8"); // BET1c: the block moved to WhoDecides
  const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
  for (const id of ["referee-selected", "referee-change", "referee-clear", "referee-search-hint", "referee-no-results", "referee-invite-text", "referee-tip-line", "referee-cost-line", "referee-pick-error"]) assert.ok(co.includes(`data-testid="${id}"`), id);
  assert.ok(!/accept(ance)? (step|gate)|waiting for/i.test(co));
  assert.ok(/HttpUserRegistry/.test(app) && /refereeRegistry=/.test(app));
  const t: RefereeChoice = AI_CHOICE; assert.equal(t.mode, "ai");
});

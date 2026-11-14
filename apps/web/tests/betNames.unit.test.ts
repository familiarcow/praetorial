// B1 (familiarcow 2026-11-11 "people are @usernames everywhere"): lib/betNames.ts. accountsOnBet lists everyone a bet page names;
// nameAccountsIn turns the account ids in a library message (payoutScreen, refereeChange) into people.
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import { accountsOnBet, nameAccountsIn, hideAmounts } from "../lib/betNames";

const HEX = "ab".repeat(32);
const label = (a: string) => ({ "maker.testnet": "@maker", "m.testnet": "@m", [HEX]: "@hexy", "fee.testnet": "the Praetorial fee account" } as Record<string, string>)[a] ?? `?${a}`;

test("nameAccountsIn: every whole account id becomes the person; ids inside longer ids are left alone", () => {
  assert.equal(nameAccountsIn("Sending 19.00 USDC to maker.testnet", ["maker.testnet"], label), "Sending 19.00 USDC to @maker");
  assert.equal(nameAccountsIn("maker.testnet was paid. maker.testnet again.", ["maker.testnet"], label), "@maker was paid. @maker again.");
  // "m.testnet" must not match inside "maker.testnet" or "xm.testnet"; longest first
  assert.equal(nameAccountsIn("maker.testnet and m.testnet, not xm.testnet", ["m.testnet", "maker.testnet"], label), "@maker and @m, not xm.testnet");
  // a 64-hex implicit id; and an id followed by a sentence dot still matches
  assert.equal(nameAccountsIn(`Paid to ${HEX}.`, [HEX], label), "Paid to @hexy.");
  assert.equal(nameAccountsIn("Sending 1.04 USDC to fee.testnet", ["fee.testnet"], label), "Sending 1.04 USDC to the Praetorial fee account");
  // regex characters in an id are literal; "$&" in a label is not a replacement pattern
  assert.equal(nameAccountsIn("a+b.testnet", ["a+b.testnet"], () => "$&x"), "$&x");
  assert.equal(nameAccountsIn("nothing here", [], label), "nothing here");
});

test("accountsOnBet: maker, taker, named taker, referee, challengers, evidence filers, proposed referees (each once)", () => {
  const bet: any = {
    envelope: { maker: "maker.testnet", referee: { account: "ref.testnet" }, taker_allow: { Account: "only.testnet" } }, taker: "taker.testnet", challenged_by: "taker.testnet",
    bonds: [{ holder: "taker.testnet" }, { holder: "maker.testnet" }], exhibits: [{ submitted_by: "ev.testnet" }],
    referee_proposal: { maker_value: JSON.stringify({ account: "newref.testnet", mode: "Human" }), taker_value: "null" },
  };
  assert.deepEqual(accountsOnBet(bet).sort(), ["ev.testnet", "maker.testnet", "newref.testnet", "only.testnet", "ref.testnet", "taker.testnet"]);
});

test("hideAmounts (stale money): every token amount becomes a dash; times and other numbers stay", () => {
  assert.equal(hideAmounts("You put in 10.00 USDC to win 15 NEAR."), "You put in — to win —.");
  assert.equal(hideAmounts("Tip < 0.01 NEAR, pot 1,250.5 USDT"), "Tip —, pot —");
  assert.equal(hideAmounts("Closes in 10 years. First challenge, round 1 of 2."), "Closes in 10 years. First challenge, round 1 of 2.");
  assert.equal(hideAmounts("@kim ruled YES."), "@kim ruled YES.");
});

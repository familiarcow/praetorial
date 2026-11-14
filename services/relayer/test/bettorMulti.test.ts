// RED-first (theme: desync). Relayer bettor lookup without an indexer must see
// bettors on EVERY configured escrow contract, not just the first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escrowBettorLookupMulti } from "../src/bettor.js";

const bet = (maker: string, taker: string | null) => ({ envelope: { maker }, taker });
const client: any = {
  async view(c: string, _m: string, a: any) {
    if (c === "v1.testnet") return a.bet_id === 1 ? bet("alice.testnet", null) : null;
    if (c === "v2.testnet") return a.bet_id === 1 ? bet("bob.testnet", "carol.testnet") : null;
    throw new Error("unknown");
  },
};
test("bettors on the new (second) contract are recognised; strangers are not", async () => {
  const look = escrowBettorLookupMulti(client, [{ id: "v1.testnet", version: "v1" }, { id: "v2.testnet", version: "v2" }]);
  assert.equal(await look("alice.testnet"), true);
  assert.equal(await look("carol.testnet"), true);
  assert.equal(await look("mallory.testnet"), false);
});
test("one dead contract does not make everyone a non-bettor, and never makes a stranger a bettor", async () => {
  const c2: any = { async view(c: string, m: string, a: any) { if (c === "dead.testnet") throw new Error("x"); return client.view(c, m, a); } };
  const look = escrowBettorLookupMulti(c2, [{ id: "dead.testnet", version: "v0" }, { id: "v2.testnet", version: "v2" }]);
  assert.equal(await look("bob.testnet"), true);
  assert.equal(await look("mallory.testnet"), false);
});

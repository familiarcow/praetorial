// KEEPSUBMIT1: golden test on a REAL on_resolution-stored output (frz2 bet 18, captured read-only from testnet; fixtures/bet18.json).
// Proves the relayed args are exactly what the resolver signed: the real signature verifies, with the real resolver pubkey, over the
// buffer built from the relayed result. The bet-18 state at capture time (Proposed, used [1]) is the live "keeper must skip" case.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import nacl from "tweetnacl";
import { planOutcomeRelay } from "@praetorial/common/outcomeRelay.js";
import { buildSubmitOutcomeMessage } from "@praetorial/common/resolverSign.js";
import { makeBet } from "./helpers/signedRaw.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/bet18.json", import.meta.url), "utf8"));
const asResolving = () => makeBet("Resolving", fx.last_resolution_raw, { betId: fx.bet_id, pending: 1, used: [], terms: fx.terms_hash });

test("real bet-18 raw: relay args carry a signature that verifies under the stored resolver pubkey", () => {
  const p = planOutcomeRelay(fx.contract, fx.bet_id, asResolving());
  assert.equal(p.ok, true, p.ok ? "" : p.reason);
  if (!p.ok) return;
  const o = JSON.parse(fx.last_resolution_raw);
  assert.equal(p.args.signature_hex, o.signing.signature_hex);
  assert.equal(typeof p.args.result.checked_until, "string");
  const ok = nacl.sign.detached.verify(buildSubmitOutcomeMessage(fx.contract, p.args.result as any), Buffer.from(p.args.signature_hex, "hex"), Buffer.from(o.signing.pubkey_hex, "hex"));
  assert.equal(ok, true, "the real resolver signature must verify over the relayed result");
});

test("real bet-18 as it is live now (Proposed, run 1 used): the keeper skips it", () => {
  assert.equal(fx.status_at_capture, "Proposed");
  const live = makeBet("Proposed", fx.last_resolution_raw, { betId: fx.bet_id, pending: null, used: fx.used_run_nos_at_capture, terms: fx.terms_hash });
  assert.equal(planOutcomeRelay(fx.contract, fx.bet_id, live).ok, false);
});

test("real bet-18 raw replayed against another escrow id is refused", () => {
  assert.equal(planOutcomeRelay("praetorial-frz3-2611100414.praetorial-dev-1101.testnet", fx.bet_id, asResolving()).ok, false);
});

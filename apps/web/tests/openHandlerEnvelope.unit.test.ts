// DR-WEB-ASSET-MISMATCH-1 / DR-WEB-ENVELOPE-STALE-1 (drift review 2026-11-05).
// Structural RED test: the "Open offer onchain" handler in src/App.tsx must
// build an Envelope the CURRENT escrow contract accepts.
//  - contracts/escrow/src/lib.rs handle_open refunds unless the transferred
//    token_id == envelope.maker_asset, so the handler must deposit the same
//    asset it names as maker_asset.
//  - Envelope no longer has reserve_per_side / run_price / arbiter /
//    arbiter_fee (changelog v1.6/v1.8; referee replaced arbiter), so the
//    handler must not send them and must carry `referee`.
// Stays red until App.tsx is fixed (TEST POLICY 2026-11-03: never skip).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
const start = app.indexOf("const openBet = async") /* MODAL1c1: the handler moved out of the button into openBet */;
const handler = app.slice(start, app.indexOf("signRawHash", start));

test("open handler deposits the asset it declares as maker_asset", () => {
  assert.ok(start >= 0, "open-offer-btn handler not found");
  const m = handler.match(/maker_asset:\s*([^,\n]+),/);
  const t = handler.match(/(?:token_id|tokenId):\s*([^,\n]+),/); // INTENTS1: buildStakeTransfer({ tokenId })
  assert.ok(m && t, "maker_asset / token_id not found in handler");
  assert.equal(
    t![1].trim(),
    m![1].trim().replace(/^envelope\./, ""),
    "transfer token_id must be the same expression/value as envelope.maker_asset (handle_open refunds otherwise)",
  );
});

test("open handler envelope has no fields removed from the contract Envelope", () => {
  for (const f of ["reserve_per_side", "run_price", "arbiter", "arbiter_fee"]) {
    assert.ok(!new RegExp(`\\b${f}\\s*:`).test(handler), `stale Envelope field ${f} still sent`);
  }
  assert.ok(/\breferee\s*:/.test(handler), "Envelope.referee missing");
});

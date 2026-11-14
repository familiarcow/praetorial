// F1: intentCheck accepts exactly one transfer of amountIn of originAsset to the deposit address, signed by the user, and
// refuses every other shape; hashNep413Payload is byte-identical to services/common/src/nep413.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSwapTransferIntent, hashNep413Payload, type IntentExpect } from "../../src/funding/intentCheck.js";
import { hashNep413 } from "../../src/nep413.js";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const E: IntentExpect = { signerId: "a".repeat(64), depositAddress: "dep.near", originAsset: "nep141:usdt.tether-token.near", amountIn: "20000000", maxDeadlineMs: NOW + 30 * 60_000, nowMs: NOW };
const msg = (o: Record<string, unknown> = {}, t: Record<string, unknown> = {}) => JSON.stringify({ signer_id: E.signerId, deadline: new Date(NOW + 60_000).toISOString(), intents: [{ intent: "transfer", receiver_id: "dep.near", tokens: { [E.originAsset]: "20000000" }, ...t }], ...o });
const intent = (message = msg(), p: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({ standard: "nep413", payload: { message, nonce: Buffer.alloc(32, 1).toString("base64"), recipient: "intents.near", ...p }, ...top });

test("the exact transfer passes (memo allowed)", () => {
  assert.equal(checkSwapTransferIntent(intent(), E).ok, true);
  assert.equal(checkSwapTransferIntent(intent(msg({}, { memo: "1click" })), E).ok, true);
});

test("every deviation is refused", () => {
  const bad: [string, unknown][] = [
    ["erc191", { ...intent(), standard: "erc191" }],
    ["extra top field", intent(undefined, {}, { public_key: "x" })],
    ["callbackUrl", intent(undefined, { callbackUrl: "https://evil" })],
    ["recipient", intent(undefined, { recipient: "evil.near" })],
    ["short nonce", intent(undefined, { nonce: Buffer.alloc(31).toString("base64") })],
    ["not json", intent("{")],
    ["signer", intent(msg({ signer_id: "b".repeat(64) }))],
    ["late deadline", intent(msg({ deadline: new Date(NOW + 31 * 60_000).toISOString() }))],
    ["past deadline", intent(msg({ deadline: new Date(NOW - 1).toISOString() }))],
    ["two intents", intent(JSON.stringify({ ...JSON.parse(msg()), intents: [JSON.parse(msg()).intents[0], JSON.parse(msg()).intents[0]] }))],
    ["zero intents", intent(msg({ intents: [] }))],
    ["receiver", intent(msg({}, { receiver_id: "evil.near" }))],
    ["token", intent(msg({}, { tokens: { "nep141:wrap.near": "20000000" } }))],
    ["two tokens", intent(msg({}, { tokens: { [E.originAsset]: "20000000", "nep141:wrap.near": "1" } }))],
    ["amount", intent(msg({}, { tokens: { [E.originAsset]: "20000001" } }))],
    ["msg", intent(msg({}, { msg: "call" }))],
    ["state_init", intent(msg({}, { state_init: {} }))],
    ["token_diff", intent(msg({ intents: [{ intent: "token_diff", diff: {} }] }))],
    ["extra message field", intent(msg({ verifying_contract: "x" }))],
  ];
  for (const [name, i] of bad) { const r = checkSwapTransferIntent(i, E); assert.equal(r.ok, false, name); }
  assert.equal(checkSwapTransferIntent(null, E).ok, false);
});

test("hashNep413Payload == services/common nep413.ts hashNep413 (with and without callbackUrl)", () => {
  const nonce = Buffer.alloc(32, 5);
  for (const cb of [undefined, "https://cb"]) {
    const a = hashNep413Payload({ message: msg(), nonce: nonce.toString("base64"), recipient: "intents.near", callbackUrl: cb ?? null });
    const b = hashNep413({ message: msg(), nonce, recipient: "intents.near", callbackUrl: cb });
    assert.equal(Buffer.from(a).toString("hex"), b.toString("hex"));
  }
});

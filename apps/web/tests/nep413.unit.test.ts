// FE2: browser-side NEP-413 hashing must equal the registry's server-side hashNep413 byte for byte, and the
// wallet path (signRawHash) must be what produces the signature handed to claimUsername.
import test from "node:test";
import assert from "node:assert/strict";
import { hashNep413 as webHash, makeSignMessage } from "../lib/nep413";
import { hashNep413 as serverHash } from "../../../services/common/src/nep413";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

test("web hashNep413 == services/common hashNep413 for several payloads", () => {
  for (const [message, recipient, fill] of [["praetorial-username:alice", "registry.praetorial-dev-1101.testnet", 7], ["praetorial-username:b0b_9", "r.testnet", 0], ["x", "y", 255]] as const) {
    const nonce = new Uint8Array(32).fill(fill);
    assert.equal(hex(webHash({ message, nonce, recipient })), Buffer.from(serverHash({ message, nonce: Buffer.from(nonce), recipient })).toString("hex"));
  }
});
test("hashNep413 rejects a nonce that is not 32 bytes", () => {
  assert.throws(() => webHash({ message: "m", nonce: new Uint8Array(31), recipient: "r" }), /32/);
});
test("makeSignMessage signs the NEP-413 hash with the wallet's signRawHash and returns the raw 64 bytes", async () => {
  const seen: { address?: string; hash?: string } = {};
  const sign = makeSignMessage("11".repeat(32), async (address, hashHex) => { seen.address = address; seen.hash = hashHex; return "ab".repeat(64); });
  const nonce = new Uint8Array(32).fill(3);
  const { signature } = await sign({ message: "praetorial-username:alice", nonce, recipient: "reg.testnet" });
  assert.equal(signature.length, 64);
  assert.equal(seen.address, "11".repeat(32));
  assert.equal(seen.hash!.replace(/^0x/, ""), hex(webHash({ message: "praetorial-username:alice", nonce, recipient: "reg.testnet" })));
  const sign0x = makeSignMessage("a", async () => "0x" + "cd".repeat(64));
  assert.equal((await sign0x({ message: "m", nonce, recipient: "r" })).signature.length, 64);
});

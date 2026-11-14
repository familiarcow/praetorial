// REGCLAIM1: a username claim signed by a Privy-style embedded wallet (account id = 64-hex raw ed25519 pubkey, signRawHash(hash hex) -> sig hex)
// must be ACCEPTED by the registry's real parse+verify, and a forged / wrong-key claim must still be refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { claimWithWallet } from "../lib/refereeRegistry";
import { parseClaim, verifyClaimSignature, HttpErr } from "../../../services/registry/src/core";

const REG = "registry.praetorial.testnet";
function privyWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const account = raw.toString("hex"); // Privy nearWallet.address = implicit account id
  const signRawHash = async (_a: string, hashHex: string) => sign(null, Buffer.from(hashHex, "hex"), privateKey).toString("hex");
  return { account, signRawHash };
}
const nodeVerify = (d: Uint8Array, s: Uint8Array, pk: Uint8Array) =>
  verify(null, d, createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk]), format: "der", type: "spki" }), s);

async function bodyFor(w: ReturnType<typeof privyWallet>, signRawHash = w.signRawHash) {
  let body = "";
  const fetchImpl = (async (_u: string, init: any) => { body = init.body; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  await claimWithWallet({ registryUrl: "https://r", registryId: REG, username: "alice", account: w.account, signRawHash, fetchImpl });
  return body;
}

test("Privy-style claim body is accepted by the registry parse + signature verify", async () => {
  const w = privyWallet();
  const c = parseClaim(await bodyFor(w), Date.now());
  assert.equal(c.accountId, w.account);
  await verifyClaimSignature(c, REG, nodeVerify);
});
test("a claim signed by a different key than the account's is still refused", async () => {
  const w = privyWallet(), other = privyWallet();
  const c = parseClaim(await bodyFor(w, other.signRawHash), Date.now());
  await assert.rejects(() => verifyClaimSignature(c, REG, nodeVerify), (e: any) => e instanceof HttpErr && e.status === 401);
});
test("registry still rejects a raw-hex public_key (verification not loosened)", async () => {
  const w = privyWallet();
  const b = JSON.parse(await bodyFor(w)); b.public_key = w.account;
  assert.throws(() => parseClaim(JSON.stringify(b), Date.now()), (e: any) => e.status === 400 && e.code === "bad_key_or_signature");
});
test("claim body public_key is ed25519:<base58> (not raw hex)", async () => {
  const w = privyWallet();
  const b = JSON.parse(await bodyFor(w));
  assert.match(b.public_key, /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
});
test("claim signed for the network registryId is refused when verified against a different recipient", async () => {
  const w = privyWallet();
  const c = parseClaim(await bodyFor(w), Date.now());
  await assert.rejects(() => verifyClaimSignature(c, "registry.praetorial-dev-1101.testnet", nodeVerify), (e: any) => e instanceof HttpErr && e.status === 401);
});

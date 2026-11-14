// F1: per-chain recipient validation vectors (valid / bad checksum / wrong format / refused).
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, validateRecipient as v, isMemoChain, EVM_CHAINS } from "../../src/funding/chainAddress.js";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
test("keccak256 vectors", () => {
  assert.equal(hex(keccak256(new Uint8Array())), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(hex(keccak256(new TextEncoder().encode("abc"))), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(hex(keccak256(new Uint8Array(200).fill(0x61))).length, 64, "multi-block input");
});

const VALID: [string, string][] = [
  ["eth", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"], ["base", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"], ["arb", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"],
  ["btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"], ["btc", "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297"], ["btc", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"], ["btc", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"],
  ["tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"], ["sol", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"], ["xrp", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"],
  ["stellar", "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"], ["ton", "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N"], ["ton", `0:${"ab".repeat(32)}`],
  ["zec", "t1JWm9xJLM9qcJyPgLfg1bHbZDUd4PKpqXb"], ["zec", "t3KCn5Vnmu49zQ967TmLc1uxVMzumyMyaAx"], ["doge", "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L"],
  ["ltc", "LaMT348PWRnrqeeWArpwQPbuanpXDZGEUz"], ["ltc", "ltc1qqurswpc8qurswpc8qurswpc8qurswpc8p4r4uu"], ["dash", "XbKzysY6LYGbsGwNG8B7K1BRoA1ffLodAT"],
  ["near", "example.near"], ["near", "a".repeat(64)], ["near", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"], ["sui", `0x${"1".repeat(64)}`], ["aptos", `0x${"f".repeat(64)}`],
  ["cardano", "addr1qxyz"],
];
const INVALID: [string, string, string][] = [
  ["eth", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", "checksum"], ["eth", "0x123", "format"], ["eth", "0x000000000000000000000000000000000000dEaD", "refused"], ["eth", `0x${"0".repeat(40)}`, "refused"],
  ["btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx", "checksum"], ["btc", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb", "checksum"], ["btc", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "format"],
  ["tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u", "checksum"], ["tron", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format"],
  ["sol", "11111111111111111111111111111111", "refused"], ["sol", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "refused"], ["sol", "0OIl", "format"],
  ["xrp", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi", "checksum"], ["stellar", "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN6", "checksum"],
  ["ton", "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2M", "checksum"], ["zec", "u1abc", "format"], ["zec", "t1JWm9xJLM9qcJyPgLfg1bHbZDUd4PKpqXc", "checksum"],
  ["near", "intents.near", "refused"], ["near", "btc.omft.near", "refused"], ["near", "bets.praetorial.near", "refused"], ["near", "Bad.near", "format"],
  ["sui", "0x12", "format"], ["cardano", "has space", "format"], ["eth", "", "empty"], ["eth", " 0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format"],
];

test("valid addresses pass", () => { for (const [c, a] of VALID) assert.deepEqual(v(c, a), { ok: true }, `${c} ${a}`); });
test("invalid addresses fail with the right reason", () => { for (const [c, a, reason] of INVALID) { const r = v(c, a); assert.equal(r.ok, false, `${c} ${a}`); assert.equal((r as any).reason, reason, `${c} ${a}`); } });
test("refused: the user's own 64-hex id on another chain, and their own open deposit addresses", () => {
  const acct = "1".repeat(64);
  assert.equal((v("sui", `0x${acct}`, { account: acct }) as any).reason, "refused");
  assert.deepEqual(v("near", acct, { account: acct }), { ok: true }, "to their own NEAR account is fine");
  assert.equal((v("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", { refused: ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"] }) as any).reason, "refused");
});
test("memo chains: xrp, stellar, ton; every EVM chain uses EIP-55", () => {
  assert.deepEqual(["xrp", "stellar", "ton", "eth", "tron"].map(isMemoChain), [true, true, true, false, false]);
  for (const c of EVM_CHAINS) assert.equal((v(c, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD") as any).reason, "checksum", c);
});

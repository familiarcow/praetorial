// IN1: maker-side invite links. Contract refs (contracts/escrow/src/lib.rs): TakerAllow::InvitePubkey(String) = ed25519
// pubkey as lowercase/any-case HEX (32 bytes -> 64 chars), parsed by verify_sig's hex_decode; handle_take verifies a 64-byte
// hex invite_sig over the UTF-8 bytes of "praetorial:invite:v1:{bet_id}:{sender_id}". Unit tests only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import nacl from "tweetnacl";
import { generateInviteKey, saveInviteKey, loadInviteSecret, inviteSecretForBet, signInvite, buildInviteUrl, inviteKeyStorageKey } from "../lib/inviteLink";
import { makeTakerAllow, buildOpenMsg } from "../lib/escrowAdapter";
import { parseInviteLink, takeEligibility } from "../lib/takeScreen";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

test("contract shape: TakerAllow::InvitePubkey(String) hex, 32-byte key / 64-byte sig, message prefix", () => {
  assert.match(rs, /enum TakerAllow \{[^}]*InvitePubkey\(String\)/s);
  assert.match(rs, /if pk\.len\(\) != 32 \|\| sig\.len\(\) != 64/);
  assert.ok(rs.includes('format!("praetorial:invite:v1:{bet_id}:{sender_id}")'));
});

test("generateInviteKey: fresh ed25519 keypair, pubkey is 64 hex chars", () => {
  const a = generateInviteKey(), b = generateInviteKey();
  assert.match(a.pubkeyHex, /^[0-9a-f]{64}$/);
  assert.match(a.secretHex, /^[0-9a-f]{128}$/);
  assert.notEqual(a.pubkeyHex, b.pubkeyHex);
  assert.equal(hex(nacl.sign.keyPair.fromSecretKey(Uint8Array.from(Buffer.from(a.secretHex, "hex"))).publicKey), a.pubkeyHex);
});

test("envelope: invite mode puts {InvitePubkey: <hex>} in taker_allow (exact contract JSON shape); Account/Any unchanged", () => {
  const k = generateInviteKey();
  assert.deepEqual(makeTakerAllow({ invitePubkey: k.pubkeyHex }), { InvitePubkey: k.pubkeyHex });
  assert.deepEqual(makeTakerAllow("bob.testnet"), { Account: "bob.testnet" });
  assert.equal(makeTakerAllow(null), "Any");
  assert.throws(() => makeTakerAllow({ invitePubkey: "nothex" }), /64 hex/);
  const env: any = { bet_id: 0, version: 1, maker: "m.testnet", resolve_deadline: Date.now() * 1e6 + 1e9 };
  const msg = JSON.parse(buildOpenMsg(env, { checked_at: 1, signature_hex: "ab".repeat(64) } as any, { invitePubkey: k.pubkeyHex }));
  assert.deepEqual(msg.envelope.taker_allow, { InvitePubkey: k.pubkeyHex });
  assert.ok(!JSON.stringify(msg).includes(k.secretHex), "secret never in the Open msg");
});

test("round trip: generate -> sign for X -> link -> parseInviteLink -> takeEligibility accepts X, refuses Y", () => {
  const k = generateInviteKey();
  const sig = signInvite({ secretHex: k.secretHex, betId: 42, invitee: "x.testnet" });
  assert.match(sig, /^[0-9a-f]{128}$/);
  const url = buildInviteUrl("https://app.example/praetorial/", 42, sig);
  assert.equal(url, `https://app.example/praetorial/?bet=42&invite=${sig}`);
  const parsed = parseInviteLink(url);
  assert.equal(parsed, sig);
  const allow = makeTakerAllow({ invitePubkey: k.pubkeyHex });
  assert.equal(takeEligibility({ takerAllow: allow, betId: 42, taker: "x.testnet", inviteSig: parsed }).ok, true);
  assert.equal(takeEligibility({ takerAllow: allow, betId: 42, taker: "y.testnet", inviteSig: parsed }).ok, false);
  assert.equal(takeEligibility({ takerAllow: allow, betId: 43, taker: "x.testnet", inviteSig: parsed }).ok, false);
});

test("signInvite refuses a blank invitee / bad bet id / bad secret", () => {
  const k = generateInviteKey();
  assert.throws(() => signInvite({ secretHex: k.secretHex, betId: 1, invitee: "  " }), /invitee/);
  assert.throws(() => signInvite({ secretHex: k.secretHex, betId: -1, invitee: "x.testnet" }), /bet/);
  assert.throws(() => signInvite({ secretHex: "zz", betId: 1, invitee: "x.testnet" }), /secret/);
});

test("storage: secret saved under the pubkey key, found again from the bet's taker_allow; never for other keys", () => {
  const s = mem(), k = generateInviteKey(), other = generateInviteKey();
  saveInviteKey(s, k);
  assert.equal(loadInviteSecret(s, k.pubkeyHex), k.secretHex);
  assert.equal(loadInviteSecret(s, other.pubkeyHex), null);
  assert.ok(s.m.has(inviteKeyStorageKey(k.pubkeyHex)));
  assert.equal(inviteSecretForBet(s, { InvitePubkey: k.pubkeyHex }), k.secretHex);
  assert.equal(inviteSecretForBet(s, JSON.stringify({ InvitePubkey: k.pubkeyHex })), k.secretHex);
  assert.equal(inviteSecretForBet(s, { Account: "a.testnet" }), null);
  assert.equal(inviteSecretForBet(s, "Any"), null);
});

// Fixed-seed vectors, TEST-ONLY (never a real key). Library cross-check against the Rust-side ed25519 verifier
// (env::ed25519_verify = standard RFC 8032 pure Ed25519): RFC 8032 section 7.1 TEST 1 and a pinned invite vector.
test("RFC 8032 TEST 1 vector (test-only seed): tweetnacl matches standard ed25519 that the contract's verifier uses", () => {
  const seed = Uint8Array.from(Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"));
  const kp = nacl.sign.keyPair.fromSeed(seed);
  assert.equal(hex(kp.publicKey), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const sig = nacl.sign.detached(new Uint8Array(0), kp.secretKey);
  assert.equal(hex(sig), "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
});

test("pinned invite vector (test-only seed 0x07*32): signInvite output is deterministic and verifies over the contract message", () => {
  const seed = new Uint8Array(32).fill(7);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const secretHex = hex(kp.secretKey);
  const sig = signInvite({ secretHex, betId: 5, invitee: "alice.testnet" });
  assert.equal(sig, signInvite({ secretHex, betId: 5, invitee: "alice.testnet" }));
  assert.equal(nacl.sign.detached.verify(new TextEncoder().encode("praetorial:invite:v1:5:alice.testnet"), Uint8Array.from(Buffer.from(sig, "hex")), kp.publicKey), true);
  assert.equal(sig, PINNED_SIG);
});
const PINNED_SIG = "4bbd88e8b4bb0c917539f6be1d2f36ee738c6b758180713c7a13a445ff14e447c40890f6ca82c5f06de5626981ed4cc59eb6f4498adbbe091efb463527d4850f"; // independently produced with node:crypto (OpenSSL) from the same test-only seed

// ---- secret hygiene (source scan, comments stripped) ----
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
test("source scan: secret never reaches console/log, fetch bodies, URLs or the envelope", () => {
  const lib = strip(readFileSync(join(here, "../lib/inviteLink.ts"), "utf8"));
  assert.ok(!/console\.|fetch\(|XMLHttpRequest|sendBeacon|document\.cookie|sessionStorage/.test(lib), "inviteLink.ts has no logging/network/cookie");
  assert.ok(/localStorage|Storage/.test(lib) || lib.includes("getItem"), "uses storage");
  const files = ["../src/components/CreateOffer.tsx", "../src/components/BetPage.tsx", "../src/App.tsx", "../lib/escrowAdapter.ts", "../lib/openEnvelope.ts"];
  for (const f of files) {
    const t = strip(readFileSync(join(here, f), "utf8"));
    for (const line of t.split("\n")) {
      if (!/secretHex|loadInviteSecret|inviteSecretForBet|generateInviteKey/.test(line)) continue;
      assert.ok(!/console\.|fetch\(|JSON\.stringify|body\s*:|msg\b.*secret|location\.|\bargs\b/.test(line), `${f}: secret on a leaking line: ${line.trim()}`);
    }
  }
  const adapter = strip(readFileSync(join(here, "../lib/escrowAdapter.ts"), "utf8"));
  assert.ok(!/secret/i.test(adapter), "escrowAdapter never sees a secret (only the pubkey)");
  const oe = strip(readFileSync(join(here, "../lib/openEnvelope.ts"), "utf8"));
  assert.ok(!/secret/i.test(oe), "openEnvelope never sees a secret");
});
test("UI wiring: CreateOffer offers 'invite by link' and BetPage has the maker's per-invitee signer", () => {
  const co = readFileSync(join(here, "../src/components/CreateOffer.tsx"), "utf8") + readFileSync(join(here, "../src/components/BetOptions.tsx"), "utf8"); // BET1c: the block moved to BetOptions
  assert.ok(co.includes('data-testid="invite-by-link"'));
  const bp = readFileSync(join(here, "../src/components/BetPage.tsx"), "utf8");
  assert.ok(bp.includes('data-testid="invite-invitee-input"') && bp.includes('data-testid="invite-link-output"'));
  assert.ok(readdirSync(join(here, "../lib")).includes("inviteLink.ts"));
});

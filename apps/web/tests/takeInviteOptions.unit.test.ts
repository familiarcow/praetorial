// TK1: Take screen -- invite signature (taker_allow) + taker_options picker. Unit tests only; the wallet/relay are never touched.
// Contract refs (contracts/escrow/src/lib.rs handle_take): InvitePubkey(pk) verifies ed25519 over
// "praetorial:invite:v1:{bet_id}:{sender_id}" with a 64-byte hex invite_sig; Account(a) needs sender==a; a taker_options deposit
// must equal option.amount + storage_charge_per_side in option.asset; the tip is side_fee(stake, fee_bps, bet.fee_min_taker)
// on the matched stake, and fee+tip must not exceed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import nacl from "tweetnacl";
import { prepareTake, parseInviteLink, takeEligibility, takeChoices, takeTipOffer } from "../lib/takeScreen";
import { feeForSideUnits } from "../lib/escrowAdapter";

const here = dirname(fileURLToPath(import.meta.url));
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const kp = nacl.sign.keyPair();
const PK = hex(kp.publicKey);
const sign = (betId: number, taker: string, pair = kp) =>
  hex(nacl.sign.detached(new TextEncoder().encode(`praetorial:invite:v1:${betId}:${taker}`), pair.secretKey));

const USDC = "nep141:usdc.testnet";
const WBTC = "nep141:wbtc.testnet";
const bet = (over: Record<string, any> = {}, env: Record<string, any> = {}): any => ({
  status: "Open", taker: null, storage_rates: new Proxy({}, { get: () => "457" }) as any, // STG1b fixture: ceil(3136*457/2048)=700
  fee_min_taker: "500000", fee_min_taker_options: ["500"],
  envelope: {
    maker: "maker.testnet", taker_asset: USDC, stake_taker: "10000000", storage_charge_per_side: "700",
    fee_bps: 100, resolve_deadline: 1, referee: null, taker_allow: "Any",
    taker_options: [{ asset: WBTC, amount: "20000" }], ...env,
  },
  ...over,
});
const same = (b: any) => async () => b;

// ---- (1) invite ----

test("parseInviteLink: reads invite=<128 hex> from the query or the hash; anything else is null", () => {
  const sig = sign(7, "taker.testnet");
  assert.equal(parseInviteLink(`https://app.example/?bet=7&invite=${sig}`), sig);
  assert.equal(parseInviteLink(`https://app.example/#/bet/7?invite=${sig.toUpperCase()}`), sig);
  assert.equal(parseInviteLink(`?invite=${sig}`), sig);
  assert.equal(parseInviteLink("https://app.example/?bet=7"), null);
  assert.equal(parseInviteLink("https://app.example/?invite=nothex"), null);
  assert.equal(parseInviteLink(`https://app.example/?invite=${sig.slice(2)}`), null);
});

test("eligibility: Any needs no invite; msg carries invite_sig null", () => {
  assert.deepEqual(takeEligibility({ takerAllow: "Any", betId: 7, taker: "t.testnet", inviteSig: null }), { ok: true, inviteSig: null });
  assert.deepEqual(takeEligibility({ takerAllow: { Any: {} }, betId: 7, taker: null, inviteSig: null }), { ok: true, inviteSig: null });
  // indexer-style JSON string form
  assert.equal(takeEligibility({ takerAllow: '"Any"', betId: 7, taker: null, inviteSig: null }).ok, true);
});

test("eligibility: Account(a) only lets a take through when the taker IS a (no invite needed, none sent)", () => {
  const al = { Account: "friend.testnet" };
  assert.deepEqual(takeEligibility({ takerAllow: al, betId: 7, taker: "friend.testnet", inviteSig: null }), { ok: true, inviteSig: null });
  const bad = takeEligibility({ takerAllow: al, betId: 7, taker: "stranger.testnet", inviteSig: null });
  assert.ok(!bad.ok);
  if (!bad.ok) assert.match(bad.message, /friend\.testnet/);
  assert.ok(!takeEligibility({ takerAllow: al, betId: 7, taker: null, inviteSig: null }).ok);
});

test("eligibility: InvitePubkey needs a signature over praetorial:invite:v1:{bet}:{taker} by that key", () => {
  const al = { InvitePubkey: PK };
  const sig = sign(7, "t.testnet");
  assert.deepEqual(takeEligibility({ takerAllow: al, betId: 7, taker: "t.testnet", inviteSig: sig }), { ok: true, inviteSig: sig });
  const none = takeEligibility({ takerAllow: al, betId: 7, taker: "t.testnet", inviteSig: null });
  assert.ok(!none.ok);
  if (!none.ok) assert.match(none.message, /invite/i);
  // signed for someone else / another bet / by another key
  assert.ok(!takeEligibility({ takerAllow: al, betId: 7, taker: "other.testnet", inviteSig: sig }).ok);
  assert.ok(!takeEligibility({ takerAllow: al, betId: 8, taker: "t.testnet", inviteSig: sig }).ok);
  const evil = nacl.sign.keyPair();
  assert.ok(!takeEligibility({ takerAllow: al, betId: 7, taker: "t.testnet", inviteSig: sign(7, "t.testnet", evil) }).ok);
  assert.ok(!takeEligibility({ takerAllow: al, betId: 7, taker: "t.testnet", inviteSig: "zz" }).ok);
});

test("prepareTake: a valid invite is passed to the Take msg", async () => {
  const b = bet({}, { taker_allow: { InvitePubkey: PK } });
  const sig = sign(7, "t.testnet");
  const r = await prepareTake({ betId: 7, shown: b, tip: false, inviteSig: sig, takerAccount: "t.testnet", readBet: same(b) });
  assert.ok(r.ok);
  if (r.ok) assert.equal(JSON.parse(r.msg).invite_sig, sig);
});

test("prepareTake: no/invalid invite or wrong account -> clear refusal and NO msg, tokenId or amount", async () => {
  const inv = bet({}, { taker_allow: { InvitePubkey: PK } });
  const acct = bet({}, { taker_allow: { Account: "friend.testnet" } });
  for (const [b, who, sig] of [
    [inv, "t.testnet", null], [inv, "t.testnet", sign(7, "someone.testnet")], [acct, "stranger.testnet", null], [acct, null, null],
  ] as const) {
    const r = await prepareTake({ betId: 7, shown: b, tip: false, inviteSig: sig, takerAccount: who, readBet: same(b) });
    assert.ok(!r.ok);
    if (r.ok) continue;
    assert.ok(r.message.length > 10);
    assert.ok(!("msg" in r) && !("tokenId" in r) && !("amount" in r));
  }
});

test("prepareTake: eligibility is judged on the RE-READ bet (maker swapped taker_allow after page load)", async () => {
  const shown = bet();
  const now = bet({}, { taker_allow: { Account: "friend.testnet" } });
  const r = await prepareTake({ betId: 7, shown, tip: false, inviteSig: null, takerAccount: "stranger.testnet", readBet: same(now) });
  assert.ok(!r.ok);
});

// ---- (2) taker options ----

test("takeChoices: primary first, then each taker_options entry, deposit = amount + storage in THAT asset", () => {
  const cs = takeChoices(bet());
  assert.deepEqual(cs.map((c) => [c.asset, c.stake, c.deposit, c.isPrimary]), [
    [USDC, 10_000_000n, 10_000_700n, true],
    [WBTC, 20_000n, 20_700n, false],
  ]);
});

test("takeChoices: an option duplicating the primary asset is unreachable (contract matches primary first) and dropped", () => {
  const cs = takeChoices(bet({ fee_min_taker_options: ["1", "2", "3"] }, { taker_options: [{ asset: USDC, amount: "5" }, { asset: WBTC, amount: "20000" }, { asset: WBTC, amount: "30000" }] }));
  assert.deepEqual(cs.map((c) => [c.asset, c.stake]), [[USDC, 10_000_000n], [WBTC, 20_000n]]);
});

test("takeChoices: protocol-fee/tip use the OPTION's own fee_min_taker_options[i] on the OPTION stake (what the contract does)", () => {
  const b = bet({ fee_min_taker: "500", fee_min_taker_options: ["500"] }, { referee: { account: "ref.testnet", mode: "Human" } });
  const [p, o] = takeChoices(b);
  assert.equal(p.tipUnits, feeForSideUnits(10_000_000n, 500n)); // 1% = 100000
  assert.equal(o.tipUnits, feeForSideUnits(20_000n, 500n)); // 1% = 200 < min 500 -> 500
  assert.equal(o.tipUnits, 500n);
  assert.equal(o.problem, null);
});

test("takeChoices: fee+tip<=stake guard is per option (tiny option stake vs the min-fee copy)", () => {
  const b = bet({ fee_min_taker_options: ["15000"] }, { referee: { account: "ref.testnet", mode: "Human" } });
  const [p, o] = takeChoices(b);
  assert.equal(p.problem, null);
  assert.match(o.problem ?? "", /exceeds the stake/); // 2*15000 > 20000
});

test("takeTipOffer(bet, asset): tip cost for the picked option; unknown asset -> not offered", () => {
  const b = bet({ fee_min_taker: "500", fee_min_taker_options: ["500"] }, { referee: { account: "ref.testnet", mode: "Human" } });
  assert.equal(takeTipOffer(b, WBTC).tipUnits, 500n);
  assert.equal(takeTipOffer(b).tipUnits, 100_000n);
  assert.equal(takeTipOffer(b, USDC).tipUnits, 100_000n);
  assert.equal(takeTipOffer(bet(), WBTC).visible, false);
});

test("prepareTake: picking an option sends THAT asset and amount+storage; tip on the option stake", async () => {
  const b = bet({ fee_min_taker: "500", fee_min_taker_options: ["500"] }, { referee: { account: "ref.testnet", mode: "Human" } });
  const r = await prepareTake({ betId: 7, shown: b, tip: true, inviteSig: null, asset: WBTC, readBet: same(b) });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.tokenId, WBTC);
  assert.equal(r.amount, "20700");
  assert.deepEqual(JSON.parse(r.msg), { kind: "Take", bet_id: 7, invite_sig: null, tip: true, referee_ack: "ref.testnet" });
});

test("prepareTake: default (no asset) is still the primary; explicit primary same", async () => {
  const b = bet();
  const d = await prepareTake({ betId: 7, shown: b, tip: false, inviteSig: null, readBet: same(b) });
  const p = await prepareTake({ betId: 7, shown: b, tip: false, inviteSig: null, asset: USDC, readBet: same(b) });
  assert.ok(d.ok && p.ok);
  if (d.ok && p.ok) { assert.equal(d.tokenId, USDC); assert.equal(d.amount, "10000700"); assert.deepEqual(d, p); }
});

test("prepareTake: refuses an asset that is not offered, or that was removed on the re-read", async () => {
  const b = bet();
  const r1 = await prepareTake({ betId: 7, shown: b, tip: false, inviteSig: null, asset: "nep141:nope.testnet", readBet: same(b) });
  assert.ok(!r1.ok);
  const gone = bet({}, { taker_options: [] });
  const r2 = await prepareTake({ betId: 7, shown: b, tip: false, inviteSig: null, asset: WBTC, readBet: same(gone) });
  assert.ok(!r2.ok);
  if (!r2.ok) assert.match(r2.message, /no longer|not offered/i);
});

test("prepareTake: option tip violating fee+tip<=stake is refused (no msg)", async () => {
  const b = bet({ fee_min_taker_options: ["15000"] }, { referee: { account: "ref.testnet", mode: "Human" } });
  const r = await prepareTake({ betId: 7, shown: b, tip: true, inviteSig: null, asset: WBTC, readBet: same(b) });
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.message, /exceeds the stake/);
});

// ---- UI wiring + docs ----

test("BetPage wires takerAccount, the invite from the link, and an option picker into prepareTake", () => {
  const src = readFileSync(join(here, "../src/components/BetPage.tsx"), "utf8") + readFileSync(join(here, "../src/components/TakeBetModal.tsx"), "utf8"); // MODAL1c2: the take logic moved into TakeBetModal
  assert.ok(/parseInviteLink\(/.test(src));
  assert.ok(/takeChoices\(/.test(src));
  assert.ok(/takerAccount:/.test(src));
  assert.ok(/asset:\s*asset\b/.test(src));
  assert.ok(!/inviteSig:\s*null/.test(src));
  assert.ok(src.includes('"take-asset-select"'));
});

test("README no longer says the take button is disabled / pending redeploy", () => {
  const md = readFileSync(join(here, "../README.md"), "utf8");
  assert.ok(!/disabled take/i.test(md));
  assert.ok(!/take\/cancel buttons/i.test(md));
  assert.match(md, /Take/);
  assert.match(md, /invite/i);
});

// DR2 offline unit test (written BEFORE the live run): expected money per party (maker-win, taker-win, VOID/refund) from get_bet + side_fee via harness money.ts,
// the expected verifier SKIP set, the league box-score ground-truth decision, the game pick and the fresh-bettor wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expectedDecisive, expectedVoid, paidTo, winnerOf, loadFeeConfig, verifierProblems, EXPECTED_VERIFIER } from "../expected.js";
import { sideFee } from "../../harness/money.js";
import { gameTruth, espnScoreboardUrl } from "../groundTruth.js";
import { eventStartOk, MIN_LEAD_SECS } from "../games.js";
import { freshWallet } from "../wallet.js";

const cfg = loadFeeConfig();
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1;
const bet = (side: "YES" | "NO") => ({
  envelope: { maker: "m", stake_maker: STAKE.toString(), stake_taker: STAKE.toString(), fee_bps: Number(cfg.feeBps), maker_side: side, maker_asset: "w", taker_asset: "w", keep_terms: true },
  status: "Taken", taker: "t", fee_min_maker: cfg.minFeePerSide.toString(), fee_min_taker: cfg.minFeePerSide.toString(), storage_maker: "1234", storage_taker: "5678",
});

// maker is always YES in the web builder (maker backs the pick); YES = the picked team wins
test("maker-win (outcome YES, maker_side YES): maker gets both stakes minus a side_fee per side; taker 0; fee account fees + storage", () => {
  const b = bet("YES"), f = sideFee(STAKE, cfg.feeBps, cfg.minFeePerSide), s = expectedDecisive(b, "YES");
  assert.equal(winnerOf(b, "YES"), "maker");
  assert.equal(paidTo(s, "maker"), 2n * STAKE - 2n * f); assert.equal(paidTo(s, "taker"), 0n);
  assert.equal(paidTo(s, "fee"), 2n * f + 1234n + 5678n);
  assert.equal(paidTo(s, "maker") + paidTo(s, "taker") + paidTo(s, "fee"), s.deposits.maker + s.deposits.taker);
});
test("taker-win (outcome NO, maker_side YES): taker gets both stakes minus a side_fee per side; maker 0; fee account fees + storage", () => {
  const b = bet("YES"), f = sideFee(STAKE, cfg.feeBps, cfg.minFeePerSide), s = expectedDecisive(b, "NO");
  assert.equal(winnerOf(b, "NO"), "taker");
  assert.equal(paidTo(s, "taker"), 2n * STAKE - 2n * f); assert.equal(paidTo(s, "maker"), 0n);
  assert.equal(paidTo(s, "fee"), 2n * f + 1234n + 5678n);
});
test("VOID/refund: each side gets its stake back, no fee charged; storage to the fee account (keep_terms); escrow drains", () => {
  const b = bet("YES"), s = expectedVoid(b);
  assert.equal(paidTo(s, "maker"), STAKE); assert.equal(paidTo(s, "taker"), STAKE);
  assert.equal(paidTo(s, "fee"), 1234n + 5678n);
  assert.equal(paidTo(s, "maker") + paidTo(s, "taker") + paidTo(s, "fee"), s.deposits.maker + s.deposits.taker);
});

const fx = readFileSync(new URL("../../harness/fixtures/espn_scoreboard.json", import.meta.url), "utf8"); // NBA 401810039 PHI 130 TOR 120 final; 401810038 DAL away win
test("league box score ground truth: YES iff the pick won a FINAL game, NO iff the other team won", () => {
  assert.equal(gameTruth(fx, "401810039", "PHI").outcome, "YES");
  assert.equal(gameTruth(fx, "401810039", "TOR").outcome, "NO");
  const t = gameTruth(fx, "401810038", "DAL"); assert.equal(t.outcome, "YES"); assert.equal(t.final, true);
  assert.match(t.rawSha256, /^[0-9a-f]{64}$/);
});
test("league box score ground truth: not final or tie is VOID; unknown event or a pick that is not in the game is refused, never guessed", () => {
  const live = JSON.parse(fx); const ev = live.events.find((e: any) => e.id === "401810039"); ev.status.type = { ...ev.status.type, completed: false, name: "STATUS_IN_PROGRESS" };
  assert.equal(gameTruth(JSON.stringify(live), "401810039", "PHI").outcome, "VOID");
  const tie = JSON.parse(fx); for (const c of tie.events.find((e: any) => e.id === "401810039").competitions[0].competitors) c.score = "100";
  const tt = gameTruth(JSON.stringify(tie), "401810039", "PHI"); assert.equal(tt.outcome, "VOID"); assert.equal(tt.reason, "final tie");
  assert.throws(() => gameTruth(fx, "nope", "PHI"), /not found/);
  assert.throws(() => gameTruth(fx, "401810039", "LAL"), /not a team/);
});
test("ESPN url matches the resolver's source url for NBA", () => { assert.equal(espnScoreboardUrl("basketball", "nba", "20261110"), "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261110"); });

test("game pick rule: the game must start >= 1 h after open (OPEN_T_TOO_SOON analogue), scheduled_date matching the resolver's on_date check", () => {
  assert.equal(MIN_LEAD_SECS, 3600);
  const now = Date.parse("2026-11-10T21:35:00Z");
  assert.equal(eventStartOk("2026-11-11T00:30Z", now), true);
  assert.equal(eventStartOk("2026-11-10T22:34Z", now), false);
  assert.equal(eventStartOk("2026-11-10T22:36Z", now), true);
});

test("verifier SKIP set: E4 only when offline; B4 expected PASS (stays red if PARTIAL); any FAIL or other SKIP is a problem", () => {
  assert.deepEqual([...EXPECTED_VERIFIER.skipsOffline], ["E4"]); assert.deepEqual([...EXPECTED_VERIFIER.skipsOnline], []); assert.equal(EXPECTED_VERIFIER.b4, "PASS");
  const ok = "PASS B4 x\nSKIP E4 offline\n# 9 PASS, 0 FAIL, 1 SKIP";
  assert.deepEqual(verifierProblems(ok, { offline: true }), []);
  assert.deepEqual(verifierProblems(ok, { offline: false }), ["unexpected SKIP E4"]);
  assert.deepEqual(verifierProblems("SKIP B4 partial\nSKIP E4 o\n# 8 PASS, 0 FAIL, 2 SKIP", { offline: true }), ["unexpected SKIP B4"]);
  assert.deepEqual(verifierProblems("FAIL B5 x\n# 8 PASS, 1 FAIL, 0 SKIP", { offline: false }), ["1 FAIL"]);
});

test("fresh wallet: new implicit account each run; signs ed25519 over the raw hash and verifies", async () => {
  const a = freshWallet(), b = freshWallet();
  assert.match(a.address, /^[0-9a-f]{64}$/); assert.notEqual(a.address, b.address);
  const h = "ab".repeat(32), sig = a.sign(h);
  const { createPublicKey, verify } = await import("node:crypto");
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(a.address, "hex")]), format: "der", type: "spki" });
  assert.equal(verify(null, Buffer.from(h, "hex"), pub, Buffer.from(sig, "hex")), true);
});
test("harness config: DR2 targets the escrow the deployed web bundle names (main's web config), not DR1's frz2", async () => {
  const { ESCROW, WEB_ESCROW } = await import("../chain.js");
  assert.equal(ESCROW, WEB_ESCROW); assert.match(ESCROW, /^praetorial-frz3-/);
});

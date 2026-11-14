// DR3 offline unit test (written BEFORE the live run): expected money per party (YES and NO) from get_bet + side_fee via harness money.ts,
// the expected verifier SKIP set, the CLI ground-truth decision, and the fresh-bettor wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expectedDecisive, paidTo, winnerOf, loadFeeConfig, verifierProblems, EXPECTED_VERIFIER } from "../expected.js";
import { sideFee } from "../../harness/money.js";
import { splitProducts, cliTruth, nwsDirection } from "../groundTruth.js";
import { freshWallet } from "../wallet.js";

const cfg = loadFeeConfig();
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1;
const bet = (side: "YES" | "NO") => ({
  envelope: { maker: "m", stake_maker: STAKE.toString(), stake_taker: STAKE.toString(), fee_bps: Number(cfg.feeBps), maker_side: side, maker_asset: "w", taker_asset: "w", keep_terms: false },
  status: "Taken", taker: "t", fee_min_maker: cfg.minFeePerSide.toString(), fee_min_taker: cfg.minFeePerSide.toString(), storage_maker: "1234", storage_taker: "5678",
});

for (const [side, outcome] of [["YES", "YES"], ["YES", "NO"], ["NO", "YES"], ["NO", "NO"]] as const) {
  test(`maker ${side}, outcome ${outcome}: winner gets both stakes minus a side_fee per side; loser 0; fee account fees + storage; escrow drains`, () => {
    const b = bet(side), f = sideFee(STAKE, cfg.feeBps, cfg.minFeePerSide);
    const s = expectedDecisive(b, outcome);
    const w = winnerOf(b, outcome), l = w === "maker" ? "taker" : "maker";
    assert.equal(paidTo(s, w), 2n * STAKE - 2n * f);
    assert.equal(paidTo(s, l), 0n);
    assert.equal(paidTo(s, "fee"), 2n * f + 1234n + 5678n);
    assert.equal(paidTo(s, "maker") + paidTo(s, "taker") + paidTo(s, "fee"), s.deposits.maker + s.deposits.taker);
  });
}

const iem = readFileSync(new URL("../../harness/fixtures/iem_cli_nyc.txt", import.meta.url), "utf8"); // KNYC 2025-11-08 high 65
test("CLI ground truth: IEM product -> daily high -> YES/NO for every op, whole degrees, boundary inclusive only for >= / <=", () => {
  const p = splitProducts(iem);
  assert.equal(p.length, 1);
  const t = (op: string, x: number) => cliTruth(iem, "KNYC", "2025-11-08", op as never, x).outcome;
  assert.equal(t(">=", 65), "YES"); assert.equal(t(">", 65), "NO"); assert.equal(t("<=", 65), "YES"); assert.equal(t("<", 65), "NO");
  assert.equal(t(">=", 66), "NO"); assert.equal(t("<", 66), "YES");
  const r = cliTruth(iem, "KNYC", "2025-11-08", ">=", 60);
  assert.equal(r.highF, 65); assert.match(r.rawSha256, /^[0-9a-f]{64}$/); assert.equal(r.forDate, "2025-11-08");
});
test("CLI ground truth: wrong station or date is refused, never guessed", () => {
  assert.throws(() => cliTruth(iem, "KLAS", "2025-11-08", ">=", 60), /station/);
  assert.throws(() => cliTruth(iem, "KNYC", "2025-11-09", ">=", 60), /no CLI product for/);
});
test("CLI ground truth: of several issuances for the same day the LATEST wins (final over preliminary)", () => {
  const prelim = iem.replace("MAXIMUM         65", "MAXIMUM         63").replace("127 AM EST SUN NOV 09 2025", "500 PM EST SAT NOV 08 2025");
  const both = prelim + iem; // oldest first
  assert.equal(cliTruth(both, "KNYC", "2025-11-08", ">=", 64).highF, 65);
  assert.equal(cliTruth(iem + prelim, "KNYC", "2025-11-08", ">=", 64).highF, 65); // order in the text must not matter: decided by the issue time
});
test("nwsDirection maps the web op to words", () => { assert.equal(nwsDirection(">="), "at or above"); });

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

test("harness config: DR3 targets the escrow the deployed web bundle names (main's web config), not DR1's frz2", async () => {
  const { ESCROW, WEB_ESCROW } = await import("../chain.js");
  assert.equal(ESCROW, WEB_ESCROW); assert.match(ESCROW, /^praetorial-frz3-/);
});

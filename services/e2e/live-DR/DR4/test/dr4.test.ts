// DR4 offline unit test (written BEFORE the live run): expected money per party for YES, NO and VOID (get_bet + side_fee via harness
// money.ts), ground-truth decision logic (YES / NO / VOID-on-disagreement), the verifier SKIP set (none except E4 offline), tx-method guard,
// and that the messy L1 wording the spec types is ACCEPTED by the real builder gate (the same gate CreateOffer uses) with 2 distinct sites.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectedFor, paidTo, winnerOf, methodProblems, verifierSummary, ALLOWED_SKIPS, loadFeeConfig } from "../expected.js";
import { decideStaysBelow, venueFact, parseCoinbase, parseBitstamp, type VenueFact } from "../groundTruth.js";
import { formFor, windowFrom, chooseLevel, claimFor, SOURCES } from "../scenario.js";
import { sideFee } from "../../harness/money.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_LIB = path.resolve(here, "../../../../../apps/web/lib");
const cfg = loadFeeConfig();
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1;
const bet = (side: "YES" | "NO") => ({
  envelope: { maker: "m", stake_maker: STAKE.toString(), stake_taker: STAKE.toString(), fee_bps: Number(cfg.feeBps), maker_side: side, maker_asset: "w", taker_asset: "w", keep_terms: false },
  status: "Taken", taker: "t", fee_min_maker: cfg.minFeePerSide.toString(), fee_min_taker: cfg.minFeePerSide.toString(), storage_maker: "1234", storage_taker: "5678",
});

for (const side of ["YES", "NO"] as const) for (const outcome of ["YES", "NO"] as const) {
  test(`maker ${side}, outcome ${outcome}: winner gets both stakes minus a side_fee per side; fee account gets fees + storage; escrow drains`, () => {
    const b = bet(side), f = sideFee(STAKE, cfg.feeBps, cfg.minFeePerSide);
    const s = expectedFor(b, outcome);
    const w = winnerOf(b, outcome), l = w === "maker" ? "taker" : "maker";
    assert.equal(paidTo(s, w), 2n * STAKE - 2n * f);
    assert.equal(paidTo(s, l), 0n);
    assert.equal(paidTo(s, "fee"), 2n * f + 1234n + 5678n);
    assert.equal(paidTo(s, "referee"), 0n);
    assert.equal(paidTo(s, "maker") + paidTo(s, "taker") + paidTo(s, "fee"), s.deposits.maker + s.deposits.taker);
  });
}
test("VOID (sources disagree): each bettor is refunded their own stake and own storage; fee account gets nothing; escrow drains", () => {
  const s = expectedFor(bet("YES"), "VOID");
  assert.equal(paidTo(s, "maker"), STAKE + 1234n);
  assert.equal(paidTo(s, "taker"), STAKE + 5678n);
  assert.equal(paidTo(s, "fee"), 0n);
});

const meta = { url: "u", rawFile: "f", rawSha256: "0" };
const fact = (v: "Coinbase" | "Bitstamp", rows: [number, number][], x: number): VenueFact => venueFact(v, rows.map(([t, high]) => ({ t, high })), x, 1000, 1600, meta);
test("ground truth: both sites stay below -> YES; both breach -> NO; one breaches -> VOID (sources disagree); high == level is a breach; deadline exclusive", () => {
  const X = 76000;
  const calm: [number, number][] = [[1000, 75900], [1060, 75990]], hit: [number, number][] = [[1000, 75900], [1060, 76000]], late: [number, number][] = [[1600, 99999]];
  assert.equal(decideStaysBelow([fact("Coinbase", calm, X), fact("Bitstamp", calm, X)]).outcome, "YES");
  assert.equal(decideStaysBelow([fact("Coinbase", hit, X), fact("Bitstamp", hit, X)]).outcome, "NO");
  assert.equal(decideStaysBelow([fact("Coinbase", hit, X), fact("Bitstamp", calm, X)]).outcome, "VOID");
  assert.equal(decideStaysBelow([fact("Coinbase", [...calm, ...late], X), fact("Bitstamp", calm, X)]).outcome, "YES");
  assert.equal(decideStaysBelow([fact("Coinbase", calm, X), fact("Bitstamp", [], X)]).outcome, "VOID"); // no data on a site cannot decide
  assert.equal(fact("Coinbase", hit, X).firstBreachT, 1060);
  assert.equal(fact("Coinbase", hit, X).maxHigh, 76000);
});
test("parsers read the two public formats (Coinbase [t,low,high,..], Bitstamp data.ohlc)", () => {
  assert.deepEqual(parseCoinbase("[[1060,1,5,2,3,9],[1000,1,4,2,3,9]]"), [{ t: 1060, high: 5 }, { t: 1000, high: 4 }]);
  assert.deepEqual(parseBitstamp('{"data":{"ohlc":[{"timestamp":"1060","high":"7.5"}]}}'), [{ t: 1060, high: 7.5 }]);
});
test("scenario: level is above spot, window is the short future window the builder allows", () => {
  assert.equal(chooseLevel(74_000), 74_090);
  const now = Date.UTC(2026, 10, 10, 7, 0, 30);
  assert.deepEqual(windowFrom(now), { start: "2026-11-10T07:05", end: "2026-11-10T07:15", cutoff: "2026-11-10T07:17" });
});

test("the messy L1 wording is ACCEPTED by the real builder gate with 2 distinct sites; hand-cleaned wording is not what we type", async () => {
  const bc: any = await import(pathToFileURL(path.join(WEB_LIB, "customBuilder.ts")).href);
  const bg: any = await import(pathToFileURL(path.join(WEB_LIB, "builderGate.ts")).href);
  const f = formFor(74_090, windowFrom(Date.now()));
  assert.equal(f.claim, "BTC stays below $74090 for the whole session");
  assert.equal(claimFor(76123), "BTC stays below $76123 for the whole session"); // verbatim L1 examples.json range_breakout_no phrasing
  const form = { ...bc.blankCustomForm(), claim: f.claim, elements: [f.element], rule: f.rule,
    sources: f.sources.map((s) => ({ publisher: s.publisher, url: s.url, partyControlled: false, tier: s.tier, ticker: s.ticker })),
    windowStart: f.win.start, windowEnd: f.win.end, evidenceCutoff: f.win.cutoff, fallbackRule: f.fallback, earlyRule: f.early, leadingDefinitions: f.leading };
  const g = bg.builderGate(bc.sheetFromCustomForm(form));
  assert.deepEqual(g.problems, []);
  assert.equal(g.openDisabled, false);
  assert.equal(new Set(SOURCES.map((s) => new URL(s.url).hostname)).size, 2);
});

test("tx guard: AI path needs request_resolution+submit_outcome+finalize; concede/referee_rule/void_after_deadline/challenge are flagged", () => {
  assert.deepEqual(methodProblems(["mt_on_transfer", "request_resolution", "on_resolution", "submit_outcome", "finalize", "drain_payouts"]), []);
  assert.deepEqual(methodProblems(["concede", "request_resolution", "submit_outcome", "finalize"]), ["forbidden concede"]);
});
test("verifier SKIP set is empty; only E4 (offline) is tolerated", () => {
  assert.deepEqual([...ALLOWED_SKIPS], []);
  assert.deepEqual(verifierSummary("PASS A1 x\nSKIP E4 offline\n# 1 PASS, 0 FAIL, 1 SKIP").unexpectedSkips, []);
  assert.deepEqual(verifierSummary("SKIP B3 n\nSKIP E4 o\n# 1 PASS, 0 FAIL, 2 SKIP").unexpectedSkips, ["B3"]);
});
test("the live spec exists, opens through the S3 custom builder + S6 preflight on both sites, and writes ground truth before request_resolution", () => {
  const spec = fs.readFileSync(path.join(here, "../DR4.live.spec.ts"), "utf8");
  assert.match(spec, /bet-type-card-custom/);
  assert.match(spec, /check-sources-btn/);
  assert.ok(spec.indexOf("ground_truth.json") < spec.indexOf("request-result-btn\").click"), "ground truth is written before request_resolution is clicked");
  const { ESCROW } = { ESCROW: "praetorial-frz2-2611091914.praetorial-dev-1101.testnet" };
  assert.ok(ESCROW);
});

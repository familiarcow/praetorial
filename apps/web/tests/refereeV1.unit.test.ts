// RF2b (D-REFUI3a/3b/4, D-HORIZON1a, D-PARAMS1): the web speaks the contract's single `Human` referee mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenEnvelope } from "../lib/openEnvelope";
import { buildTakeMsg, buildOpenMsg } from "../lib/escrowAdapter";
import { validateReferee, refereeReviewLine, tipUnits, tipProblem, tipCostLine, refereeAckFor } from "../lib/referee";
import { DECIDER_CHOICES, pickReferee } from "../lib/refereeRegistry";
import { customOpenProblems } from "../lib/customLint";
import { validateTermSheet, blankCustomTermSheet } from "../lib/termSheet";

const here = dirname(fileURLToPath(import.meta.url));
const cases: Array<{ name: string; ts: any }> = JSON.parse(readFileSync(join(here, "../../../resolver/core/tests/fixtures/template_cases.json"), "utf8"));
const fx = (n: string) => cases.find((c) => c.name === n)!.ts;
const rs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
const NOW = Date.parse(fx("btc_close_ok").fields.open_utc);
const open = (over: Record<string, unknown> = {}): any =>
  buildOpenEnvelope({
    maker: "maker.testnet", sheet: fx("btc_close_ok"), makerAsset: "nep141:usdc.testnet", takerAsset: "nep141:usdc.testnet",
    stakeMaker: "10000000", stakeTaker: "10000000", takerAccount: null, referee: null, nowMs: NOW, ...over,
  } as any);
const REF = { account: "ref.testnet", mode: "Human" as const };

/** Field names of a Rust `pub struct`/`pub enum` variant block in lib.rs (cross-check against the contract's own definitions). */
function rustFields(header: string): string[] {
  const i = rs.indexOf(header);
  assert.ok(i >= 0, header);
  const body = rs.slice(i + header.length, rs.indexOf("\n}", i));
  return [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) => m[1]);
}

test("FE4 (UX-4/UX-17): the picker is ai | human and Witness/Source/FinalSay are gone", () => {
  assert.deepEqual(DECIDER_CHOICES.map((d) => d.kind), ["ai", "person"]);
  assert.deepEqual(pickReferee({ username: "a", account: "a.testnet" }).choice, { mode: "human", referee: "a.testnet" });
  assert.ok(!/Witness|FinalSay/.test(readFileSync(join(here, "../lib/referee.ts"), "utf8").replace(/\/\/.*$/gm, "")));
});

test("validateReferee: human needs no named taker; still rejects maker/taker and an empty pick (FE4 copy, spec S4)", () => {
  const h = (referee?: string) => ({ mode: "human" as const, referee });
  assert.deepEqual(validateReferee(h("ref.testnet"), { maker: "maker.testnet", taker: null }), []);
  assert.match(validateReferee(h("maker.testnet"), { maker: "maker.testnet", taker: null })[0], /can't pick yourself/);
  assert.match(validateReferee(h("t.testnet"), { maker: "maker.testnet", taker: "t.testnet" })[0], /cannot be the taker/);
  assert.match(validateReferee(h(" "), { maker: "maker.testnet", taker: null })[0], /Pick someone, or switch back to the AI/);
});

test("open envelope: referee {account, mode:'Human'}, tip_maker bool (default false), exact contract field set", () => {
  const e = open({ referee: REF });
  assert.deepEqual(e.referee, { account: "ref.testnet", mode: "Human" });
  assert.equal(e.tip_maker, false);
  assert.equal(open({ referee: REF, tipMaker: true }).tip_maker, true);
  assert.equal(open().referee, null);
  const contractKeys = rustFields("pub struct Envelope {").filter((k) => k !== "taker_allow"); // taker_allow is added by buildOpenMsg
  assert.deepEqual(Object.keys(e).sort(), contractKeys.sort());
  assert.deepEqual(rustFields("pub struct Referee {").sort(), Object.keys(e.referee ?? REF).sort());
});

test("open refuses: tip without a referee, and any non-Human mode", () => {
  assert.throws(() => open({ tipMaker: true }), /tip requires a referee/);
  assert.throws(() => open({ referee: { account: "r.testnet", mode: "Witness" } }), /Human/);
  assert.throws(() => open({ referee: { account: "r.testnet", mode: "FinalSay" } }), /Human/);
});

test("human mode: resolve_deadline = event + 1 year (D-HORIZON1a), AI mode unchanged (+7d)", () => {
  const T = BigInt(Date.parse(fx("btc_close_ok").fields.t_utc));
  assert.equal(BigInt(open({ referee: REF }).resolve_deadline), (T + 365n * 86_400_000n) * 1_000_000n);
  assert.equal(BigInt(open().resolve_deadline), (T + 7n * 86_400_000n) * 1_000_000n);
});

test("human mode: an event further out than 4y minus 1y is refused (cap 1461d after open)", () => {
  const sheet = JSON.parse(JSON.stringify(fx("btc_close_ok")));
  sheet.fields.t_utc = "2030-12-01T00:00:00Z";
  assert.throws(() => open({ referee: REF, sheet, nowMs: Date.parse(sheet.fields.open_utc ?? "2026-10-20T00:00:00Z") }), /OPEN_DEADLINE_TOO_FAR|4 years/);
});

test("SRCREF1c (D-PM3 option C): human mode custom sheet needs the same >=2 sources as AI mode, same function", () => {
  const sheet: any = { claim: "Did X happen?", elements: [{ id: "e1", q: "Did X happen?" }], rule: "ALL", time: { window_start: "2026-11-08T00:00:00Z", window_end: "2026-12-01T00:00:00Z", evidence_cutoff: "2026-12-01T00:00:00Z" }, clauses: [], sources: "", sources_allowed: [] };
  const ai = customOpenProblems(sheet);
  assert.ok(ai.some((p) => /independent/.test(p)));
  assert.deepEqual(customOpenProblems(sheet, { humanReferee: true }), ai);
  const ts = blankCustomTermSheet();
  assert.ok(validateTermSheet({ ...ts, sources: [] }).some((f) => /source/i.test(f)));
  assert.ok(validateTermSheet({ ...ts, sources: [] }, Date.now(), { humanReferee: true }).some((f) => /source/i.test(f)));
  assert.throws(() => open({ referee: REF, sheet: { ...sheet, claim: "Did X happen?" } }), /independent|sources/);
});

test("tip math mirrors the contract: min(stake, max(stake*bps/10000, min_fee)) on the bettor's own stake", () => {
  assert.equal(tipUnits(10_000_000n, 500_000n), 500_000n);
  assert.equal(tipUnits(100_000_000n, 500_000n), 1_000_000n);
  assert.equal(tipUnits(50_000_000n, 500_000n), 500_000n);
  assert.equal(tipUnits(300n, 500_000n), 300n);
});

test("tipProblem: protocol fee + tip must fit in the stake (contract refuses otherwise)", () => {
  assert.equal(tipProblem(10_000_000n, 500_000n), null);
  assert.equal(tipProblem(1_000_000n, 500_000n), null); // 500k + 500k == stake: allowed (<=)
  assert.match(tipProblem(900_000n, 500_000n)!, /fee \+ tip exceeds/);
});

test("review text: person decides, refund on silence, plus the tip cost", () => {
  const line = refereeReviewLine({ mode: "human", referee: "ref.testnet" }, "2027-11-02 12:00 UTC");
  assert.equal(line.startsWith("A person decides this bet. If they don't rule by 2027-11-02 12:00 UTC, you're both refunded."), true);
  assert.match(line, /ref\.testnet/);
  assert.match(refereeReviewLine({ mode: "ai" }, "x"), /AI/);
  const tip = tipCostLine({ mode: "human", referee: "ref.testnet", tipMaker: true }, { makerTip: "0.50", makerSymbol: "USDC", takerTip: "0.50", takerSymbol: "USDC" });
  assert.match(tip, /0\.50 USDC/);
  assert.match(tipCostLine({ mode: "human", referee: "ref.testnet", tipMaker: false }, { makerTip: "0.50", makerSymbol: "USDC", takerTip: "0.50", takerSymbol: "USDC" }), /no tip/i);
});

test("Take msg: exact JSON shape {kind,bet_id,invite_sig,tip,referee_ack} matching TransferMsg::Take", () => {
  assert.deepEqual(JSON.parse(buildTakeMsg(7, null, { tip: true, refereeAck: "ref.testnet" })), { kind: "Take", bet_id: 7, invite_sig: null, tip: true, referee_ack: "ref.testnet" });
  assert.deepEqual(JSON.parse(buildTakeMsg(7, "ab")), { kind: "Take", bet_id: 7, invite_sig: "ab", tip: false, referee_ack: null });
  assert.throws(() => buildTakeMsg(7, null, { tip: true }), /tip requires a referee/);
  const take = rs.slice(rs.indexOf("pub enum TransferMsg"));
  const block = take.slice(take.indexOf("Take {"), take.indexOf("},", take.indexOf("Take {")));
  const names = [...block.matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(Object.keys(JSON.parse(buildTakeMsg(1, null, { tip: false, refereeAck: null }))).filter((k) => k !== "kind").sort(), names.sort());
});

test("refereeAckFor: the taker acks exactly the envelope's referee (null when AI mode)", () => {
  assert.equal(refereeAckFor({ referee: { account: "ref.testnet", mode: "Human" } }), "ref.testnet");
  assert.equal(refereeAckFor({ referee: null }), null);
});

test("Open msg carries referee + tip_maker verbatim", () => {
  const msg = JSON.parse(buildOpenMsg(open({ referee: REF, tipMaker: true }), { checked_at: "1", signature_hex: "a".repeat(128) } as any, null));
  assert.equal(msg.envelope.tip_maker, true);
  assert.deepEqual(msg.envelope.referee, { account: "ref.testnet", mode: "Human" });
});

test("UI wiring: AI | Person picker, per-bettor tip checkbox, review tip line", () => {
  const co = readFileSync(join(here, "../src/components/CreateOffer.tsx"), "utf8") + readFileSync(join(here, "../src/components/WhoDecides.tsx"), "utf8"); // BET1c: the block moved to WhoDecides
  const rc = readFileSync(join(here, "../src/components/ReviewCard.tsx"), "utf8");
  const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
  for (const id of ["decider-ai", "decider-person", "tip-maker-checkbox"]) assert.ok(co.includes(`data-testid="${id}"`), id);
  assert.ok(!/Witness|FinalSay|Final-say/.test(co), "no old modes in CreateOffer");
  // C1: the tip line is a Full terms row built by lib/reviewCard.ts (refereeCostLine)
  assert.ok(rc.includes("review-term-${t.id}") && readFileSync(join(here, "../lib/reviewCard.ts"), "utf8").includes('add("tip"'));
  assert.ok(app.includes("tipMaker"), "App passes tipMaker to buildOpenEnvelope");
});

// V1: lib/verify.ts — the AI judge's Verify sheet, the per-action receipts, the downloadable verification file. Real testnet bet 49
// (AI ruling YES on checks 9 and 10, a challenge, paid out) with its real indexed transactions.
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Bet } from "../lib/escrowAdapter";
import type { BetTx, ChainFacts } from "../lib/betTxs";
import { betDetail } from "../lib/betDetail";
import { betView } from "../lib/betView";
import {
  judgeVerify, withReceipts, verificationFile, verifyRulingSig, outcomeMessage, storedResultJson, parseExact, personRef, exactAmount,
  explorerTx, scriptCommand, VERIFY_FORMAT, type VerifyCtx,
} from "../lib/verify";
// @ts-ignore -- plain JS module
import { buildFile, outcomeMessage as scriptMessage, runChecks } from "../../../scripts/verify-bet.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/v1/bet49-testnet.json", import.meta.url), "utf8"));
const bet = JSON.parse(fx.get_bet_text) as Bet;
const txs = fx.txs as BetTx[];
const MAKER = "979f2614c265b2dfacbde2628b66979c26afac83ba2f98f826a010aaab8eba7d";
const TAKER = "371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488";
const names = { [MAKER]: "maya", [TAKER]: "theo" };
const ctx: VerifyCtx = { network: "testnet", contractId: fx.escrow, names, feeAccount: "fee.praetorial-dev-1101.testnet", timeZone: "UTC" };
const facts: ChainFacts = {
  outcomeKey: fx.resolver_keys[0], attestKey: fx.resolver_keys[1], wasmHash: fx.resolver_keys[2], wasmBaseUrl: fx.outlayer_config.wasm_base_url,
  codeHashB58: fx.code_hash_b58, accessKeys: 0, betText: fx.get_bet_text, judgeChain: null,
};
const release = { resolverWasmHash: fx.resolver_keys[2], models: ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "z-ai/glm-5.3-flash"] };
const detail = betDetail(bet, { names, release, contractId: fx.escrow, timeZone: "UTC" });
const item = (s: ReturnType<typeof judgeVerify>, id: string) => s.sections.flatMap((x) => x.items).find((i) => i.id === id);

test("the browser's ruling check agrees with the public script, byte for byte, and catches a tampered result", () => {
  const raw = JSON.parse(bet.last_resolution_raw!);
  const r = parseExact(storedResultJson(bet.last_resolution_raw!)!);
  assert.deepEqual([...outcomeMessage(raw.contract, r)], [...scriptMessage(raw.contract, r)]);
  assert.equal(verifyRulingSig(facts.outcomeKey, raw.signing.signature_hex, raw.contract, r), true);
  assert.equal(verifyRulingSig(facts.outcomeKey, raw.signing.signature_hex, raw.contract, { ...r, outcome: "NO" }), false);
  assert.equal(verifyRulingSig(facts.attestKey, raw.signing.signature_hex, raw.contract, r), false);
});

test("the downloaded file is exactly what scripts/verify-bet.mjs builds, and the script PASSes it", () => {
  const args = { network: "testnet" as const, escrow: fx.escrow, betId: 49, betText: fx.get_bet_text, keys: fx.resolver_keys, olc: fx.outlayer_config, codeHashB58: fx.code_hash_b58, txs, models: { used: release.models }, generatedAt: "2026-11-11T12:00:00.000Z" };
  const web = verificationFile(args);
  assert.deepEqual(web, buildFile(args));
  assert.equal(web.format, VERIFY_FORMAT);
  const res = runChecks(web, null);
  assert.ok(res.every((r: any) => r.status !== "FAIL"), JSON.stringify(res));
  assert.ok(res.filter((r: any) => r.status === "PASS").length >= 3);
});

test("AI judge sheet: asked (terms + hash checked in the browser), program, where it ran, what it said, accepted by the escrow", () => {
  const s = judgeVerify({ bet, detail, txs, facts, release, ctx });
  assert.equal(s.mode, "code-audit"); // bet 49 is a typed BTC bet: code decides, the AI audits
  assert.equal(s.loading, false);
  assert.deepEqual(s.sections.map((x) => x.id), ["asked", "program", "where", "said", "accepted"]);
  assert.equal(item(s, "terms")!.value, bet.envelope.terms);
  assert.equal(item(s, "terms-hash")!.status, "ok");
  assert.ok(item(s, "audit"), "the exact audit instructions are shown");
  const w = item(s, "wasm-hash")!;
  assert.equal(w.value, fx.resolver_keys[2]); assert.equal(w.status, "ok");
  assert.equal(w.link!.href, `${fx.outlayer_config.wasm_base_url}/${fx.resolver_keys[2]}.wasm`);
  assert.equal(w.command, `curl -sL ${w.link!.href} | shasum -a 256`);
  assert.equal(item(s, "ran")!.status, "ok");
  const run = item(s, "run-tx")!;
  assert.equal(run.value, "9SbiLsizpBHSGnnragbY5Z8porbzpnZtWggaYfKPLG6j");
  assert.equal(run.link!.href, explorerTx("testnet", run.value!));
  assert.equal(run.person!.label, "@theo"); assert.equal(run.person!.account, TAKER);
  assert.equal(item(s, "outcome-key")!.value, fx.resolver_keys[0]);
  assert.match(item(s, "outcome-key")!.how, /checked once, at deploy/);
  assert.match(item(s, "tee")!.how, /OutLayer's promise: the escrow doesn't check it/);
  assert.equal(item(s, "signature")!.status, "ok");
  assert.equal(item(s, "signing-key")!.status, "ok");
  const acc = item(s, "submit")!;
  assert.equal(acc.value, "AXvXrG32NxybxRhrxCWBBVCipWG99PhvDsN8t5WqvJ7m"); assert.equal(acc.status, "ok");
  assert.equal(acc.person!.label, "Praetorial keeper");
  assert.ok(item(s, "submit-9"), "the earlier accepted check is listed too");
  assert.equal(s.aboutHref, "/docs/verification#verify"); // DOCS1: About's verify section moved to the Docs
  assert.equal(s.scriptCommand, "node verify-bet.mjs 49 --network testnet");
  assert.deepEqual(s.gaps, []);
  for (const it of s.sections.flatMap((x) => x.items)) assert.ok(it.how.length > 10, `${it.id} explains how to check it`);
});

test("AI judge sheet, honest when things are missing: no tx list, no chain read, or a key that doesn't match", () => {
  const noTx = judgeVerify({ bet, detail, txs: null, facts, release, ctx });
  assert.ok(noTx.gaps.some((g) => /transaction list/.test(g)));
  assert.equal(item(noTx, "run-tx")!.status, "missing");
  assert.equal(item(noTx, "submit")!.status, "missing");
  assert.match(item(noTx, "submit")!.link!.href, /\/address\//);
  const loading = judgeVerify({ bet, detail, txs: undefined, facts: undefined, release, ctx });
  assert.equal(loading.loading, true);
  const wrong = judgeVerify({ bet, detail, txs, facts: { ...facts, outcomeKey: facts.attestKey }, release, ctx });
  assert.equal(item(wrong, "signature")!.status, "bad");
  assert.equal(item(wrong, "signing-key")!.status, "bad");
  const otherProgram = judgeVerify({ bet, detail, txs, facts, release: { ...release, resolverWasmHash: "00".repeat(32) }, ctx });
  assert.equal(item(otherProgram, "wasm-hash")!.status, "bad");
  const tampered = judgeVerify({ bet: { ...bet, envelope: { ...bet.envelope, terms: bet.envelope.terms!.replace("74400", "74300") } }, detail, txs, facts, release, ctx });
  assert.equal(item(tampered, "terms-hash")!.status, "bad");
});

test("referee bet: the sheet shows the person (@username, id under it) and their referee_rule transaction", () => {
  const REF = "bd647fa44695487cedebee20d528d41d76739a6e0d718cfe432cb41b898851a4";
  const rb = { ...bet, last_resolution_raw: null, envelope: { ...bet.envelope, referee: { account: REF, mode: "Human" } } } as unknown as Bet;
  const rd = betDetail(rb, { names: { ...names, [REF]: "rita" }, release, contractId: fx.escrow });
  const rule: BetTx = { bet_id: 49, hash: "3BH5nqcibwvfpTjMHi8L81AiGohvGnRPzFZCmMVqVq4b", at_ns: "1794423900000000000", kind: "referee-rule", method: "referee_rule", signer: "relayer.praetorial-dev-1101.testnet", actor: REF, ok: true, moved_in: [], moved_out: [], outcome: "YES" };
  const s = judgeVerify({ bet: rb, detail: rd, txs: [rule], facts, release, ctx: { ...ctx, names: { ...names, [REF]: "rita" } } });
  assert.equal(s.mode, "referee");
  assert.equal(item(s, "referee")!.person!.label, "@rita");
  assert.equal(item(s, "referee")!.person!.account, REF);
  assert.equal(item(s, "referee-rule")!.status, "ok");
  assert.equal(item(s, "referee-rule")!.value, rule.hash);
});

test("every Activity entry gets its on-chain proof: tx -> explorer, signer, who acted, exact amounts; extra actions from the txs", () => {
  const view = betView(bet, null, Date.parse("2026-11-12T00:00:00Z"), { names, contractId: fx.escrow });
  const list = withReceipts(view.activity, txs, ctx);
  const by = (id: string) => list.find((e) => e.id === id)!;
  for (const id of view.activity.map((e) => e.id)) assert.equal(by(id).receipt.state, "found", id);
  const made = by("made").receipt.txs[0];
  assert.equal(made.actor.label, "@maya"); assert.equal(made.actor.account, MAKER);
  assert.deepEqual(made.moved, [{ dir: "in", who: { label: "@maya", account: MAKER }, amount: "20.062783 USDC" }]);
  assert.equal(made.href, explorerTx("testnet", made.hash));
  // bet 49's record keeps no bond (finalize clears bonds); CS1's betView reads challenged_by + all_results instead
  const bondRow = by("bond-1");
  assert.equal(bondRow.text, "@theo challenged the ruling.");
  assert.ok(bondRow, list.map((e) => e.text).join(" | "));
  const bond = bondRow.receipt.txs[0];
  assert.equal(bond.hash, "4N3EanAwrJ4yStku1fwovW1UeVC5aTfyHnuHyGVHjwKW");
  assert.deepEqual(bond.moved, [{ dir: "in", who: { label: "@theo", account: TAKER }, amount: "5.005 USDC" }]);
  const keeperAsks = list.find((e) => /^Praetorial keeper asked the AI for the result \(9 times\)\.$/.test(e.text));
  assert.ok(keeperAsks, "the keeper's 9 consecutive requests read as one row");
  assert.equal(keeperAsks!.receipt.txs.length, 9);
  assert.equal(bond.signer.label, "Praetorial relayer (pays the gas)"); assert.equal(bond.actor.label, "@theo");
  const paid = by("paid").receipt.txs.flatMap((t) => t.moved);
  assert.ok(paid.some((m) => m.dir === "out" && m.who.label === "@maya" && m.amount === "44 USDC"), JSON.stringify(paid));
  assert.ok(paid.some((m) => m.who.label === "Praetorial fee account"));
  assert.match(by("final").receipt.note, /^The escrow refused 7 other attempts at this/); // the keeper's early finalize tries
  const extra = list.filter((e) => e.id.startsWith("tx-"));
  assert.ok(extra.some((e) => e.text === "@theo asked the AI for the result."), extra.map((e) => e.text).join(" | "));
  assert.deepEqual(by("ruled").receipt.txs.map((t) => t.hash), ["BEZLGN6Xi76fCiYyKNQrv3izZpFJYeV3v7e8NmW1jo3J"], "check 9");
  assert.deepEqual(by("rejudged-1").receipt.txs.map((t) => t.hash), ["AXvXrG32NxybxRhrxCWBBVCipWG99PhvDsN8t5WqvJ7m"], "check 10, the second look");
  assert.ok(!extra.some((e) => e.text.startsWith("The AI ruled")), "no ruling shown twice");
  const all = list.filter((e) => e.id !== "paid").flatMap((e) => e.receipt.txs.map((t) => t.hash));
  assert.equal(new Set(all).size, all.length, "no transaction shown twice (only 'Paid out' may repeat the finalize that paid)");
  assert.deepEqual(by("paid").receipt.txs.map((t) => t.hash), ["3hJouvbQA5vQQGxX1FazaNUgRmxS3CbyGpv63CXJynaK"]);
  for (let i = 1; i < list.length; i++) if (list[i].at != null && list[i - 1].at != null) assert.ok(list[i - 1].at! <= list[i].at!);
});

test("receipts while loading or when the tx list is unavailable never invent a hash", () => {
  const view = betView(bet, null, Date.now(), { names, contractId: fx.escrow });
  for (const e of withReceipts(view.activity, undefined, ctx)) { assert.equal(e.receipt.state, "loading"); assert.deepEqual(e.receipt.txs, []); }
  const un = withReceipts(view.activity, null, ctx);
  assert.equal(un.length, view.activity.length);
  for (const e of un) { assert.equal(e.receipt.state, "unavailable"); assert.match(e.receipt.escrowHref, /testnet\.nearblocks\.io\/address\//); }
});

test("people, services and amounts in Verify views", () => {
  assert.deepEqual(personRef("keeper.praetorial.near", ctx), { label: "Praetorial keeper", account: "keeper.praetorial.near" });
  assert.deepEqual(personRef(fx.escrow, ctx), { label: "The escrow contract", account: fx.escrow });
  assert.deepEqual(personRef("nobody.testnet", ctx), { label: "Unnamed account", account: "nobody.testnet" });
  assert.equal(exactAmount("near", "20062500000000000000000"), "0.0200625 NEAR");
  assert.equal(exactAmount("nep141:weird.testnet", "5"), "5 base units of nep141:weird.testnet");
  assert.equal(scriptCommand(7, "mainnet"), "node verify-bet.mjs 7");
});

// B1 (familiarcow 2026-11-11): the bet page's Details show everything that decides a bet. Checks:
//  - the judge prompt text is the resolver's own (generated file fresh; byte-exact against Rust build_messages_at goldens)
//  - the template renderer matches Rust materialize() (goldens)
//  - each Details section renders every field present in a real bet record (testnet get_bet; mainnet has no bets yet)
//  - people are @usernames everywhere: no `.near` or 64-hex id in any rendered kit state outside Account details / raw blocks
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { betDetail, materialize, questionText, personName, type BetDetail } from "../lib/betDetail";
import { elementMessages, FIXED_SYSTEM } from "../lib/judgePrompt";
import { render as renderPromptFile, CORE, AUDIT, OUT } from "../scripts/genJudgePrompt";
import type { Bet } from "../lib/escrowAdapter";
import real1 from "./fixtures/real-bet-testnet-1.json";
import real35 from "./fixtures/real-bet-testnet-35.json";
import golden from "./fixtures/resolver-golden.json";
import { betFixtures, fixtureByKey, NAMES, LEGACY } from "./fixtures/bets";

const R = await import("./lib/kitRender");
const kit = await import("../src/kit");
const { betView } = await import("../lib/betView");

const RELEASE = { resolverWasmHash: "8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473", models: ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "z-ai/glm-5.3-flash"] };
const REAL: Array<{ name: string; bet: Bet; contract: string }> = [
  { name: "real #1 (custom, AI judge)", bet: real1.bet as unknown as Bet, contract: real1.contract_id },
  { name: "real #35 (game_winner template)", bet: real35.bet as unknown as Bet, contract: real35.contract_id },
];
/** What a person reads: tags dropped, entities decoded. */
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const has = (h: string, s: string, what: string) => assert.ok(h.includes(esc(s)) || h.includes(s), `${what}: missing ${JSON.stringify(s.slice(0, 120))}`);
const detailOf = (r: (typeof REAL)[number], names: Record<string, string> = {}): BetDetail => betDetail(r.bet, { names, release: RELEASE, contractId: r.contract, timeZone: "UTC" });

// ---------------------------------------------------------------- the prompt is the resolver's own text
test("judge prompt: lib/judgePrompt.generated.ts is fresh against the resolver's Rust source", () => {
  assert.equal(readFileSync(OUT, "utf8"), renderPromptFile(readFileSync(CORE, "utf8"), readFileSync(AUDIT, "utf8")), "stale: run `npx tsx scripts/genJudgePrompt.ts`");
});

test("judge prompt: byte-exact with Rust build_messages_at (goldens, incl. escaping, sha, as_of, unknown clauses)", () => {
  const g = golden as any;
  g.inputs.messages.forEach((c: any, i: number) => {
    const m = elementMessages(c.ts, c.element, c.sources, c.as_of === null ? null : c.as_of);
    assert.deepEqual([["system", m.system], ["user", m.user]], g.outputs.messages[i], `case ${i}`);
  });
});

test("template renderer: matches Rust materialize() for every template (goldens, incl. real bet #35)", () => {
  const g = golden as any;
  g.inputs.materialize.forEach((ts: any, i: number) => assert.deepEqual(materialize(ts), g.outputs.materialize[i], `case ${i} ${ts?.template?.id}`));
});

test("question: custom `claim`, legacy `claimText`, or the template's rendered claim; never a hash", () => {
  assert.equal(questionText((real1.bet as any).envelope.terms), "NOKEY1b rehearsal: the iana.org home page mentions the Internet Assigned Numbers Authority.");
  assert.match(questionText((real35.bet as any).envelope.terms)!, /^New York Knicks \(team id 18\) win NBA game 401909960/);
  assert.equal(questionText(JSON.stringify({ claimText: "Old shape" })), "Old shape");
  assert.equal(questionText(null), null);
  assert.equal(questionText("not json"), null);
  // the bet page header (betView) now reads real sheets
  const v = betView(real1.bet as unknown as Bet, null, Date.now(), {});
  assert.equal(v.question, "NOKEY1b rehearsal: the iana.org home page mentions the Internet Assigned Numbers Authority.");
});

// ---------------------------------------------------------------- every field of a real bet is on screen
for (const r of REAL) {
  const d = detailOf(r);
  const raw = JSON.parse(r.bet.envelope.terms!);
  const sheet = materialize(raw);
  const e: any = r.bet.envelope;
  const b: any = r.bet;

  test(`BetTerms renders every field of envelope.terms (${r.name})`, () => {
    const h = R.terms(d);
    for (const k of Object.keys(raw)) assert.ok(h.includes(`data-field="${k}"`), `terms field ${k} not rendered`);
    has(h, d.terms.question!, "question");
    has(h, r.bet.envelope.terms_hash, "terms hash");
    has(h, JSON.stringify(raw, null, 2), "raw terms JSON");
    assert.ok(h.includes("Raw terms (JSON)"));
    for (const c of sheet.clauses ?? []) assert.ok(d.terms.clauses.some((x) => x.id === c && x.text), `clause ${c} text`);
    for (const x of sheet.custom_definitions ?? []) has(h, x, "extra rule");
    for (const el of sheet.elements ?? []) has(h, el.q, "question element");
    for (const v of Object.values(sheet.time ?? {})) assert.ok(text(h).includes(new Date(v as string).toISOString().slice(0, 4)), "time window");
  });

  test(`BetSources renders every allowed source with publisher, clickable URL, role and use (${r.name})`, () => {
    const h = R.sources(d);
    assert.ok(sheet.sources_allowed.length > 0);
    for (const s of sheet.sources_allowed) {
      has(h, s.publisher, "publisher");
      assert.ok(h.includes(`href="${esc(s.url)}"`), `url ${s.url}`);
      has(h, s.id, "source id");
    }
    assert.equal((h.match(/target="_blank"/g) ?? []).length, sheet.sources_allowed.length);
    assert.equal((h.match(/rel="noopener noreferrer"/g) ?? []).length, sheet.sources_allowed.length);
    assert.equal((h.match(/Used for: /g) ?? []).length, sheet.sources_allowed.length);
  });

  test(`JudgeInfo renders the prompt, models, snapshot hash, wasm hash and tier (${r.name})`, () => {
    const h = R.judge(d);
    has(h, e.models_snapshot_hash, "models snapshot hash");
    has(h, RELEASE.resolverWasmHash, "resolver wasm hash");
    assert.ok(h.includes('data-field="tier"') && text(h).includes(String(e.tier)), "tier");
    assert.ok(h.includes('data-field="max_paid_runs"') && h.includes('data-field="runs_used"'));
    const j = JSON.parse(b.last_resolution_raw).judge;
    for (const m of j.models_requested) assert.ok(h.includes(`title="${m}"`), `model ${m}`);
    for (const p of j.judge_chain) assert.ok(text(h).includes("Backup models"), `chain ${p.model_a}`);
    if (d.judge.mode === "ai") {
      has(h, FIXED_SYSTEM, "system prompt");
      for (const el of sheet.elements) has(h, elementMessages(sheet, el, d.sources.map((s) => ({ id: s.id, publisher: s.publisher, url: s.url }))).user, `user prompt ${el.id}`);
    } else {
      assert.equal(d.judge.mode, "code-audit");
      has(h, d.judge.audit!.system, "audit system prompt");
      has(h, d.judge.audit!.user, "audit user prompt");
      assert.ok(text(h).includes("never pick the other side"));
    }
  });

  test(`RulingHistory parses last_resolution_raw fully (${r.name})`, () => {
    const h = R.ruling(d);
    const root = JSON.parse(b.last_resolution_raw);
    for (const x of b.all_results) assert.ok(h.includes(`data-run="${x.run_no}"`), `run ${x.run_no}`);
    has(h, root.result.outcome, "outcome");
    has(h, root.result.element_results_hash, "element results hash");
    for (const el of root.judge.elements) assert.ok(d.ruling.rounds.at(-1)!.elements.some((x) => x.id === el.id && x.verdict === el.verdict), `verdict ${el.id}`);
    for (const diag of root.judge.run_diagnostics) {
      assert.ok(h.includes(`data-model="${diag.model}"`), `model run ${diag.model}`);
      const a = JSON.parse(diag.content);
      if (a.quote) has(h, a.quote, "quote");
      if (a.reason) has(h, a.reason, "reasoning");
      if (a.audit) has(h, a.audit, "audit answer");
      for (const al of a.also ?? []) has(h, al.quote, "also quote");
      has(h, diag.verify_result, "verify result");
    }
    for (const n of root.notes) has(h, n, "resolver note");
    has(h, root.signing.pubkey_hex, "signing key");
    has(h, JSON.stringify(root, null, 2), "raw ruling");
    assert.ok(h.includes("Raw ruling"));
  });

  test(`MoneyDeadlines shows exact stakes, fees, storage and every deadline in local + UTC (${r.name})`, () => {
    const h = R.money(d);
    for (const k of ["stake_maker", "stake_taker", "fee", "fee_min_maker", "fee_min_taker", "storage_maker", "storage_taker"]) assert.ok(h.includes(`data-field="${k}"`), k);
    for (const k of ["created_at", "funding_deadline", "taken_at", "proposed_at", "challenge_window_end", "resolve_deadline", "settlement_period"]) assert.ok(h.includes(`data-field="${k}"`), k);
    for (const ns of [b.created_at, e.funding_deadline, b.taken_at, b.proposed_at, e.resolve_deadline]) {
      const iso = new Date(Math.floor(Number(ns) / 1e6)).toISOString();
      assert.ok(h.includes(`dateTime="${iso}"`), `deadline ${iso}`);
    }
    assert.ok(text(h).includes(`${e.fee_bps / 100}% of each stake`));
    assert.ok(text(h).includes("UTC"));
  });

  test(`AccountDetails is the one place with raw ids, each next to its name (${r.name})`, () => {
    const h = R.accounts(d, r.contract);
    has(h, e.maker, "maker id");
    has(h, b.taker, "taker id");
    has(h, r.contract, "contract id");
    assert.ok(text(h).includes(personName(e.maker, null)));
  });

  test(`DetailsCard: 7 collapsed sections with icon, title and a one-line summary (${r.name})`, () => {
    const h = R.card(d, r.contract);
    for (const s of kit.DETAIL_SECTIONS) {
      assert.ok(h.includes(`data-section="${s.id}"`), s.id);
      assert.ok(h.includes(`data-testid="details-${s.id}-summary"`), `${s.id} summary`);
    }
    assert.equal((h.match(/<details class="k-drow"[^>]* open=""/g) ?? []).length, 0, "collapsed by default");
    assert.equal((h.match(/class="k-drow__icon"/g) ?? []).length, 7);
    const all = R.card(d, r.contract, "all");
    assert.equal((all.match(/<details class="k-drow"[^>]* open=""/g) ?? []).length, 7);
  });
}

test("Sources summary reads like '2 sources · IANA, ICANN'", () => {
  assert.equal(detailOf(REAL[0]).summary.sources, "2 sources · IANA, ICANN");
  assert.equal(detailOf(REAL[1]).summary.judge, "Code reads the sources · DeepSeek V4.1 Flash audits");
});

test("ExhibitList: who, when, hash; says the file itself is not on chain", () => {
  const f = fixtureByKey(Date.UTC(2026, 10, 11, 12), "challenged");
  const d = betDetail(f.bet, { names: NAMES, timeZone: "UTC" });
  const h = R.exhibits(d.exhibits);
  assert.equal(d.exhibits.length, 1);
  assert.ok(text(h).includes("@bob"));
  has(h, f.bet.exhibits[0]!.hash, "exhibit hash");
  assert.ok(h.includes(`dateTime="${new Date(Math.floor(Number(f.bet.exhibits[0]!.submitted_at) / 1e6)).toISOString()}"`));
  assert.ok(text(h).includes("isn't stored on chain"));
  assert.ok(text(R.exhibits([])).includes("No evidence filed."));
});

test("RulingHistory: challenges show who, bond (exact) and round", () => {
  const f = fixtureByKey(Date.UTC(2026, 10, 11, 12), "challenged");
  const d = betDetail(f.bet, { names: NAMES, timeZone: "UTC" });
  const t = text(R.ruling(d));
  assert.ok(t.includes("@bob challenged in round 1 with a 2 NEAR bond; the ruling was YES."), t);
});

test("RulingHistory: a stored ruling of unknown shape is shown raw, never called a resolver error; a real error is", () => {
  const f = fixtureByKey(Date.UTC(2026, 10, 11, 12), "challenged");
  const odd = { ...f.bet, all_results: [], last_resolution_raw: JSON.stringify({ judge: { run_diagnostics: [] } }) }; // no rounds anywhere
  const d = betDetail(odd, { names: NAMES, timeZone: "UTC" });
  assert.equal(d.ruling.error, null);
  assert.equal(d.ruling.unreadable, true);
  assert.equal(d.summary.ruling, "Stored ruling can't be read · raw text inside");
  const t = text(R.ruling(d));
  assert.ok(t.includes("isn't in a shape this page can read") && !t.includes("returned an error") && !t.includes("No ruling yet"), t);
  assert.ok(R.ruling(d).includes('data-testid="ruling-raw"'));
  const bad = betDetail({ ...f.bet, last_resolution_raw: JSON.stringify({ error: "judge_api_key_missing" }) }, { names: NAMES, timeZone: "UTC" });
  assert.equal(bad.ruling.error, "judge_api_key_missing");
  assert.equal(bad.summary.ruling, "The resolver returned an error");
});

test("referee bets: 'Who decides' names the referee by @username, no AI prompt", () => {
  const f = fixtureByKey(Date.UTC(2026, 10, 11, 12), "referee-waiting");
  const d = betDetail(f.bet, { names: NAMES, timeZone: "UTC" });
  assert.equal(d.judge.mode, "referee");
  const t = text(R.card(d));
  assert.ok(t.includes("Who decides") && t.includes("@kim decides (no AI)"), t);
  const legacy = betDetail(fixtureByKey(Date.UTC(2026, 10, 11, 12), "referee-legacy").bet, { names: NAMES });
  assert.equal(legacy.judge.summary, "Unnamed account decides (no AI)");
});

// ---------------------------------------------------------------- people are @usernames everywhere (familiarcow 2026-11-11)
/** Cut every element subtree whose opening tag matches `marker` (balanced on its tag name). */
function cut(h: string, marker: RegExp): string {
  for (;;) {
    const m = marker.exec(h);
    if (!m) return h;
    const start = h.lastIndexOf("<", m.index);
    const tag = /^<(\w+)/.exec(h.slice(start))![1];
    const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
    re.lastIndex = start + 1;
    let depth = 1, end = h.length;
    for (let x = re.exec(h); x; x = re.exec(h)) {
      depth += x[0].startsWith("</") ? -1 : 1;
      if (depth === 0) { end = x.index + x[0].length; break; }
    }
    h = h.slice(0, start) + h.slice(end);
  }
}
const RAW_ID = /\.near\b|\b[0-9a-f]{64}\b/;
function rawIdsShown(h: string): string[] {
  const visible = text(cut(cut(h, /data-raw-ids="allowed"/), /data-kit="RawBlock"/));
  return visible.split(/\s+/).filter((w) => RAW_ID.test(w));
}

test("no-raw-id scan: the scanner itself catches a bare .near and a 64-hex id", () => {
  assert.deepEqual(rawIdsShown(`<p>Waiting for judge.near</p>`), ["judge.near"]);
  assert.equal(rawIdsShown(`<p>${"ab".repeat(32)}</p>`).length, 1);
  assert.equal(rawIdsShown(`<div data-raw-ids="allowed"><div>judge.near</div></div><p>ok</p>`).length, 0);
});

test("no-raw-id scan: every rendered kit state shows people as @username (raw ids only in Account details / raw blocks)", () => {
  const now = Date.UTC(2026, 10, 11, 12);
  for (const f of betFixtures(now)) {
    const v = betView(f.bet, f.me, now, { names: NAMES, pending: f.pending ?? null, shutdown: f.shutdown, contractId: "bets.praetorial.near" });
    const d = betDetail(f.bet, { names: NAMES, release: RELEASE, contractId: "bets.praetorial.near" });
    const h = R.state(f, v, d);
    assert.deepEqual(rawIdsShown(h), [], `${f.key} shows a raw account id`);
    // and the raw ids really are there, inside Account details
    assert.ok(h.includes('data-raw-ids="allowed"') && h.includes(f.bet.envelope.maker), `${f.key} account details`);
  }
  const whole = R.playground();
  assert.deepEqual(rawIdsShown(whole), [], "the /kit playground shows a raw account id");
});

test("referee states name the referee as @username in header, action card, decider chip, activity and details", () => {
  const now = Date.UTC(2026, 10, 11, 12);
  for (const key of ["referee-waiting", "referee-decided"]) {
    const f = fixtureByKey(now, key);
    const v = betView(f.bet, f.me, now, { names: NAMES, pending: f.pending ?? null, contractId: "bets.praetorial.near" });
    const d = betDetail(f.bet, { names: NAMES });
    const t = text(R.state(f, v, d));
    assert.ok(t.includes("@kim"), key);
    assert.ok(!/\bjudge\b/i.test(t.replace(/AI judge/g, "")), `${key}: a person who decides is a "referee", not a "judge"`);
  }
  const w = fixtureByKey(now, "referee-waiting");
  const vw = betView(w.bet, w.me, now, { names: NAMES, contractId: "bets.praetorial.near" });
  assert.equal(vw.sentence, "Waiting for @kim to decide.");
  const legacy = fixtureByKey(now, "referee-legacy");
  const vl = betView(legacy.bet, legacy.me, now, { names: NAMES, contractId: "bets.praetorial.near" });
  assert.equal(vl.sentence, "Waiting for Unnamed account to decide.");
  // exactly one fixture exercises the no-username fallback
  const unnamed = betFixtures(now).filter((f) => {
    const people = [f.bet.envelope.maker, f.bet.taker, f.bet.envelope.referee?.account].filter(Boolean) as string[];
    return people.some((p) => !NAMES[p]);
  });
  assert.deepEqual(unnamed.map((f) => f.key), ["referee-legacy"]);
});

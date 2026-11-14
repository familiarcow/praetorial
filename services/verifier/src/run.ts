// V1 / D-VERIFY1 verify kit: read-only checks over recorded or live evidence.
// No keys, no transactions. Message formats are imported from the services' own
// helpers (same bytes the escrow contract / resolver core verify), not re-implemented.
import { parseEscrowEvents, replayGovernance } from "../../common/src/escrowEvents.js";
import { checkParams, type ParamsEvent, type ParamsViews } from "./params.js";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { buildSubmitOutcomeMessage, buildLegacySubmitOutcomeMessage } from "../../common/src/resolverSign.js";
import { TRUNCATED_RAW, elementVerdictQ, sseContent, verifyAnswer, type SrcRec } from "./judgeport.js";
import { parseReport } from "./attest.js";
import { buildSourceCheckMessage, SOURCECHECK_FRESHNESS_WINDOW_NS } from "../../common/src/sourceCheck.js";

export type Status = "PASS" | "FAIL" | "SKIP";
export interface CheckResult { id: string; status: Status; reason: string; evidence?: Record<string, unknown> }

export interface Evidence {
  escrow: string;
  betId: number;
  /** pinned views: resolver_keys() = [outcome_pubkey, attest_pubkey, resolver_wasm_hash] */
  pins: { outcome_pubkey: string; attest_pubkey: string; resolver_wasm_hash: string };
  outlayerConfig?: Record<string, unknown>;
  /** the arguments recorded for new() (offline only; guardian/limits/fee have no view) */
  newArgs?: Record<string, any>;
  deployedCodeHash?: string;
  bet: any; // get_bet-shaped
  termsRaw?: string;
  attestation?: { specHash: string; checkedAt: string; pubkeyHex: string; signatureHex: string };
  submitted: { result: any; signatureHex: string; pubkeyHex: string; /** live: block ns of the submit_outcome receipt */ tsNs?: string }[];
  /**
   * live (L1b14 / D-RUNNO1): the run_no the escrow ASSIGNED to every request_resolution for this bet (read from the
   * input_data the escrow sent to OutLayer in that very call), refused/failed runs included. Run numbers have gaps by design:
   * a failed run's callback clears pending_run_no only, next_run_no stays advanced. Undefined = not derivable (offline evidence).
   */
  assignedRuns?: { runNo: number; tsNs: string }[];
  /** live (L1b14): the CURRENT escrow account incarnation (after the latest CreateAccount); earlier deploy/new() belong to a deleted instance. */
  incarnation?: { createdAtNs?: string; deployCodeHash?: string; newFound: boolean; staleIgnored: number };
  judge?: any;
  proposedAtNs?: string;
  finalize?: any;
  /** live: ns block timestamp of the successful finalize receipt (offline uses finalize.before.ts) */
  finalizeAtNs?: string;
  /** live: why B5 cannot be derived from receipts for this bet */
  finalizeSkipReason?: string;
  /** live: collector notes (history gaps) */
  historyNotes?: string[];
  isShutdown?: boolean;
  /** JC1x: raw escrow log lines (NEP-297 EVENT_JSON) + the new() guardian/chain, to replay governance in E1. */
  governance?: { initial: { guardian: string; chain: { model_a: string; model_b: string }[]; /** AS1: the asset ids in new()'s table */ assets?: string[] }; logs: string[]; views?: { guardian?: string; chain?: { model_a: string; model_b: string }[]; /** AS1: live asset table ids and disabled ids */ assets?: string[]; disabled_assets?: string[] } };
  /** PA1b: PA1 params views + the escrow's params event log (live: views + tx history; offline: --params-file). `newArgs` overrides ev.newArgs for the replay. */
  params?: { views: ParamsViews; events: ParamsEvent[]; newArgs?: Record<string, any> };
  /** PA1b: why the params replay could not run (shown in E2 as "not checked"). */
  paramsSkip?: string;
  /** FRZ1b: live OutLayer report-pubkey results (E4). Undefined = no live run supplied (offline). */
  e4?: { outcome?: { public_key: string; predecessor: string }; attest?: { attest_public_key: string; predecessor: string }; error?: string };
  source: string; // "offline:<dir>" | "live:<network>"
}

export interface Options {
  releaseDir?: string;
  termsPath?: string;
  wasmFile?: string;
  expectEscrowHash?: string;
  /** live: wasm bytes fetched from FastFS (set by the CLI) */
  wasmBytes?: Buffer;
  /** V1b: separately supplied judge material (never on-chain): source reader text by source id and raw NEAR AI SSE streams by sha256. */
  judgeEvidence?: { sources?: Record<string, string>; responses?: Record<string, string> };
  /** V1d: NEAR AI public attestation reports (exact response bodies; sha256 of each is recorded). Binds each signing_address to its model. */
  attestations?: { name?: string; raw: string }[];
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const ok = (id: string, reason: string, evidence?: Record<string, unknown>): CheckResult => ({ id, status: "PASS", reason, evidence });
const fail = (id: string, reason: string, evidence?: Record<string, unknown>): CheckResult => ({ id, status: "FAIL", reason, evidence });
const skip = (id: string, reason: string, evidence?: Record<string, unknown>): CheckResult => ({ id, status: "SKIP", reason, evidence });

function verifyHexSig(pubkeyHex: string, sigHex: string, msg: Uint8Array): boolean {
  try {
    if (!/^[0-9a-f]{64}$/i.test(pubkeyHex) || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
    return nacl.sign.detached.verify(msg, Buffer.from(sigHex, "hex"), Buffer.from(pubkeyHex, "hex"));
  } catch { return false; }
}

// ---------------------------------------------------------------- offline loader (services/e2e/live-run* layout)
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** Loads a recorded evidence directory in the services/e2e/live-runR3e layout. */
export function loadEvidenceDir(dir: string): Evidence {
  const res = readJson(join(dir, "results.json"));
  const raw = readJson(join(dir, "raw_resolution.txt"));
  const fin = existsSync(join(dir, "results_finalize.json")) ? readJson(join(dir, "results_finalize.json")) : undefined;
  const sc = readFileSync(join(dir, "sourcecheck.log"), "utf8");
  // checked_at is a u64 ns timestamp: take the exact digits from the text (a JS number round-trip changes them)
  const scj = JSON.parse(sc.slice(sc.indexOf("\n{") + 1));
  const bet = res.bet_after_request;
  const keys: string[] = res.recreated.views.resolver_keys;
  // JC1y: optional governance.json = { logs: string[] (the escrow's raw EVENT_JSON lines from successful receipts), views?: {...} }.
  // The initial guardian/chain/assets always come from the recorded new() args (post-JC1x ones carry judge_chain).
  const na = res.recreated.new_args;
  const govFile = existsSync(join(dir, "governance.json")) ? readJson(join(dir, "governance.json")) : undefined;
  const governance: Evidence["governance"] = na?.judge_chain && govFile
    ? { initial: { guardian: String(na.guardian), chain: na.judge_chain, assets: ((na.asset_limits ?? []) as [string, any][]).map(([id]) => id) }, logs: govFile.logs ?? [], ...(govFile.views ? { views: govFile.views } : {}) }
    : undefined;
  return {
    governance,
    escrow: readFileSync(join(dir, "escrow_name.txt"), "utf8").trim(),
    betId: res.bet_id,
    pins: { outcome_pubkey: keys[0], attest_pubkey: keys[1], resolver_wasm_hash: keys[2] },
    outlayerConfig: res.recreated.views.outlayer_config,
    newArgs: res.recreated.new_args,
    deployedCodeHash: res.recreated.wasm_sha256,
    bet,
    termsRaw: existsSync(join(dir, "terms.json")) ? readFileSync(join(dir, "terms.json"), "utf8") : undefined,
    attestation: { specHash: scj.spec_hash, checkedAt: sc.match(/"checked_at":\s*(\d+)/)![1], pubkeyHex: scj.signing.pubkey_hex, signatureHex: scj.signing.signature_hex },
    submitted: [{ result: raw.result, signatureHex: raw.signing.signature_hex, pubkeyHex: raw.signing.pubkey_hex }],
    judge: raw.judge,
    proposedAtNs: res.bet_after_submit?.proposed_at_ns !== undefined ? String(res.bet_after_submit.proposed_at_ns) : undefined,
    finalize: fin,
    source: `offline:${dir}`,
  };
}

// ---------------------------------------------------------------- checks
function releaseRecords(dir?: string): { file: string; hash: string; commit: string }[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^record-.*\.json$/.test(f)).map((f) => {
    const j = readJson(join(dir, f));
    return { file: f, hash: String(j.hash), commit: String(j.commit) };
  });
}

/** JC1x (E1): replays the guardian + judge-chain events and compares to the live views when present. */
export function governanceReplay(ev: Evidence): { problems: string[]; note: string } | null {
  if (!ev.governance) return null;
  const g = replayGovernance(ev.governance.initial, parseEscrowEvents(ev.governance.logs));
  const problems = [...g.problems];
  const v = ev.governance.views;
  if (v?.guardian !== undefined && v.guardian !== g.guardian) problems.push(`guardian view ${v.guardian} != replayed ${g.guardian}`);
  if (v?.chain && JSON.stringify(v.chain) !== JSON.stringify(g.chain)) problems.push(`judge_chain view differs from the replayed chain (${v.chain.length} vs ${g.chain.length} pairs)`);
  const sameSet = (x: string[], y: string[]) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());
  if (v?.assets && ev.governance.initial.assets && !sameSet(v.assets, g.assets)) problems.push(`asset table view (${v.assets.length} assets) differs from the replayed table (${g.assets.length} assets)`);
  if (v?.disabled_assets && !sameSet(v.disabled_assets, g.disabledAssets)) problems.push(`disabled-assets view differs from the replayed set (${v.disabled_assets.length} vs ${g.disabledAssets.length})`);
  const assetNote = ev.governance.initial.assets ? `, ${g.assets.length} asset(s)${g.disabledAssets.length ? ` (${g.disabledAssets.length} disabled)` : ""}${g.pendingAsset ? ` (pending ${g.pendingAsset.token_id})` : ""}` : "";
  return { problems, note: `governance replay: guardian ${g.guardian}${g.pendingGuardian ? ` (pending ${g.pendingGuardian})` : ""}, ${g.chain.length} judge pair(s)${assetNote}` };
}

/** JC1y: post-JC1x is decided by the evidence itself -- the recorded new() args carry judge_chain (pre-JC1x contracts have none). */
export const isPostJc1x = (ev: Evidence): boolean => ev.newArgs?.judge_chain !== undefined;

function checkE1(ev: Evidence, o: Options): CheckResult {
  if (!ev.governance && isPostJc1x(ev)) return fail("E1", "governance replay: this evidence is for a post-JC1x contract (new() carries judge_chain) but contains no governance logs, so the guardian/judge-chain/asset events cannot be replayed (not silently skipped)");
  const gov = governanceReplay(ev);
  if (gov && gov.problems.length) return fail("E1", `governance replay: ${gov.problems.join("; ")}`);
  const r = checkE1Hash(ev, o);
  return gov && r.status === "PASS" ? { ...r, reason: `${r.reason}; ${gov.note}` } : r;
}

function checkE1Hash(ev: Evidence, o: Options): CheckResult {
  if (!o.expectEscrowHash) return skip("E1", "no expected escrow build hash supplied (--expect-escrow-hash <sha256> of the reproducible build of the named commit; build command in docs/VERIFY.md)");
  if (!ev.deployedCodeHash) return skip("E1", "deployed code hash not available in this evidence");
  return ev.deployedCodeHash === o.expectEscrowHash
    ? ok("E1", `deployed code hash == expected build hash ${o.expectEscrowHash}`, { deployed: ev.deployedCodeHash })
    : fail("E1", `deployed code hash ${ev.deployedCodeHash} != expected ${o.expectEscrowHash}`);
}

function checkE2(ev: Evidence, o: Options): CheckResult {
  const recs = releaseRecords(o.releaseDir).filter((r) => r.hash === ev.pins.resolver_wasm_hash);
  const problems: string[] = [];
  if (recs.length === 0) problems.push(`pinned resolver_wasm_hash ${ev.pins.resolver_wasm_hash} matches no release record`);
  const na = ev.newArgs;
  const notes: string[] = [];
  if (na) {
    for (const k of ["outcome_pubkey", "attest_pubkey", "resolver_wasm_hash"] as const) {
      if (na[k] !== ev.pins[k]) problems.push(`${k}: pinned view ${ev.pins[k]} != new() arg ${na[k]}`);
    }
    if (ev.outlayerConfig && JSON.stringify(sortKeys(ev.outlayerConfig)) !== JSON.stringify(sortKeys(na.outlayer_config))) {
      problems.push("outlayer_config view != new() outlayer_config arg");
    }
    // limits / fee / guardian have no view: compared with the bet envelope where it carries them.
    if (ev.bet?.envelope && na.asset_limits) {
      const al = (na.asset_limits as any[]).find((x) => x[0] === ev.bet.envelope.maker_asset)?.[1];
      if (al && BigInt(ev.bet.envelope.stake_maker) > BigInt(al.max_per_side)) problems.push("stake_maker above pinned max_per_side");
      if (al && BigInt(ev.bet.envelope.stake_maker) < BigInt(al.min_per_side)) problems.push("stake_maker below pinned min_per_side");
    }
    notes.push(`new() args recorded (guardian ${na.guardian}, fee account ${na.fee_account}, limits max_rounds ${na.limits?.max_rounds}); guardian/limits/fee have no view, so these are the recorded args, not a chain read`);
  } else {
    notes.push("new() args not available: only the pinned keys/hash views were checked against the release record");
  }
  // L1b14: an account name can be deleted and recreated; only the CURRENT incarnation's deploy + new() count.
  const inc = ev.incarnation;
  if (inc) {
    if (inc.createdAtNs !== undefined && inc.deployCodeHash === undefined) problems.push("current incarnation: no DeployContract after the latest account creation");
    if (inc.deployCodeHash !== undefined && ev.deployedCodeHash !== undefined && inc.deployCodeHash !== ev.deployedCodeHash) problems.push(`current incarnation deploy code hash ${inc.deployCodeHash} != live code hash ${ev.deployedCodeHash}`);
    if (inc.deployCodeHash !== undefined && o.expectEscrowHash && inc.deployCodeHash !== o.expectEscrowHash) problems.push(`current incarnation deploy code hash ${inc.deployCodeHash} != expected ${o.expectEscrowHash}`);
    if (inc.createdAtNs !== undefined && !inc.newFound) problems.push("current incarnation: no successful new() after the latest account creation (an earlier incarnation's new() is not accepted)");
    notes.push(`current incarnation (account created ${inc.createdAtNs ?? "n/a"} ns; ${inc.staleIgnored} earlier deploy/new() of a deleted incarnation ignored)`);
  }
  if (ev.isShutdown === true) problems.push("contract is_shutdown() is true");
  // PA1b / D-PARAMS1: fee_bps and per-asset limits are guardian-adjustable, so new() is no longer the whole story.
  if (ev.params) {
    const pn = ev.params.newArgs ?? ev.newArgs;
    if (!pn) problems.push("params replay: new() args not available, cannot replay the params log");
    else {
      const pv = checkParams({ newArgs: pn, views: ev.params.views, events: ev.params.events });
      if (pv.status === "FAIL") problems.push(`params replay FAILED: ${pv.problems.join("; ")}`);
      else notes.push(`params replay: ${pv.summary}`);
    }
  } else notes.push(`params replay not checked: ${ev.paramsSkip ?? "no params views/event log supplied (offline: --params-file)"}`);
  if (problems.length) return fail("E2", problems.join("; "));
  return ok("E2", `pins match release record ${recs.map((r) => r.file).join(",")} (commit ${recs[0].commit.slice(0, 8)}); ${notes.join("; ")}`);
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

function checkE3(ev: Evidence, o: Options): CheckResult {
  let bytes = o.wasmBytes;
  if (!bytes && o.wasmFile) bytes = readFileSync(o.wasmFile);
  if (!bytes) return skip("E3", "resolver wasm bytes not available offline (pass --wasm-file <file>, or run live to fetch from FastFS via outlayer_config.wasm_base_url)");
  const h = sha256(bytes);
  return h === ev.pins.resolver_wasm_hash
    ? ok("E3", `resolver wasm (${bytes.length} bytes) hashes to the pinned resolver_wasm_hash ${h}`)
    : fail("E3", `resolver wasm hashes to ${h}, pinned ${ev.pins.resolver_wasm_hash}`);
}

function checkB1(ev: Evidence, o: Options): CheckResult {
  const raw = o.termsPath ? readFileSync(o.termsPath, "utf8") : ev.termsRaw;
  if (raw === undefined) return skip("B1", "terms not available (pass --terms terms.json)");
  const h = sha256(raw);
  const want = ev.bet.envelope.terms_hash;
  return h === want ? ok("B1", `sha256(terms) == envelope.terms_hash ${h}`) : fail("B1", `sha256(terms)=${h} != envelope.terms_hash ${want}`);
}

function checkB2(ev: Evidence): CheckResult {
  const a = ev.attestation;
  if (!a) return skip("B2", "sourcecheck attestation not available in this evidence");
  const problems: string[] = [];
  if (a.pubkeyHex !== ev.pins.attest_pubkey) problems.push(`attestation pubkey ${a.pubkeyHex} != pinned attest_pubkey ${ev.pins.attest_pubkey}`);
  if (a.specHash !== ev.bet.envelope.terms_hash) problems.push("attestation spec_hash != envelope.terms_hash");
  const msg = Buffer.from(buildSourceCheckMessage(a.specHash, a.checkedAt), "utf8");
  if (!verifyHexSig(ev.pins.attest_pubkey, a.signatureHex, msg)) problems.push("ed25519 signature invalid under the pinned attest_pubkey");
  const openNs = BigInt(ev.bet.created_at ?? 0);
  const checked = BigInt(a.checkedAt);
  if (checked > openNs) problems.push("checked_at is after the bet was opened");
  else if (openNs - checked > SOURCECHECK_FRESHNESS_WINDOW_NS) problems.push(`attestation stale at open: ${(openNs - checked) / 1_000_000_000n}s > 3600s`);
  if (problems.length) return fail("B2", problems.join("; "));
  return ok("B2", `attestation signature valid under pinned attest_pubkey; ${(openNs - checked) / 1_000_000_000n}s old when the bet was opened (limit 3600s)`);
}

export function checkB3(ev: Evidence): CheckResult {
  if (ev.submitted.length === 0) return skip("B3", "no submitted results in this evidence");
  const problems: string[] = [];
  const legacyRuns: unknown[] = [];
  const pairs: string[] = [];
  let expectRun = 1;
  const assigned = ev.assignedRuns && ev.assignedRuns.length > 0 ? ev.assignedRuns : undefined;
  const sorted = [...ev.submitted];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const r = { ...s.result, checked_until: String(s.result.checked_until ?? 0) };
    if (i > 0 && Number(sorted[i - 1].result.run_no) > Number(r.run_no)) problems.push("results not in run_no order");
    if (assigned) {
      // L1b14 / D-RUNNO1: gaps are legal (refused/failed runs consumed run_nos); order, replay and provenance are not negotiable.
      const n = Number(r.run_no);
      if (i > 0 && n < expectRun) problems.push(`run_no ${r.run_no} out of order (expected ${expectRun}); a run_no may be submitted once (replay)`);
      if (!assigned.some((a) => a.runNo === n)) problems.push(`run_no ${r.run_no} was never assigned by the escrow to a request_resolution for this bet (assigned: ${assigned.map((a) => a.runNo).join(",") || "none"})`);
      else if (s.tsNs !== undefined) {
        const pending = [...assigned].reverse().find((a) => BigInt(a.tsNs) <= BigInt(s.tsNs!));
        if (pending && pending.runNo !== n) problems.push(`run_no ${r.run_no} submitted but the latest assigned run_no ${pending.runNo} was the pending one; the contract only accepts the pending assigned run_no`);
      }
    } else if (Number(r.run_no) !== expectRun) problems.push(`run_no ${r.run_no} out of order (expected ${expectRun})`);
    expectRun = Number(r.run_no) + 1;
    if (r.terms_hash !== ev.bet.envelope.terms_hash) problems.push(`run ${r.run_no}: terms_hash != envelope.terms_hash`);
    if (Number(r.bet_id) !== Number(ev.betId)) problems.push(`run ${r.run_no}: bet_id mismatch`);
    if (s.pubkeyHex !== ev.pins.outcome_pubkey) problems.push(`run ${r.run_no}: declared signer ${s.pubkeyHex} != pinned outcome_pubkey`);
    // JC1s: versioned verification. A record that carries judge_pair_index was signed with the index in the buffer; a record
    // without it predates JC1s and is verified under the old layout (old recorded evidence stays verifiable, unedited).
    const hasIdx = s.result.judge_pair_index !== undefined && s.result.judge_pair_index !== null;
    if (!hasIdx) legacyRuns.push(r.run_no);
    else pairs.push(`run ${r.run_no} judge pair ${s.result.judge_pair_index}`);
    const msg = hasIdx ? buildSubmitOutcomeMessage(ev.escrow, r) : buildLegacySubmitOutcomeMessage(ev.escrow, r);
    if (!verifyHexSig(ev.pins.outcome_pubkey, s.signatureHex, msg)) problems.push(`run ${r.run_no}: ed25519 signature invalid under the pinned outcome_pubkey (message = escrow ++ bet ++ terms_hash ++ outcome ++ element_results_hash ++ run_no ++ checked_until${hasIdx ? " ++ judge_pair_index" : ", pre-JC1s layout"} [++ next_check_ns for RETRY])`);
  }
  if (problems.length) return fail("B3", problems.join("; "));
  const runs = sorted.map((s) => s.result.run_no).join(",");
  const order = assigned
    ? `run_no ${runs} each equal to the run_no the escrow assigned (assigned ${assigned.map((a) => a.runNo).join(",")}; ${assigned.length - sorted.length} assigned run(s) delivered no signed result, so run_no gaps are expected, D-RUNNO1), strictly increasing, none replayed`
    : `run_no order 1..${sorted.length}`;
  return ok("B3", `${sorted.length} submitted result(s): ed25519 valid under pinned outcome_pubkey, ${order}, terms_hash matches; outcome ${sorted[sorted.length - 1].result.outcome}${pairs.length ? `; ${pairs.join(", ")} (index signed)` : ""}${legacyRuns.length ? `; run(s) ${legacyRuns.join(",")} signed under the pre-JC1s layout (no judge pair recorded)` : ""}`);
}

/** Port of resolver/core `decide` (verdicts only, same precedence). */
export function decide(rule: string, verdicts: string[]): string {
  if (verdicts.includes("conflict")) return "VOID";
  const v = verdicts.map((x) => (x === "not_proven" ? "not_met" : x));
  if (rule === "ALL" && v.includes("not_met")) return "NO";
  if (rule === "ANY" && v.includes("met")) return "YES";
  if (v.includes("unresolved") || v.includes("insufficient")) return "ESCALATE";
  if (rule === "ALL") return v.every((x) => x === "met") ? "YES" : "NO";
  return v.includes("met") ? "YES" : "NO";
}

/**
 * B4 (V1b / D-VER2). Re-does, offline, what the resolver did to a model answer:
 *  1. decision rule re-applied to the recorded element verdicts == signed outcome (ESCALATE maps to VOID like the resolver);
 *  2. each NEAR AI ed25519 signature re-verified from the recorded signature_proof with the resolver's own algorithm
 *     (signed text contains sha256(stream) AND ed25519(signing_address, signature, text));
 *  3. each recorded answer text hashes to raw_sha256 / content_sha256; with the raw stream supplied, sha256(stream) == the
 *     signed response_sha256 and the stream's content == the recorded answer (answer <-> signature binding);
 *  4. with source text supplied: sha256(text) == the recorded per-source sha256, and every quote occurs in it under the J4
 *     normalisation (judgeport.ts == core quote_in);
 *  5. element verdicts re-derived from the answers with the origin rule (D-ORIGIN1 / D-EXH1) and compared to the record.
 *  6. (V1d) every signer whose signature verified is bound to NEAR AI's attestation report: a supplied report must attest the SAME
 *     model (model_attestations[].model) AND list the recorded signing_address (gateway_attestation.signing_address). The TDX/GPU
 *     quote chain inside the report is NOT verified. No report for a signer -> SKIP naming it; report present but model/signer
 *     mismatch -> FAIL.
 * PASS only when all of that ran and held. FAIL on any mismatch. SKIP (naming the material) only when optional input is absent.
 */
export function checkB4(ev: Evidence, o: Options): CheckResult {
  const j = ev.judge;
  if (!j) return skip("B4", "judge record (last_resolution_raw) not available");
  const problems: string[] = [];
  const done: string[] = [];
  const missing: string[] = [];
  const je = o.judgeEvidence;
  const rawTerms = o.termsPath ? readFileSync(o.termsPath, "utf8") : ev.termsRaw;
  const signed = ev.submitted[ev.submitted.length - 1]?.result.outcome;
  const decideSigned = (verdicts: string[]): string | undefined => {
    if (rawTerms === undefined) return undefined;
    const out = decide(JSON.parse(rawTerms).rule, verdicts);
    return out === "ESCALATE" ? "VOID" : out; // resolver map_decision_outcome
  };
  if (rawTerms !== undefined) {
    const out = decideSigned((j.elements ?? []).map((e: any) => e.verdict));
    if (out !== signed) problems.push(`decision rule re-applied gives ${out}, signed outcome is ${signed}`);
    else done.push(`decision rule re-applied gives ${out} == signed outcome`);
  }
  const diags: any[] = j.run_diagnostics ?? [];
  let sigOk = 0, sigNoProof = 0, streamOk = 0, streamMissing = 0;
  const signers = new Map<string, { model: string; addr: string }>(); // signature-verified (model, signing_address) pairs
  const byHash = new Map<string, string>(); // sha256(answer string the judge scored) -> that string
  for (const raw of ["", TRUNCATED_RAW]) byHash.set(sha256(raw), raw);
  for (const d of diags) {
    if (d.verify_result === "answer" && d.signature_verified !== true) problems.push(`${d.model}: NEAR AI signature_verified is not true`);
    const head: string = d.content_head ?? "";
    if (Buffer.byteLength(head, "utf8") === d.content_len) {
      if (sha256(head) !== d.content_sha256) problems.push(`${d.model}: content_sha256 does not match the recorded answer text (altered quote?)`);
      else done.push(`${d.model}: answer text matches content_sha256`);
    }
    if (typeof d.content === "string" && d.content_complete === true && typeof d.raw_sha256 === "string") {
      if (sha256(d.content) !== d.raw_sha256) problems.push(`${d.model}: recorded answer text does not match raw_sha256`);
      else byHash.set(d.raw_sha256, d.content);
    }
    const p = d.signature_proof;
    if (d.verify_result === "answer" && !p) { sigNoProof++; continue; }
    if (!p) continue;
    const good = p.signing_algo === "ed25519" && typeof p.text === "string" && typeof p.response_sha256 === "string" &&
      p.text.split(":").includes(p.response_sha256) && verifyHexSig(String(p.signing_address), String(p.signature), Buffer.from(p.text, "utf8"));
    if (!good) { problems.push(`${d.model}: NEAR AI ed25519 signature does not verify (signature, signed text and stream hash re-checked offline)`); continue; }
    sigOk++;
    signers.set(`${d.model}\n${String(p.signing_address).toLowerCase()}`, { model: String(d.model), addr: String(p.signing_address).toLowerCase() });
    const stream = je?.responses?.[p.response_sha256];
    if (stream === undefined) { streamMissing++; continue; }
    if (sha256(stream) !== p.response_sha256) { problems.push(`${d.model}: supplied raw stream sha256 is not the signed response_sha256`); continue; }
    const content = sseContent(stream);
    if (typeof d.raw_sha256 === "string" && sha256(content) !== d.raw_sha256) { problems.push(`${d.model}: raw stream content does not match the recorded answer (raw_sha256)`); continue; }
    byHash.set(sha256(content), content);
    streamOk++;
  }
  if (sigOk) done.push(`${sigOk} NEAR AI ed25519 signature(s) re-verified offline from the recorded signature_proof`);
  if (streamOk) done.push(`${streamOk} raw stream(s) hash to the signed response_sha256 and carry the recorded answer`);
  if (diags.some((d) => d.verify_result === "answer") && sigNoProof) {
    missing.push(`judge.run_diagnostics[].signature_proof for ${sigNoProof} answer(s) (NEAR AI signature cannot be re-verified; recorded by resolvers newer than the V1b change, this evidence is from an older resolver)`);
  }
  if (sigOk && streamMissing) missing.push(`raw NEAR AI stream for ${streamMissing} answer(s) (binds the answer text to the signature) -- supply judge_evidence.json {responses}`);

  // V1d: bind every verified signer to NEAR AI's public attestation report
  const reports: { name: string; sha256: string; models: string[]; signers: string[] }[] = [];
  for (const a of o.attestations ?? []) {
    const name = a.name ?? "attestation";
    const pr = parseReport(a.raw);
    if (typeof pr === "string") { problems.push(`attestation report ${name} is not a NEAR AI attestation report (${pr})`); continue; }
    reports.push({ name, sha256: sha256(a.raw), models: pr.models, signers: pr.signers });
  }
  const bound: { model: string; signing_address: string; report_sha256: string }[] = [];
  const unbound: string[] = [];
  for (const { model, addr } of signers.values()) {
    const forModel = reports.filter((r) => r.models.includes(model));
    const hit = forModel.find((r) => r.signers.includes(addr));
    if (hit) { bound.push({ model, signing_address: addr, report_sha256: hit.sha256 }); continue; }
    if (forModel.length) { problems.push(`${model}: signer ${addr} is not listed (gateway_attestation.signing_address) by the attestation report for that model (report sha256 ${forModel.map((r) => r.sha256.slice(0, 16)).join(",")}) -- unknown signer, not bound`); continue; }
    const wrong = reports.find((r) => r.signers.includes(addr));
    if (wrong) { problems.push(`${model}: signer ${addr} appears in an attestation report for a different model (${wrong.models.join(",")}, report sha256 ${wrong.sha256.slice(0, 16)}) -- model mismatch, not bound`); continue; }
    unbound.push(`${model} signer ${addr}`);
  }
  if (bound.length) done.push(`${bound.length} NEAR AI signer(s) bound to the public attestation report (${bound.map((b) => `${b.model} signer ${b.signing_address.slice(0, 12)}...`).join(", ")}: same model, signing_address listed; report sha256 ${[...new Set(bound.map((b) => b.report_sha256))].map((h) => h.slice(0, 16)).join(",")}); the TDX/GPU quote chain was NOT verified`);
  if (unbound.length) missing.push(`attestation report for ${unbound.join("; ")} (signer not bound to NEAR AI; supply --attestation <report.json> or run live)`);
  const attEvidence = { attestation_reports: reports.map((r) => ({ name: r.name, sha256: r.sha256, model: r.models.join(","), signing_address: r.signers.join(",") })), bound };

  const sources: any[] | undefined = j.sources;
  const textOf = (id: string): string | undefined => je?.sources?.[id];
  if (!sources) missing.push("judge.sources (per-source sha256 of the reader text; older resolver, the quote-in-source check has nothing to bind to)");
  else {
    let checked = 0;
    for (const s of sources) {
      const t = textOf(s.id);
      if (t === undefined) continue;
      if (sha256(t) !== s.sha256) problems.push(`${s.id}: supplied source text sha256 ${sha256(t).slice(0, 12)}... != recorded ${String(s.sha256).slice(0, 12)}...`);
      else checked++;
    }
    if (checked) done.push(`${checked} source text(s) match their recorded sha256`);
  }

  // element verdicts re-derived from the answers (needs per-element answers + sources)
  const ee: any[] | undefined = j.element_evidence;
  if (!ee) missing.push("judge.element_evidence (which answers fed each verdict and the corroboration rule; older resolver)");
  if (ee && sources && !problems.length) {
    const srcRecs = sources as SrcRec[];
    const unchecked = new Set<string>();
    let reCounted = 0, quotes = 0;
    const rules: string[] = [];
    for (const e of ee) {
      const answerNotes: string[] = [];
      const results: [string, string | null][] = [];
      let complete = true;
      for (const h of e.answers ?? []) {
        const raw = byHash.get(h);
        if (raw === undefined) { complete = false; missing.push(`answer text for element ${e.id} (recorded answer longer than the bounded copy and no raw stream supplied)`); break; }
        const v = verifyAnswer(raw, srcRecs, textOf);
        if (!v.quoteChecked) for (const s of srcRecs) if (textOf(s.id) === undefined) unchecked.add(s.id);
        quotes += v.quotes;
        if (v.result === "invalid" || v.result === "empty") answerNotes.push(`${e.id}: answer ${v.result} on re-check (${v.reason})`);
        results.push([v.result, v.ids]);
      }
      if (!complete) continue;
      const verdict = elementVerdictQ(results, srcRecs, e.rule !== "curated");
      const rec = (j.elements ?? []).find((x: any) => x.id === e.id)?.verdict;
      if (verdict !== rec) problems.push(`element ${e.id}: verdict re-derived from the recorded answers (${e.rule}) is ${verdict}, record says ${rec}${answerNotes.length ? ` [${answerNotes.join("; ")}]` : ""}`);
      else { reCounted++; if (!rules.includes(e.rule)) rules.push(e.rule); }
    }
    if (reCounted) done.push(`${reCounted} element verdict(s) re-derived from the answers under ${rules.join("/")} == recorded`);
    if (quotes) done.push(`${quotes} quote(s) found in their source text under the J4 normalisation (formatting-insensitive, numbers kept apart)`);
    if (unchecked.size) missing.push(`source text for ${[...unchecked].sort().join(",")} (quote-in-source check not run; supply judge_evidence.json {sources}) -- the schema/origin/quorum rules WERE re-applied`);
  }

  if (problems.length) return fail("B4", problems.join("; "), attEvidence);
  if (missing.length) return skip("B4", `PARTIAL, not a full pass: ${done.join("; ") || "nothing re-checked"}. NOT re-verified: ${missing.join("; ")}`, attEvidence);
  return ok("B4", `FULL: ${done.join("; ")}`, attEvidence);
}

const U = (x: unknown) => BigInt(String(x));

function checkB5(ev: Evidence): CheckResult {
  const f = ev.finalize;
  if (ev.finalizeSkipReason) return skip("B5", ev.finalizeSkipReason);
  if (!f?.before?.balances || !f?.after?.balances) return skip("B5", `finalize before/after balances not available in this evidence${ev.historyNotes?.length ? ` (${ev.historyNotes.join("; ")})` : ""}`);
  const e = ev.bet.envelope;
  const outcome = f.after.outcome;
  const problems: string[] = [];
  if (outcome !== "YES" && outcome !== "NO") return skip("B5", `outcome ${outcome}: only YES/NO payout arithmetic is checked`);
  if (f.after.status !== "Settled") problems.push(`status after finalize is ${f.after.status}, not Settled`);
  const makerWins = e.maker_side === outcome;
  const pot = U(e.stake_maker) + U(e.stake_taker);
  // D-FEEMIN1: each side pays min(stake, max(stake*fee_bps/10000, that asset's min_fee_per_side)).
  // Pre-G5F evidence has no min_fee_per_side in the recorded new() args -> minimum 0 (plain bps).
  const minFeeFor = (asset: string): bigint => {
    const al = ((ev.newArgs?.asset_limits as any[]) ?? []).find((x) => x[0] === asset)?.[1];
    return al?.min_fee_per_side ? BigInt(al.min_fee_per_side) : 0n;
  };
  const sideFee = (stake: bigint, asset: string): bigint => {
    const pct = (stake * BigInt(e.fee_bps)) / 10000n;
    const f = pct > minFeeFor(asset) ? pct : minFeeFor(asset);
    return f < stake ? f : stake;
  };
  const fee = sideFee(U(e.stake_maker), e.maker_asset) + sideFee(U(e.stake_taker), e.taker_asset);
  // STG1 (D-STORAGE1): the bet stores each side's charge (own asset); B5 is a same-asset check so they add up.
  // Evidence recorded before STG1 has no storage_maker/taker and carries the flat envelope charge per side.
  const storage = ev.bet.storage_maker !== undefined || ev.bet.storage_taker !== undefined
    ? U(ev.bet.storage_maker ?? "0") + U(ev.bet.storage_taker ?? "0")
    : U(e.storage_charge_per_side) * 2n;
  const d = (k: string) => U(f.after.balances[k]) - U(f.before.balances[k]);
  const win = makerWins ? "maker" : "taker";
  const lose = makerWins ? "taker" : "maker";
  if (d(win) !== pot - fee) problems.push(`winner (${win}) delta ${d(win)} != pot ${pot} - fee ${fee}`);
  if (d(lose) !== 0n) problems.push(`loser (${lose}) delta ${d(lose)} != 0`);
  if (d("fee") !== fee + storage) problems.push(`fee account delta ${d("fee")} != fee ${fee} + storage ${storage}`);
  if (d("escrow") !== -(pot + storage)) problems.push(`escrow delta ${d("escrow")} != -(pot ${pot} + storage ${storage})`);
  if (U(f.after.balances.escrow) !== 0n) problems.push(`escrow residue ${f.after.balances.escrow} != 0`);
  if (f.after.pending_not_done !== 0) problems.push(`pending payouts ${f.after.pending_not_done} != 0`);
  if (problems.length) return fail("B5", problems.join("; "));
  return ok("B5", `winner ${win} +${pot - fee} (pot ${pot} - fee ${fee}); fee account +${fee + storage} (fee + ${storage} storage); loser 0; escrow residue 0; pending 0 (${f.derived === "receipts" ? "derived from the escrow's tx receipts: accepted Open/Take deposits in, mt_transfer payouts out, pending_payouts view" : "from recorded before/after balance views, not tx receipts"})`);
}

function checkB6(ev: Evidence): CheckResult {
  const e = ev.bet.envelope;
  const problems: string[] = [];
  const fd = BigInt(e.funding_deadline);
  const rd = BigInt(e.resolve_deadline);
  const sp = BigInt(e.settlement_period);
  if (ev.bet.taken_at != null && BigInt(ev.bet.taken_at) > fd) problems.push("taken after funding_deadline");
  if (!ev.proposedAtNs) return skip("B6", "proposed_at not available in this evidence");
  const pa = BigInt(ev.proposedAtNs);
  if (pa < fd) problems.push("outcome proposed before funding_deadline");
  if (pa >= rd) problems.push("outcome proposed after resolve_deadline");
  const nb = pa + sp;
  const finTs = ev.finalizeAtNs ? new Date(Number(BigInt(ev.finalizeAtNs) / 1_000_000n)).toISOString() : ev.finalize?.before?.ts;
  if (finTs) {
    const fin = ev.finalizeAtNs ? BigInt(ev.finalizeAtNs) : BigInt(Date.parse(finTs)) * 1_000_000n;
    if (fin < nb) problems.push(`finalize at ${finTs} is before proposed_at + settlement_period (${new Date(Number(nb / 1_000_000n)).toISOString()})`);
  }
  if (problems.length) return fail("B6", problems.join("; "));
  return ok("B6", `taken before funding_deadline; proposed after it; settlement window ${sp / 1_000_000_000n}s ends ${new Date(Number(nb / 1_000_000n)).toISOString()}${finTs ? `; finalize at ${finTs} is after it` : "; finalize time not in evidence"}`);
}

function checkE4(ev: Evidence): CheckResult {
  const e = ev.e4;
  if (!e) return skip("E4", "offline: no live report-pubkey run supplied (run live without --offline; needs OutLayer homes logged in as the escrow and the attest signer, spends OutLayer credit); see docs/VERIFY.md");
  if (e.error) return fail("E4", `live report-pubkey run failed: ${e.error}`);
  const problems: string[] = [];
  if (!e.outcome) problems.push("outcome pubkey not reproduced");
  else {
    if (e.outcome.predecessor !== ev.escrow) problems.push(`outcome key was derived for predecessor ${e.outcome.predecessor}, not the escrow ${ev.escrow}`);
    if (e.outcome.public_key.toLowerCase() !== ev.pins.outcome_pubkey.toLowerCase()) problems.push(`outcome pubkey ${e.outcome.public_key} != bound ${ev.pins.outcome_pubkey}`);
  }
  if (!e.attest) problems.push("attest pubkey not reproduced");
  else if (e.attest.attest_public_key.toLowerCase() !== ev.pins.attest_pubkey.toLowerCase()) problems.push(`attest pubkey ${e.attest.attest_public_key} != bound ${ev.pins.attest_pubkey}`);
  if (problems.length) return fail("E4", problems.join("; "));
  return ok("E4", `live report-pubkey of the pinned wasm reproduces the bound outcome pubkey (predecessor ${ev.escrow}) and attest pubkey (predecessor ${e.attest!.predecessor})`);
}

export function runBetChecks(ev: Evidence, o: Options = {}): CheckResult[] {
  return [checkE1(ev, o), checkE2(ev, o), checkE3(ev, o), checkE4(ev), checkB1(ev, o), checkB2(ev), checkB3(ev), checkB4(ev, o), checkB5(ev), checkB6(ev)];
}
/** verify-escrow has no bet: run only the escrow-level checks (E1-E4). */
export function runEscrowChecks(ev: Evidence, o: Options = {}): CheckResult[] {
  return [checkE1(ev, o), checkE2(ev, o), checkE3(ev, o), checkE4(ev)];
}
export { quoteKey, quoteIn, elementVerdictQ } from "./judgeport.js";

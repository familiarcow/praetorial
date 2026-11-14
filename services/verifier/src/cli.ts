// verify-bet / verify-escrow CLI. Read-only: public RPC / FastFS / recorded evidence only; no keys, no txs.
import { readFileSync } from "node:fs";
import { fetchAttestation } from "./attest.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBetChecks, runEscrowChecks, loadEvidenceDir, type CheckResult, type Options } from "./run.js";
import { extractParamsEvents, parseBigJson } from "./params.js";
import { collectE4, cliRunner } from "./e4.js";
import { collectLive, fetchResolverWasm, indexerUrl } from "./live.js";

const here = dirname(fileURLToPath(import.meta.url));
const USAGE = `usage:
  verify-bet --network testnet|mainnet --escrow <acct> --bet <id> [--terms terms.json] [--wasm-file f] [--expect-escrow-hash h] [--evidence-dir dir] [--judge-evidence judge_evidence.json] [--attestation report.json[,report2.json]]
  verify-escrow --network testnet|mainnet --escrow <acct> [--wasm-file f] [--expect-escrow-hash h]
  --judge-evidence <file>: optional {sources:{id:text}, responses:{sha256:raw NEAR AI stream}} so B4 can check quotes and bind answers to signatures.
  --attestation <files>: NEAR AI public attestation report(s) (GET https://cloud-api.near.ai/v1/attestation/report?model=<m>&signing_address=<a>, keyless) so B4 can bind each signing_address to its model. Live mode fetches them itself when the flag is absent; offline mode never does. Without a report B4 is SKIP, never PASS.
  --params-file <f>: recorded PA1 params input {new_args?, receipts:[{block_timestamp, ok, logs, tx_hash?}], views:{protocol_fee_bps, asset_limit:{<asset>:<AssetLimit>}, pending_params_raw|pending_params}} for the E2 params replay (offline evidence has no chain; also overrides the live fetch). new_args, if present, replaces the evidence's new() args for the replay.
  --outlayer-home-escrow <dir> --outlayer-home-attest <dir> [--outlayer-bin <path>]: live E4 (FRZ1b): OutLayer CLI homes logged in as the escrow and as the attest signer; the pinned wasm is run in report-pubkey mode and both pubkeys must equal the bound ones (spends OutLayer credit). Also env PRAETORIAL_OL_HOME_ESCROW / _ATTEST / OUTLAYER_BIN. Live without them: E4 FAILs.
  --offline: live E4 is not run; E4 is SKIP and verify-escrow exits 3 (recorded --evidence-dir runs without the flag keep the legacy exit 0).
  --evidence-dir <dir>: OFFLINE mode on a recorded run (services/e2e/live-runR3e layout); no network calls.
exit code 1 if any check FAILs; SKIPs are printed with their reason and do not fail, except verify-escrow --offline exits 3 (E4 SKIPped by explicit flag; a release gate needs the live check). Recorded --evidence-dir runs keep exit 0.`;

function args(argv: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${argv[i]}`);
    o[argv[i].slice(2)] = v; i++;
  }
  return o;
}

export function format(results: CheckResult[]): string {
  return results.map((r) => `${r.status.padEnd(4)} ${r.id}  ${r.reason}`).join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd !== "verify-bet" && cmd !== "verify-escrow") { console.error(USAGE); return 2; }
  let a: Record<string, string>;
  const offline = argv.includes("--offline");
  try { a = args(argv.slice(1).filter((x) => x !== "--offline")); } catch (e) { console.error(String(e instanceof Error ? e.message : e), "\n" + USAGE); return 2; }
  const opts: Options = { releaseDir: join(here, "..", "..", "..", "resolver", "release"), termsPath: a.terms, wasmFile: a["wasm-file"], expectEscrowHash: a["expect-escrow-hash"] };
  if (a["judge-evidence"]) opts.judgeEvidence = JSON.parse(readFileSync(a["judge-evidence"], "utf8"));
  if (a.attestation) {
    try { opts.attestations = a.attestation.split(",").map((f) => ({ name: f, raw: readFileSync(f, "utf8") })); }
    catch (e) { console.error(`cannot read --attestation file: ${e instanceof Error ? e.message : e}`); return 2; }
  }
  let paramsIn: { new_args?: Record<string, any>; receipts: any[]; views: any } | undefined;
  if (a["params-file"]) {
    try { paramsIn = parseBigJson(readFileSync(a["params-file"], "utf8")); if (!paramsIn?.views || !Array.isArray(paramsIn.receipts)) throw new Error("needs {views, receipts}"); }
    catch (e) { console.error(`cannot read --params-file: ${e instanceof Error ? e.message : e}`); return 2; }
  }
  const injectParams = (ev: Parameters<typeof runBetChecks>[0]) => {
    if (!paramsIn) return;
    const v = paramsIn.views;
    let pending = v.pending_params ?? null;
    if (typeof v.pending_params_raw === "string") pending = parseBigJson(v.pending_params_raw);
    ev.params = { views: { protocol_fee_bps: v.protocol_fee_bps, asset_limit: v.asset_limit, pending_params: pending }, events: extractParamsEvents(paramsIn.receipts), newArgs: paramsIn.new_args };
    ev.paramsSkip = undefined;
  };
  let results: CheckResult[];
  if (a["evidence-dir"]) {
    const ev = loadEvidenceDir(a["evidence-dir"]);
    console.log(`# offline evidence ${a["evidence-dir"]} escrow ${ev.escrow} bet ${ev.betId}`);
    injectParams(ev);
    results = runBetChecks(ev, opts);
  } else {
    if (!a.network || !a.escrow || (cmd === "verify-bet" && a.bet === undefined)) { console.error(USAGE); return 2; }
    if (a.network !== "testnet" && a.network !== "mainnet") { console.error(USAGE); return 2; }
    const ev = await collectLive(a.network, a.escrow, cmd === "verify-bet" ? Number(a.bet) : undefined);
    if (!opts.attestations) { // keyless public GET, one per distinct (model, signing_address) in the record; failures just leave B4 at SKIP
      const seen = new Set<string>(), got: { name: string; raw: string }[] = [];
      for (const d of ev.judge?.run_diagnostics ?? []) {
        const p = d.signature_proof;
        if (!p || !d.model || seen.has(`${d.model}\n${p.signing_address}`)) continue;
        seen.add(`${d.model}\n${p.signing_address}`);
        const raw = await fetchAttestation(String(d.model), String(p.signing_address));
        if (raw !== undefined) got.push({ name: `fetched:${d.model}`, raw });
      }
      if (got.length) opts.attestations = got;
    }
    injectParams(ev);
    if (!offline) ev.e4 = await collectE4(ev, { escrowHome: a["outlayer-home-escrow"] ?? process.env.PRAETORIAL_OL_HOME_ESCROW, attestHome: a["outlayer-home-attest"] ?? process.env.PRAETORIAL_OL_HOME_ATTEST }, cliRunner(a["outlayer-bin"] ?? process.env.OUTLAYER_BIN));
    opts.wasmBytes = opts.wasmFile ? undefined : await fetchResolverWasm(ev);
    console.log(`# live ${a.network} escrow ${a.escrow}${cmd === "verify-bet" ? ` bet ${a.bet}` : ""} (read-only RPC views + tx history from ${indexerUrl(a.network)}; no keys, no txs)`);
    results = cmd === "verify-escrow" ? runEscrowChecks(ev, opts) : runBetChecks(ev, opts);
  }
  if (cmd === "verify-escrow") results = results.filter((r) => r.id.startsWith("E"));
  console.log(format(results));
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`# ${results.filter((r) => r.status === "PASS").length} PASS, ${failed} FAIL, ${results.filter((r) => r.status === "SKIP").length} SKIP`);
  if (failed) return 1;
  if (cmd === "verify-escrow" && offline && results.some((r) => r.id === "E4" && r.status === "SKIP")) { console.error("E4 was SKIPPED: not a release-grade verification (exit 3)"); return 3; }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error("verifier error:", e instanceof Error ? e.message : e); process.exit(2); });
}

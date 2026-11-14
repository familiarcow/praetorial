// FRZ1b: live E4. Runs the pinned resolver wasm (FastFS url from outlayer_config.wasm_base_url + resolver_wasm_hash) in
// {"mode":"report-pubkey"} via the OutLayer CLI: once logged in as the escrow (outcome key is escrow-predecessor-bound) and once as
// the attest signer (attest key, D-ATTEST2). Spends OutLayer credit (~0.002 testnet NEAR each). The runner is injectable for tests.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "./run.js";

export type OutlayerRunner = (home: string, wasmUrl: string, input: string) => Promise<string>;
export interface E4Config { escrowHome?: string; attestHome?: string; bin?: string }

export const cliRunner = (bin = "outlayer"): OutlayerRunner => (home, url, input) =>
  new Promise((resolve, reject) => {
    const d = mkdtempSync(join(tmpdir(), "e4-job-")), f = join(d, "job.json");
    writeFileSync(f, input);
    execFile(bin, ["run", "--wasm", url, "--input", f], { env: { ...process.env, OUTLAYER_HOME: home }, timeout: 240_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      rmSync(d, { recursive: true, force: true });
      if (err) reject(new Error(`outlayer run failed: ${String(err.message).split("\n")[0]}`)); else resolve(stdout + stderr);
    });
  });

function parseReport(out: string): any {
  const a = out.indexOf("{"), b = out.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON in outlayer output");
  const j = JSON.parse(out.slice(a, b + 1));
  if (j.mode !== "report-pubkey") throw new Error("outlayer output is not a report-pubkey result");
  return j;
}

export async function collectE4(ev: Evidence, cfg: E4Config, run: OutlayerRunner): Promise<NonNullable<Evidence["e4"]>> {
  const base = (ev.outlayerConfig as any)?.wasm_base_url;
  if (!base) return { error: "no outlayer_config.wasm_base_url on the escrow" };
  if (!cfg.escrowHome || !cfg.attestHome) return { error: "need --outlayer-home-escrow and --outlayer-home-attest (OutLayer CLI homes logged in as the escrow and as the attest signer); use --offline to SKIP E4 (exit code non-zero)" };
  const url = `${base}/${ev.pins.resolver_wasm_hash}.wasm`;
  const input = JSON.stringify({ mode: "report-pubkey" });
  try {
    const o = parseReport(await run(cfg.escrowHome, url, input));
    const a = parseReport(await run(cfg.attestHome, url, input));
    return { outcome: { public_key: String(o.public_key), predecessor: String(o.predecessor) }, attest: { attest_public_key: String(a.attest_public_key), predecessor: String(a.predecessor) } };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

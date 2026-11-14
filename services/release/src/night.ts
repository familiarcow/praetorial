// MAINPREP1: deploy-night helpers (pure; the thin CLIs live in scripts/mainnet-night/).
// - fillOutlayerFields: the three OutLayer-sourced new() fields from the report-pubkey runs and the FastFS upload log.
// - compareViews: deployed escrow views vs the new() args file (release record check after deploy).

export interface ReportPubkey { predecessor: string; public_key: string; attest_public_key: string; wasm_url: string | null; tx: string | null }
export interface UploadInfo { baseUrl: string; sha256: string; url: string }

const HEX64 = /^[0-9a-f]{64}$/;

/** The JSON object printed by `outlayer run --wasm <url> --input {"mode":"report-pubkey"}` plus the wasm URL and tx lines. */
export function parseReportPubkeyLog(log: string): ReportPubkey {
  const start = log.indexOf("{"), end = log.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("report-pubkey log has no JSON result block");
  let j: Record<string, unknown>;
  try { j = JSON.parse(log.slice(start, end + 1)); } catch (e) { throw new Error(`report-pubkey log JSON does not parse: ${(e as Error).message}`); }
  if (j.mode !== "report-pubkey") throw new Error(`report-pubkey log: mode is ${JSON.stringify(j.mode)}, not "report-pubkey"`);
  const pk = String(j.public_key ?? ""), apk = String(j.attest_public_key ?? "");
  if (!HEX64.test(pk) || !HEX64.test(apk)) throw new Error("report-pubkey log: public_key / attest_public_key are not 64 lowercase hex");
  return {
    predecessor: String(j.predecessor ?? ""), public_key: pk, attest_public_key: apk,
    wasm_url: /Running wasm:(\S+)/.exec(log)?.[1] ?? null, tx: /^Tx: (\S+)/m.exec(log)?.[1] ?? null,
  };
}

/** `outlayer upload` output: "SHA256: <hex>" and "FastFS URL: https://host/<uploader>/<receiver>/<hash>.wasm". */
export function parseUploadLog(log: string): UploadInfo {
  const sha256 = /SHA256:\s*([0-9a-f]{64})/.exec(log)?.[1];
  const url = /FastFS URL:\s*(\S+)/.exec(log)?.[1];
  if (!sha256 || !url) throw new Error("upload log: missing SHA256 or FastFS URL line");
  const m = /^(https:\/\/[^/]+\/.+)\/([0-9a-f]{64})\.wasm$/.exec(url);
  if (!m) throw new Error(`upload log: FastFS URL is not https://<host>/<uploader>/<receiver>/<hash>.wasm (${url})`);
  if (m[2] !== sha256) throw new Error(`upload log: URL hash ${m[2]} != uploaded SHA256 ${sha256}`);
  return { baseUrl: m[1]!, sha256, url };
}

export interface FillInputs { outcomeLog: string; attestLog: string; uploadLog: string; escrow: string; attestAccount: string; resolverHash: string }

/** Returns a copy of the release input with outcome_pubkey, attest_pubkey and outlayer_config.wasm_base_url filled. */
export function fillOutlayerFields<T extends { outlayer_config?: Record<string, unknown> }>(input: T, f: FillInputs): T & { outcome_pubkey: string; attest_pubkey: string; outlayer_config: Record<string, unknown> } {
  const up = parseUploadLog(f.uploadLog);
  if (up.sha256 !== f.resolverHash) throw new Error(`uploaded wasm hash ${up.sha256} != pinned resolver_wasm_hash ${f.resolverHash}`);
  const o = parseReportPubkeyLog(f.outcomeLog), a = parseReportPubkeyLog(f.attestLog);
  if (o.predecessor !== f.escrow) throw new Error(`outcome run predecessor is ${o.predecessor}, must be the escrow ${f.escrow} (OutLayer derives the outcome key per caller)`);
  if (a.predecessor !== f.attestAccount) throw new Error(`attest run predecessor is ${a.predecessor}, must be the attest signer ${f.attestAccount}`);
  for (const [name, r] of [["outcome", o], ["attest", a]] as const) {
    if (r.wasm_url && r.wasm_url !== up.url) throw new Error(`${name} run used wasm ${r.wasm_url}, not the uploaded ${up.url} (hash mismatch)`);
  }
  const out = JSON.parse(JSON.stringify(input));
  out.outcome_pubkey = o.public_key;
  out.attest_pubkey = a.attest_public_key;
  out.outlayer_config = { ...(out.outlayer_config ?? {}), wasm_base_url: up.baseUrl };
  return out;
}

export interface EscrowViews {
  resolver_keys: string[]; outlayer_config: unknown; judge_chain: unknown; asset_limit: Record<string, unknown>;
  protocol_fee_bps: number; is_paused: boolean; is_shutdown: boolean; contract_version: string;
}
export interface ViewLine { check: string; ok: boolean; detail: string }

/** Canonical JSON (sorted keys) so field order never matters. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));

export function compareViews(args: any, v: EscrowViews): ViewLine[] {
  const L: ViewLine[] = [];
  const eq = (check: string, want: unknown, got: unknown) => L.push({ check, ok: canon(want) === canon(got), detail: canon(want) === canon(got) ? `= ${canon(got).slice(0, 100)}` : `want ${canon(want)} got ${canon(got)}` });
  eq("resolver_keys", [args.outcome_pubkey, args.attest_pubkey, args.resolver_wasm_hash], v.resolver_keys);
  eq("outlayer_config", args.outlayer_config, v.outlayer_config);
  eq("judge_chain", args.judge_chain, v.judge_chain);
  for (const [id, lim] of args.asset_limits as [string, unknown][]) eq(`asset_limit(${id})`, lim, v.asset_limit[id] ?? null);
  eq("protocol_fee_bps", 100, v.protocol_fee_bps);
  eq("is_paused", false, v.is_paused);
  eq("is_shutdown", false, v.is_shutdown);
  L.push({ check: "contract_version", ok: typeof v.contract_version === "string" && v.contract_version.length > 0, detail: `= ${v.contract_version}` });
  return L;
}

// LH3b (D-FETCH1 part 3 / D-HORIZON2 / D-RESOLVE1(c)): PRODUCTION adapters for the
// keeper's archive schedule (LH3 wired the schedule; this builds the real
// OutLayer archive client and the getRawTerms source).
//
// * Archive client: the pinned resolver wasm (url/hash from the escrow's own
//   `outlayer_config` + `resolver_keys` views, exactly the WasmUrl the contract
//   itself builds in request_resolution) is run via OutLayer `request_execution`
//   with input_data {mode:"archive", bet_id, terms}. D-ATTEST2: the attest key
//   is signer-bound, so this call MUST be signed by the dedicated attest
//   signer account (ARCHIVE_ATTEST_KEY_FILE), never the keeper account. The
//   output is the JSON resolver/wasm-bin main() prints for archive mode.
// * getRawTerms: the stored term sheet (envelope.terms, present iff keep_terms)
//   read from the escrow view; returned only if sha256(terms) == terms_hash.
import { sha256Hex, type ArchiveSnapshot } from "@praetorial/common/archiveSnapshot.js";
import type { TxLogger } from "@praetorial/common/logger.js";
import type { ArchiveJobClient } from "./archiveJob.js";
import { ArchiveStore } from "./archiveJob.js";

const WASM_TARGET = "wasm32-wasip2";
// Archive fetches a handful of https pages: small, bounded run.
const ARCHIVE_MAX_INSTRUCTIONS = 5_000_000_000;
const ARCHIVE_MAX_MEMORY_MB = 128;
const ARCHIVE_MAX_SECONDS = 90;

export function archiveRequestArgs(p: { wasmBaseUrl: string; wasmHash: string; betId: string; rawTerms: string }): Record<string, unknown> {
  return {
    source: { WasmUrl: { url: `${p.wasmBaseUrl}/${p.wasmHash}.wasm`, hash: p.wasmHash, build_target: WASM_TARGET } },
    input_data: JSON.stringify({ mode: "archive", bet_id: p.betId, terms: p.rawTerms }),
    resource_limits: { max_instructions: ARCHIVE_MAX_INSTRUCTIONS, max_memory_mb: ARCHIVE_MAX_MEMORY_MB, max_execution_seconds: ARCHIVE_MAX_SECONDS },
    response_format: "Json",
  };
}

/** Reads the guest's JSON output from a finalized `request_execution` tx result
 * (the OutLayer callback receipt's SuccessValue). null if none. */
export function extractOutlayerOutput(txResult: any, outlayerContract: string): unknown | null {
  const outs: any[] = txResult?.receipts_outcome ?? [];
  for (const o of outs) {
    if (o?.outcome?.executor_id !== outlayerContract) continue;
    const v = o?.outcome?.status?.SuccessValue;
    if (!v) continue;
    try {
      const parsed = JSON.parse(Buffer.from(v, "base64").toString("utf8"));
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch { /* not the guest output */ }
  }
  return null;
}

/** Maps the resolver's archive-mode output to the keeper's types. Unsigned
 * snapshots (signing_error / missing sig) are reported as failed, never stored. */
export function parseArchiveOutput(output: unknown, betId: string): { snapshots: ArchiveSnapshot[]; failed: Array<{ id: string; reason: string }> } {
  const o = output as any;
  if (!o || typeof o !== "object" || !Array.isArray(o.snapshots)) throw new Error("archive output malformed (no snapshots array)");
  if (String(o.bet_id) !== betId) throw new Error(`archive output is for bet ${String(o.bet_id)}, expected ${betId}`);
  const snapshots: ArchiveSnapshot[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  for (const f of Array.isArray(o.failed) ? o.failed : []) failed.push({ id: String(f?.id), reason: String(f?.reason) });
  for (const s of o.snapshots) {
    if (typeof s?.resolver_sig !== "string" || typeof s?.resolver_pubkey_hex !== "string") {
      failed.push({ id: String(s?.source_id), reason: `snapshot unsigned: ${s?.signing_error ?? "no resolver_sig"}` });
      continue;
    }
    snapshots.push({
      betId, sourceId: String(s.source_id), capturedAt: String(s.captured_at), termsHash: String(s.terms_hash ?? o.terms_hash),
      body: String(s.body), resolverPubkeyHex: s.resolver_pubkey_hex, signatureHex: s.resolver_sig,
    });
  }
  return { snapshots, failed };
}

export interface OutLayerArchiveClientOpts {
  outlayerContract: string;
  /** The pinned resolver wasm for this escrow contract. */
  resolveWasm(contractId: string): Promise<{ baseUrl: string; hash: string }>;
  /** Sends `request_execution` args (signed by the attest signer) and returns the finalized tx result. */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export class OutLayerArchiveClient implements ArchiveJobClient {
  constructor(private o: OutLayerArchiveClientOpts) {}
  async runArchiveJob(betId: string, rawTerms: string, contractId?: string) {
    if (!contractId) throw new Error("archive job needs the escrow contract id (pinned wasm differs per contract)");
    const wasm = await this.o.resolveWasm(contractId);
    const args = archiveRequestArgs({ wasmBaseUrl: wasm.baseUrl, wasmHash: wasm.hash, betId, rawTerms });
    const res = await this.o.execute(args);
    const out = extractOutlayerOutput(res, this.o.outlayerContract);
    if (out === null) throw new Error("OutLayer archive run returned no output (failed run)");
    return { ...parseArchiveOutput(out, betId), raw: out };
  }
}

/** getRawTerms: exact stored term sheet iff sha256 matches the bet's terms_hash. */
export function makeGetRawTerms(client: { view<T>(c: string, m: string, a?: Record<string, unknown>): Promise<T> }, logger: TxLogger) {
  return async (contractId: string, betId: number): Promise<string | null> => {
    const base = { service: "keeper", action: "archive", bet_id: betId, contract_id: contractId } as any;
    const bet = await client.view<any>(contractId, "get_bet", { bet_id: betId });
    if (!bet?.envelope) return null;
    const terms: unknown = bet.envelope.terms;
    if (typeof terms !== "string" || terms === "") {
      logger.log({ ...base, status: "skipped", detail: "hash-only bet: no raw term sheet on chain (nothing to archive)" });
      return null;
    }
    const th = String(bet.envelope.terms_hash ?? "");
    const want = th.startsWith("sha256:") ? th.slice(7) : th;
    if (sha256Hex(terms) !== want) {
      logger.log({ ...base, status: "error", detail: "stored terms do not hash to envelope terms_hash; archive skipped" });
      return null;
    }
    return terms;
  };
}

export interface ArchiveConfig {
  enabled: boolean;
  attestKeyFile?: string;
  attestAccountId?: string;
  dir: string;
  /** Ceiling attached to each OutLayer request (excess is refunded by OutLayer). */
  attachYocto: bigint;
}

/** ~0.31 NEAR per run measured on testnet (D-ATTEST2 note); default ceiling 0.4 NEAR. */
const DEFAULT_ATTACH_YOCTO = 400_000_000_000_000_000_000_000n;

export function loadArchiveConfig(env: Record<string, string | undefined>): ArchiveConfig {
  const off = ["0", "false", "no", "off"].includes((env.KEEPER_ARCHIVE_ENABLED ?? "").trim().toLowerCase());
  return {
    enabled: !off,
    attestKeyFile: env.ARCHIVE_ATTEST_KEY_FILE || undefined,
    attestAccountId: env.ARCHIVE_ATTEST_ACCOUNT_ID || undefined,
    dir: env.ARCHIVE_DIR || "./data/archive",
    attachYocto: env.ARCHIVE_ATTACH_NEAR_YOCTO ? BigInt(env.ARCHIVE_ATTACH_NEAR_YOCTO) : DEFAULT_ATTACH_YOCTO,
  };
}

export interface ArchiveFactories {
  makeClient(cfg: ArchiveConfig): ArchiveJobClient;
  makeStore(dir: string): ArchiveStore;
}

export function buildArchiveWiring(
  env: Record<string, string | undefined>,
  client: { view<T>(c: string, m: string, a?: Record<string, unknown>): Promise<T> },
  logger: TxLogger,
  factories: ArchiveFactories,
): { client: ArchiveJobClient; store: ArchiveStore; getRawTerms: (c: string, b: number) => Promise<string | null> } | undefined {
  const cfg = loadArchiveConfig(env);
  if (!cfg.enabled) return undefined;
  if (!cfg.attestKeyFile) {
    logger.log({ service: "keeper", action: "archive", status: "skipped", detail: "archive enabled but ARCHIVE_ATTEST_KEY_FILE is not set: archiving is INERT (set it, or KEEPER_ARCHIVE_ENABLED=0 to silence)" });
    return undefined;
  }
  try {
    return { client: factories.makeClient(cfg), store: factories.makeStore(cfg.dir), getRawTerms: makeGetRawTerms(client, logger) };
  } catch (err: any) {
    logger.log({ service: "keeper", action: "archive", status: "error", detail: `archive adapters could not be built; archiving is INERT: ${String(err?.message ?? err)}` });
    return undefined;
  }
}

/** Production factories: the attest signer account (D-ATTEST2) signs a plain
 * OutLayer `request_execution`; the pinned wasm comes from the escrow views. */
export function realArchiveFactories(
  svc: { networkId: string; outlayerContract: string },
  view: { view<T>(c: string, m: string, a?: Record<string, unknown>): Promise<T> },
  makeSigner: (cfg: ArchiveConfig) => Promise<{ functionCall(a: any): Promise<unknown> }>,
): ArchiveFactories {
  return {
    makeClient(cfg) {
      if (!svc.outlayerContract) throw new Error("OUTLAYER_CONTRACT_ID is not set");
      let signer: Promise<{ functionCall(a: any): Promise<unknown> }> | undefined;
      return new OutLayerArchiveClient({
        outlayerContract: svc.outlayerContract,
        async resolveWasm(contractId) {
          const [, , hash] = await view.view<[string, string, string]>(contractId, "resolver_keys", {});
          const oc = await view.view<{ wasm_base_url: string }>(contractId, "outlayer_config", {});
          return { baseUrl: oc.wasm_base_url, hash };
        },
        async execute(args) {
          signer ??= makeSigner(cfg);
          return (await signer).functionCall({
            contractId: svc.outlayerContract, methodName: "request_execution", args,
            gas: 100_000_000_000_000n, attachedDeposit: cfg.attachYocto,
          });
        },
      });
    },
    makeStore: (dir) => new ArchiveStore({ dir }),
  };
}

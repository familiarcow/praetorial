// Escrow NEAR storage-headroom monitoring (MON1 / ruling D-RTGAS1).
// The escrow contract pays its own storage staking, so a spammer could
// drain the buffer above storage until finalize fails with
// LackBalanceForState. Recoverable by anyone sending NEAR to the escrow
// account; this module only DETECTS it. Contract is unchanged.
//
//   headroom = view_account.amount (liquid, yocto)
//              - view_account.storage_usage * runtime_config.storage_amount_per_byte
//
// Both RPC calls are public/keyless/read-only: `query`/view_account and
// EXPERIMENTAL_protocol_config. Pure logic + one fetch function taking an
// injected fetch, so tests never touch the network.
import type { Alert } from "./alertsCore.js";

/** Alert when headroom drops below this (0.5 NEAR). */
export const MIN_HEADROOM_YOCTO = 5n * 10n ** 23n;
/** Alert when the trend projects headroom reaching 0 within this window. */
export const PROJECTION_HORIZON_NS = 24 * 3_600_000_000_000;
/** Samples older than this (vs. the newest) are dropped from the store. */
export const SAMPLE_RETENTION_NS = 48 * 3_600_000_000_000;

export interface HeadroomSample {
  tsNs: number;
  headroomYocto: bigint;
}

export function computeHeadroom(
  account: { amount: string; storage_usage: number },
  protocolConfig: { runtime_config: { storage_amount_per_byte: string } },
): bigint {
  return (
    BigInt(account.amount) -
    BigInt(account.storage_usage) * BigInt(protocolConfig.runtime_config.storage_amount_per_byte)
  );
}

async function rpc(url: string, method: string, params: unknown, fetchImpl: typeof fetch): Promise<any> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "mon1", method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  return res.json();
}

/** One headroom reading. Throws on ANY failure (transport, HTTP,
 * JSON-RPC error, missing/malformed field) -- callers must turn that
 * into the distinct "cannot check" alert, never an OK. */
export async function fetchHeadroomSample(
  rpcUrl: string,
  accountId: string,
  nowNs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<HeadroomSample> {
  const acct = await rpc(
    rpcUrl,
    "query",
    { request_type: "view_account", finality: "final", account_id: accountId },
    fetchImpl,
  );
  const a = acct?.result;
  if (!a || typeof a.amount !== "string" || typeof a.storage_usage !== "number") {
    throw new Error(`view_account: bad response ${JSON.stringify(acct?.error ?? "missing amount/storage_usage")}`);
  }
  const cfg = await rpc(rpcUrl, "EXPERIMENTAL_protocol_config", { finality: "final" }, fetchImpl);
  const per = cfg?.result?.runtime_config?.storage_amount_per_byte;
  if (typeof per !== "string") {
    throw new Error(`protocol_config: missing runtime_config.storage_amount_per_byte ${JSON.stringify(cfg?.error ?? "")}`);
  }
  return { tsNs: nowNs, headroomYocto: computeHeadroom(a, cfg.result) };
}

const fmtNear = (y: bigint) => `${(Number(y / 10n ** 18n) / 1e6).toFixed(6)} NEAR`;
const RUNBOOK = "Runbook: anyone can top up by sending NEAR to the escrow account; nothing else needed.";

/** Pure: `samples` is chronological, newest last. Returns [] when healthy.
 * A rise in headroom between samples (a top-up) discards everything
 * before it so the trend only reflects the current drain. */
export function alertsForStorageHeadroom(contractId: string, samples: HeadroomSample[]): Alert[] {
  const latest = samples[samples.length - 1];
  if (!latest) return [];
  if (latest.headroomYocto < MIN_HEADROOM_YOCTO) {
    return [
      {
        key: `storage_headroom:${contractId}`,
        kind: "storage_headroom",
        severity: "critical",
        message: `escrow ${contractId} storage headroom low: ${fmtNear(latest.headroomYocto)} < ${fmtNear(MIN_HEADROOM_YOCTO)}`,
        detail: `headroom=${latest.headroomYocto} yocto. finalize fails with LackBalanceForState at 0. ${RUNBOOK}`,
      },
    ];
  }
  let start = samples.length - 1;
  while (start > 0 && samples[start - 1]!.headroomYocto >= samples[start]!.headroomYocto) start--;
  const first = samples[start]!;
  const dt = latest.tsNs - first.tsNs;
  const drop = first.headroomYocto - latest.headroomYocto;
  if (dt > 0 && drop > 0n) {
    // time to zero = headroom * dt / drop  (all bigint-safe via ns as bigint)
    const toZeroNs = (latest.headroomYocto * BigInt(dt)) / drop;
    if (toZeroNs <= BigInt(PROJECTION_HORIZON_NS)) {
      return [
        {
          key: `storage_headroom_trend:${contractId}`,
          kind: "storage_headroom",
          severity: "warning",
          message: `escrow ${contractId} storage headroom trend projects 0 within 24h (~${(Number(toZeroNs) / 3.6e12).toFixed(1)}h)`,
          detail: `headroom=${latest.headroomYocto} yocto, fell ${drop} yocto over ${dt}ns. ${RUNBOOK}`,
        },
      ];
    }
  }
  return [];
}

export function alertForUncheckable(contractId: string, err: unknown): Alert {
  return {
    key: `storage_headroom_unchecked:${contractId}`,
    kind: "storage_headroom_unchecked",
    severity: "warning",
    message: `cannot check escrow ${contractId} storage headroom`,
    detail: `headroom check failed (NOT assumed OK): ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** Appends `s` to the in-memory store, dropping samples older than the
 * retention window. Returns the new array (store is process-lifetime;
 * after a restart the trend rebuilds from fresh samples). */
export function appendSample(samples: HeadroomSample[], s: HeadroomSample): HeadroomSample[] {
  return [...samples, s].filter((x) => s.tsNs - x.tsNs <= SAMPLE_RETENTION_NS);
}

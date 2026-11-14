// Shared config for all services. Every secret/path comes from env vars —
// no key material or account IDs are hardcoded so the same code runs
// against any testnet/mainnet deployment by swapping env vars only.
import fs from "node:fs";
import { resolveRpcUrls } from "./rpc.js";

export interface NearKeyFile {
  account_id?: string;
  public_key: string;
  private_key: string;
}

export function loadKeyFile(path: string): NearKeyFile {
  const raw = fs.readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.private_key || !parsed.public_key) {
    throw new Error(`key file ${path} missing public_key/private_key`);
  }
  return parsed;
}

// D-UPGRADE1: a single deployment may run several versions of the
// escrow contract side by side during a migration (old bets still
// live on the old contract while new bets open on the new one). Every
// bet a keeper/indexer/notifier processes is tagged with which
// contract id (and declared version label) it came from.
export interface EscrowContractRef {
  id: string;
  version: string;
}

export interface ServiceConfig {
  networkId: string;
  nodeUrl: string; // primary RPC URL (first of rpcUrls)
  rpcUrls: string[]; // primary + NEAR_RPC_FALLBACKS, in failover order
  // Back-compat: the first entry of escrowContracts, so any existing
  // single-contract call site (ESCROW_CONTRACT_ID only) keeps working
  // unchanged.
  escrowContract: string;
  escrowContracts: EscrowContractRef[];
  intentsContract: string; // mock-intents on testnet
  outlayerContract: string; // mock-outlayer on testnet
  usdcTokenId: string;
}

/** Parses ESCROW_CONTRACTS='id1@v1,id2@v2' into a list of contract refs.
 * Falls back to the single ESCROW_CONTRACT_ID env var (tagged "v1") when
 * ESCROW_CONTRACTS is unset/empty, so every pre-existing deployment that
 * only ever set ESCROW_CONTRACT_ID keeps working with zero config
 * changes. A version-less entry ("id1" with no "@v") also defaults to
 * "v1". */
export function parseEscrowContracts(): EscrowContractRef[] {
  const multi = process.env.ESCROW_CONTRACTS;
  if (multi !== undefined && multi.trim() !== "") {
    const refs = multi.split(",").map((entry) => {
      const trimmed = entry.trim();
      const at = trimmed.indexOf("@");
      const id = at === -1 ? trimmed : trimmed.slice(0, at);
      const version = at === -1 ? "v1" : trimmed.slice(at + 1);
      if (!id) throw new Error(`invalid ESCROW_CONTRACTS entry: "${entry}"`);
      return { id, version: version || "v1" };
    });
    if (refs.length === 0) throw new Error("ESCROW_CONTRACTS is set but parsed to zero contracts");
    // A repeated id would be scanned/acted on twice and its version label
    // silently overwritten in downstream maps: refuse to start instead.
    const ids = new Set<string>();
    for (const r of refs) {
      if (ids.has(r.id)) throw new Error(`duplicate escrow contract id in ESCROW_CONTRACTS: "${r.id}"`);
      ids.add(r.id);
    }
    return refs;
  }
  return [{ id: required("ESCROW_CONTRACT_ID"), version: "v1" }];
}

export function loadServiceConfig(): ServiceConfig {
  const escrowContracts = parseEscrowContracts();
  const networkId = process.env.NEAR_NETWORK_ID ?? process.env.NEAR_NETWORK ?? "testnet";
  // D-RPC1 (queue item 7b): ONE shared RPC config -- NEAR_RPC_URL
  // (falling back to NEAR_NODE_URL for back-compat) selects the
  // endpoint, NEAR_RPC_FALLBACKS adds failover backups. The literal
  // default URLs live only in services/common/src/rpc.ts.
  if (!process.env.NEAR_RPC_URL && process.env.NEAR_NODE_URL) {
    process.env.NEAR_RPC_URL = process.env.NEAR_NODE_URL;
  }
  const { primary, all } = resolveRpcUrls(networkId);
  return {
    networkId,
    nodeUrl: primary,
    rpcUrls: all,
    escrowContract: escrowContracts[0].id,
    escrowContracts,
    intentsContract: required("INTENTS_CONTRACT_ID"),
    outlayerContract: process.env.OUTLAYER_CONTRACT_ID ?? "",
    usdcTokenId: process.env.USDC_TOKEN_ID ?? "usdc.fakes.testnet",
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

/** Per-call attached-NEAR ceiling for any payable method a service calls.
 * Hard safety rail: a service refuses to attach more than this to any
 * single transaction, regardless of what the contract/caller asks for.
 * D-AUDIT5 (supersedes the old master-map C3 framing, which assumed the
 * keeper always attaches NEAR directly): the keeper's default posture is
 * a function-call-scoped access key, which NEAR protocol forbids from
 * attaching any deposit at all, so `request_resolution` normally runs
 * in zero-deposit credit mode against the contract's `keeper_credit`
 * pool. This cap only bites a keeper that explicitly opts into
 * attaching NEAR directly (KEEPER_ATTACH_NEAR_YOCTO / a full-access-key
 * or BYO-wallet deployment); it is the *per call* max, independent of
 * and tighter than any float the keeper account itself might hold. */
export const MAX_ATTACHED_NEAR_YOCTO = BigInt(process.env.MAX_ATTACHED_NEAR_YOCTO ?? "50000000000000000000000"); // 0.05 NEAR default

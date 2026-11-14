// WT1 (3): release pins come from config (lib/release.json), never from literals in the open handler.
// D-KEY1: resolver_wasm_hash / resolver_pubkey are NOT envelope fields -- they are pinned in the escrow
// contract (resolver_keys()). The web therefore (a) derives models_snapshot_hash from the release's model
// list and (b) checks the contract's pinned wasm hash equals the release's before it lets anyone open.
// MAINPREP: pins are network-selected at build time (resolveNetworkId): lib/release.json = testnet,
// lib/release.mainnet.json = mainnet. releasePins() is the only accessor; app code never imports the json files.
import testnetRelease from "./release.json";
import mainnetRelease from "./release.mainnet.json";
import { canonicalTerms, termsHash } from "./templates";
import { resolveNetworkId, readBuildEnv, MAINNET_ONLY_BUILD, type EnvLike, type NetworkId } from "./networkSelect";

export interface ReleasePins {
  network: string;
  release_record: string;
  resolver_wasm_hash: string;
  models: string[];
  fee_account: string;
}

// The testnet pins are dropped from a mainnet bundle (MAINNET_ONLY_BUILD); selecting a network this build lacks throws.
export const RELEASE_PINS: Partial<Record<NetworkId, ReleasePins>> = MAINNET_ONLY_BUILD ? { mainnet: mainnetRelease } : { testnet: testnetRelease, mainnet: mainnetRelease };

/** The release pins for the network this build targets (NETWORK_ID / VITE_NETWORK_ID, default testnet). */
export function releasePins(env: EnvLike = readBuildEnv()): ReleasePins {
  const id = resolveNetworkId(env);
  const pins = RELEASE_PINS[id];
  if (!pins) throw new Error(`release pins for network "${id}" are not in this build`);
  return pins;
}

/** The escrow's fee account for this build's network (referee checks refuse it); null when unknown. */
export function releaseFeeAccount(env: EnvLike = readBuildEnv()): string | null {
  return releasePins(env).fee_account || null;
}

export interface ReleaseConfig {
  network: string;
  resolver_wasm_hash: string;
  models: string[];
  models_snapshot_hash: string;
  fee_account?: string | null;
}

export function loadReleaseConfig(raw: { network: string; resolver_wasm_hash: string; models: string[]; fee_account?: string } = releasePins()): ReleaseConfig {
  if (!/^[0-9a-f]{64}$/.test(raw.resolver_wasm_hash)) throw new Error("release config: resolver_wasm_hash must be 64 hex chars");
  if (!raw.models.length) throw new Error("release config: models list is empty");
  return {
    network: raw.network,
    resolver_wasm_hash: raw.resolver_wasm_hash,
    models: [...raw.models],
    // sha256 of the canonical JSON array of the pinned model list.
    models_snapshot_hash: termsHash(canonicalTerms(raw.models)),
    fee_account: raw.fee_account ?? null,
  };
}

/** `keys` is the escrow `resolver_keys()` tuple [outcome_pubkey, attest_pubkey, resolver_wasm_hash]. Returns an error string or null. */
export function pinnedKeysMismatch(keys: string[], rel: ReleaseConfig = loadReleaseConfig()): string | null {
  if (!Array.isArray(keys) || keys.length < 3) return "escrow resolver_keys() returned an unexpected shape";
  return keys[2] === rel.resolver_wasm_hash
    ? null
    : `escrow pins resolver ${keys[2]} but this web build expects ${rel.resolver_wasm_hash}; refusing to open`;
}

// WEBNET1 (D-WEBNET1): the single network table. Every chain/service address the web uses lives here (asset ids stay in
// lib/assets.ts and are read from it). Selection reuses WEBREG1's resolveNetworkId (NETWORK_ID / VITE_NETWORK_ID, default
// testnet). Env overrides still win per field (NAME or VITE_NAME; an empty value is ignored).
// Mainnet indexer/relayer are "" here (build:mainnet routes them through /_proxy/*): empty = "service not configured" and callers
// fail closed (requireService), never a fallback to testnet. DEPLOYFIX: the mainnet funding Worker URL lives HERE (not in a build
// script), so `npm run build:mainnet` can never ship fundingUrl "" again; mainnetDeployGuard refuses a dist without it.
import { assetId } from "./assets";
import { resolveNetworkId, readBuildEnv, TESTNET_REGISTRY_URL, MAINNET_REGISTRY_URL, MAINNET_ONLY_BUILD, type EnvLike, type NetworkId } from "./networkSelect";

export interface NetworkConfig {
  networkId: NetworkId;
  /** Frozen escrow contract (testnet: release/freeze-candidate-2.json testnet_escrow.account). */
  escrow: string;
  /** Intents contract (NEP-245); matches INTENTS_CONTRACT_ID in the Workers' wrangler.toml. */
  intents: string;
  /** USDC token id inside intents (from lib/assets.ts). */
  usdcTokenId: string;
  /** Token contracts the relayer funds (relayer FUND_TOKEN_CONTRACTS). */
  fundTokens: string[];
  funderId: string;
  rpcUrl: string;
  indexerUrl: string;
  relayerUrl: string;
  registryUrl: string;
  registryId: string;
  /** F2/FUND4: the funding Worker (F1, services/workers/funding: 1Click Add money / Cash out / Convert). "" = not configured: the
   * funding client fails closed ("Adding money is unavailable"), never a fallback to testnet. */
  fundingUrl: string;
}

const need = (v: string | null): string => { if (!v) throw new Error("asset table has no id for the network"); return v; };

export const NETWORKS = {
  // MAINPREP: the testnet entry is dropped from a mainnet bundle (MAINNET_ONLY_BUILD folds to true there, Rollup removes the branch);
  // resolveNetwork then fails closed if anything selects testnet. In node/tests both entries exist. Keep `testnet: {` a literal
  // object: services/workers/common/src/configDrift.ts parses this table from source.
  ...(MAINNET_ONLY_BUILD ? {} : {
  testnet: {
    networkId: "testnet",
    escrow: "praetorial-frz3-2611100414.praetorial-dev-1101.testnet",
    intents: "intents-mock.praetorial-dev-1101.testnet",
    usdcTokenId: need(assetId("USDC", "testnet")),
    fundTokens: ["usdc.testnet", "wrap.testnet"],
    funderId: "praetorial-dev-1101.testnet",
    rpcUrl: "https://test.rpc.fastnear.com",
    indexerUrl: "https://praetorial-indexer-testnet.familiarcow.workers.dev",
    relayerUrl: "https://praetorial-relayer-testnet.familiarcow.workers.dev",
    registryUrl: TESTNET_REGISTRY_URL,
    registryId: "registry.praetorial.testnet",
    // F1's testnet Worker (SPEC §7.1 `praetorial-funding-testnet`, same workers.dev account as the others). Until it is deployed
    // the client gets a network error and the UI says "unavailable"; 1Click itself is mainnet-only.
    fundingUrl: "https://praetorial-funding-testnet.familiarcow.workers.dev",
  },
  }),
  mainnet: {
    networkId: "mainnet",
    escrow: "bets.praetorial.near",
    intents: "intents.near",
    usdcTokenId: need(assetId("USDC", "mainnet")),
    fundTokens: [
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "usdt.tether-token.near", "btc.omft.near",
      "wrap.near", "eth.omft.near", "zec.omft.near",
    ],
    funderId: "",
    rpcUrl: "https://free.rpc.fastnear.com", // services/common DEFAULT_MAINNET_RPC_URL
    indexerUrl: "",
    relayerUrl: "",
    registryUrl: MAINNET_REGISTRY_URL,
    registryId: "registry.praetorial.near",
    // DEPLOYFIX: services/workers/funding [env.mainnet] name praetorial-funding-mainnet (workers.dev); the live mainnet bundle of
    // 2026-11-12 (index-Cxt3Yv_k.js) carries exactly this URL. Cross-origin: the Worker's FUNDING_ALLOWED_ORIGINS has the web origin.
    fundingUrl: "https://funding.praetorial.com",
  },
} as Record<NetworkId, NetworkConfig>;

const pick = (env: EnvLike, name: string): string | undefined => env[name] || env[`VITE_${name}`] || undefined;

export function resolveNetwork(env: EnvLike): NetworkConfig {
  const id = resolveNetworkId(env);
  const base = NETWORKS[id];
  if (!base) throw new Error(`network "${id}" is not in this build`);
  return {
    ...base,
    escrow: pick(env, "ESCROW_CONTRACT_ID") ?? base.escrow,
    intents: pick(env, "INTENTS_CONTRACT_ID") ?? base.intents,
    usdcTokenId: pick(env, "USDC_TOKEN_ID") ?? base.usdcTokenId,
    funderId: pick(env, "FUNDER_ID") ?? base.funderId,
    rpcUrl: pick(env, "NEAR_RPC_URL") ?? base.rpcUrl,
    indexerUrl: pick(env, "INDEXER_URL") ?? base.indexerUrl,
    relayerUrl: pick(env, "RELAYER_URL") ?? base.relayerUrl,
    registryUrl: pick(env, "REGISTRY_URL") ?? base.registryUrl,
    registryId: pick(env, "REGISTRY_ID") ?? base.registryId,
    fundingUrl: pick(env, "FUNDING_URL") ?? base.fundingUrl,
  };
}

export const NETWORK: NetworkConfig = resolveNetwork(readBuildEnv());

/** Fail closed: a Worker URL that is not configured for this network is an error, never a fallback. */
export function requireService(name: string, url: string): string {
  if (!url) throw new Error(`service not configured: ${name} (${NETWORK.networkId})`);
  return url;
}

/** Example account id for input placeholders, on this build's network (taker.near on mainnet, taker.testnet on testnet). */
export const exampleAccount = (name: string, network: NetworkId = NETWORK.networkId): string => `${name}.${network === "mainnet" ? "near" : "testnet"}`;

/** INTENTS1: the intents contract for `network` (the resolved, env-overridable one for the current network). Builders that
 * take a `network` must use this, never the current network's id, or a mainnet step would target the testnet mock. */
export function intentsContractFor(networkId: NetworkId): string {
  return networkId === NETWORK.networkId ? NETWORK.intents : NETWORKS[networkId].intents;
}

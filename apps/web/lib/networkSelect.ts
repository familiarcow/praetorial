// WEBREG1: build-time network selection. WEBNET1 extends this (full network table) and must reuse
// resolveNetworkId rather than add a second selector.
// NETWORK_ID (process env, node/tests) or VITE_NETWORK_ID (vite build); default "testnet".
export type NetworkId = "testnet" | "mainnet";
export type EnvLike = Record<string, string | undefined>;

export const TESTNET_REGISTRY_URL = "https://praetorial-registry-testnet.familiarcow.workers.dev";
// REG1: the live mainnet registry Worker (services/workers/registry [env.mainnet], REGISTRY_ID registry.praetorial.near). Usernames
// and the pick-a-username gate (G6) are on for mainnet. build:mainnet still routes through /_proxy/registry (service binding).
export const MAINNET_REGISTRY_URL = "https://registry.praetorial.com";

// WEBSRC1 (D-SRCW1): source-check Worker (services/workers/sourcecheck). Any path on it works. Calls are cross-origin: the Worker
// sends CORS headers for the web origin (SOURCECHECK_ALLOWED_ORIGINS), so no /_proxy hop.
export const TESTNET_SOURCECHECK_URL = "https://praetorial-sourcecheck-testnet.familiarcow.workers.dev/sourcecheck";
// PLACEHOLDER: the mainnet Worker is not deployed. A mainnet build refuses to deploy (assertSourcecheckDeployReady) until
// VITE_SOURCECHECK_URL overrides it or this constant is replaced by the real, deployed URL.
export const MAINNET_SOURCECHECK_URL = "https://sourcecheck.praetorial.com/sourcecheck";

export function resolveNetworkId(env: EnvLike): NetworkId {
  const v = env.NETWORK_ID || env.VITE_NETWORK_ID || "";
  if (v === "") return "testnet";
  if (v === "testnet" || v === "mainnet") return v;
  throw new Error(`unknown NETWORK_ID "${v}" (expected testnet or mainnet)`);
}

export function resolveRegistryUrl(env: EnvLike): string {
  const override = env.REGISTRY_URL || env.VITE_REGISTRY_URL;
  if (override) return override;
  return resolveNetworkId(env) === "mainnet" ? MAINNET_REGISTRY_URL : TESTNET_REGISTRY_URL;
}

export function resolveSourcecheckUrl(env: EnvLike): string {
  const override = env.SOURCECHECK_URL || env.VITE_SOURCECHECK_URL;
  if (override) return override;
  return resolveNetworkId(env) === "mainnet" ? MAINNET_SOURCECHECK_URL : TESTNET_SOURCECHECK_URL;
}

export const isSourcecheckPlaceholder = (url: string): boolean => url === MAINNET_SOURCECHECK_URL;

/** Deploy-ready check (run at `vite build`): a build whose source-check URL is still the mainnet placeholder is refused.
 *  MAINPREP: an explicit SOURCECHECK_URL / VITE_SOURCECHECK_URL (even equal to MAINNET_SOURCECHECK_URL) is the operator asserting the
 *  Worker is deployed (build:mainnet sets it); only the implicit default is refused. */
export function assertSourcecheckDeployReady(env: EnvLike): void {
  const explicit = !!(env.SOURCECHECK_URL || env.VITE_SOURCECHECK_URL);
  if (!explicit && isSourcecheckPlaceholder(resolveSourcecheckUrl(env))) {
    throw new Error("sourcecheck URL is still the mainnet placeholder: deploy the mainnet sourcecheck Worker and set MAINNET_SOURCECHECK_URL (or VITE_SOURCECHECK_URL)");
  }
}

// Merged env: process.env (node) overlaid on import.meta.env (vite, VITE_* only). Either may be absent.
export function readBuildEnv(): EnvLike {
  const viteEnv = ((import.meta as unknown as { env?: EnvLike }).env) ?? {};
  const procEnv = typeof process !== "undefined" ? (process.env ?? {}) : {};
  return { ...viteEnv, ...procEnv };
}

// MAINPREP: build-time network constant. vite.config.ts `define: buildDefines(env)` replaces __PRAETORIAL_BUILD_NETWORK__ with a string
// literal, so `MAINNET_ONLY_BUILD` folds to `true` in a mainnet bundle and Rollup drops the testnet-only tables gated on it
// (lib/network.ts, lib/assets.ts, lib/releaseConfig.ts, lib/refereeRegistry.ts). In node/tests the identifier is undeclared => false.
declare const __PRAETORIAL_BUILD_NETWORK__: string | undefined;
/** NAV1: with the vite `command`, also __PRAETORIAL_TEST_HOOKS__ (lib/testHooks.ts): false for a mainnet production build
 *  (`vite build` with NETWORK_ID=mainnet) unless VITE_E2E_HOOKS=1 (local screenshots only; the deploy guard refuses such a bundle). */
export function buildDefines(env: EnvLike): { __PRAETORIAL_BUILD_NETWORK__: string };
export function buildDefines(env: EnvLike, command: "build" | "serve"): { __PRAETORIAL_BUILD_NETWORK__: string; __PRAETORIAL_TEST_HOOKS__: string };
export function buildDefines(env: EnvLike, command?: "build" | "serve"): Record<string, string> {
  const net = resolveNetworkId(env);
  if (!command) return { __PRAETORIAL_BUILD_NETWORK__: JSON.stringify(net) };
  return { __PRAETORIAL_BUILD_NETWORK__: JSON.stringify(net), __PRAETORIAL_TEST_HOOKS__: JSON.stringify(testHooksOn(env, command)) };
}
export function testHooksOn(env: EnvLike, command: "build" | "serve"): boolean {
  return !(resolveNetworkId(env) === "mainnet" && command === "build") || env.VITE_E2E_HOOKS === "1";
}
export const MAINNET_ONLY_BUILD: boolean = typeof __PRAETORIAL_BUILD_NETWORK__ !== "undefined" && __PRAETORIAL_BUILD_NETWORK__ === "mainnet";

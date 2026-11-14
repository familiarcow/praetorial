// DR6FIX1: the ONE loader every live-DR scenario uses (DR1/DR5/DR6 webConfig.ts re-export it). Single-sources the escrow /
// intents / token ids from apps/web/lib (what the web build uses) WITHOUT putting apps/web inside the services tsc program
// (rootDir): the module is loaded at runtime by absolute file URL and its shape is validated from `unknown`.
// It imports the .ts SOURCE files that exist on disk (DR5 065ae35c, proven live): the Playwright loader does not remap a
// dynamic `network.js` file URL to `network.ts` (tsx does, so node:test runs hid the bug). Test:
// harness/test/webConfig.test.ts (strict, Playwright-like importer).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/web/lib");

export interface WebTestnetConfig { escrow: string; intents: string; usdcTokenId: string; stakeToken: string }
export type ModuleImporter = (fileUrl: string) => Promise<unknown>;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
function str(v: unknown, what: string): string {
  if (typeof v !== "string" || !v) throw new Error(`apps/web/lib: ${what} is not a non-empty string`);
  return v;
}

/** file:// URL of an apps/web/lib TypeScript source module (the file that exists; never a .js specifier). */
export function webLibModuleUrl(name: "network" | "assets"): string {
  return pathToFileURL(path.join(WEB_LIB, `${name}.ts`)).href;
}

export async function loadWebTestnetConfig(importer: ModuleImporter = (u) => import(u)): Promise<WebTestnetConfig> {
  const net: unknown = await importer(webLibModuleUrl("network"));
  const assets: unknown = await importer(webLibModuleUrl("assets"));
  if (!isRec(net) || !isRec(net.NETWORKS) || !isRec(net.NETWORKS.testnet)) throw new Error("apps/web/lib/network: NETWORKS.testnet missing");
  if (!isRec(assets) || typeof assets.assetId !== "function") throw new Error("apps/web/lib/assets: assetId missing");
  const t = net.NETWORKS.testnet;
  const assetId = assets.assetId as (symbol: string, network: string) => unknown;
  return {
    escrow: str(t.escrow, "NETWORKS.testnet.escrow"),
    intents: str(t.intents, "NETWORKS.testnet.intents"),
    usdcTokenId: str(t.usdcTokenId, "NETWORKS.testnet.usdcTokenId"),
    stakeToken: str(assetId("NEAR", "testnet"), 'assetId("NEAR","testnet")'),
  };
}

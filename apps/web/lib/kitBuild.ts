// K0 (UIR1 §2.3, familiarcow UX-37 #10): the /kit playground is compiled only into VITE_KIT=1 builds and NEVER into a mainnet bundle.
// vite.config.ts defines __PRAETORIAL_KIT__ from kitMode(); src/main.tsx gates the playground's dynamic import on that literal, so
// in every other build the branch folds to `false` and Rollup drops the import and the whole src/kit/Playground chunk.
//   "off"   - normal builds (and any mainnet build): no playground code at all;
//   "route" - VITE_KIT=1: the app, plus the playground at /kit (local dev: `VITE_KIT=1 npm run dev`);
//   "only"  - VITE_KIT=1 KIT_ONLY=1 (`npm run build:kit`): a static preview that is only the playground, on every path, with
//             every network request refused (src/kit/kitEntry.tsx), for a separate non-mainnet preview URL.
import { resolveNetworkId, type EnvLike } from "./networkSelect";

export type KitMode = "off" | "route" | "only";
export const KIT_PATH = "/kit";

export function kitMode(env: EnvLike): KitMode {
  if (env.VITE_KIT !== "1") return "off";
  if (resolveNetworkId(env) === "mainnet") throw new Error("K0: VITE_KIT=1 is never allowed with a mainnet network (the /kit playground must not ship in a mainnet build)");
  return env.KIT_ONLY === "1" ? "only" : "route";
}

export function kitDefines(env: EnvLike): { __PRAETORIAL_KIT__: string } {
  return { __PRAETORIAL_KIT__: JSON.stringify(kitMode(env)) };
}

export function isKitPath(pathname: string): boolean {
  return pathname === KIT_PATH || pathname.startsWith(`${KIT_PATH}/`);
}

/** The kit preview's network rule: only this page's own static files (same origin, not an app proxy/API path) may load. */
export function blockedRequest(url: string, origin: string): boolean {
  let u: URL;
  try { u = new URL(url, origin); } catch { return true; }
  if (u.origin !== origin) return true;
  return /^\/(_proxy|api|functions)(\/|$)/.test(u.pathname);
}

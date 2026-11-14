// Shared miniflare harness for relayer worker tests (functional: worker.miniflare.test.ts; wall budget: test-budget/).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { outboundFetch, workerBindings, type Rpc } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const bundle = async () => (await build({ entryPoints: [path.join(HERE, "../src/index.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent" })).outputFiles[0].text;
export const start = (script: string, w: Rpc, persist: string, extra: Record<string, string> = {}) => new Miniflare({
  modules: true, script, compatibilityDate: "2026-01-01",
  durableObjects: { RELAYER: { className: "RelayerDO", useSQLite: true } }, durableObjectsPersist: persist,
  bindings: workerBindings(extra), outboundService: outboundFetch(w) as any,
});
export const relay = async (mf: Miniflare, base64: string) => { const r = await mf.dispatchFetch("https://relayer.test/relay", { method: "POST", body: JSON.stringify({ signedDelegate: base64 }) }); return { status: r.status, json: (await r.json()) as any }; };


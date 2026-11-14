import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fetchVenuePrice } from "./lib/tickerVenues";
import { handle as handleWorker } from "./worker/index";
import { assertSourcecheckDeployReady, buildDefines } from "./lib/networkSelect";
import { kitDefines } from "./lib/kitBuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Tiny dev-only ticker proxy (task brief #2: "handle CORS with a tiny
// dev proxy"). Forwards GET /api/ticker?venue=coinbase|binance|bitstamp|
// kraken|gemini|okx|bybit to each exchange's real public ticker endpoint
// server-side (no CORS issue from Node) and returns { venue, price }.
// Never adds auth, never touches any other path. functions/api/ticker.ts
// is the production (Cloudflare Pages Functions) equivalent of this same
// proxy, sharing the venue map/parser/fallback-chain from
// lib/tickerVenues.ts so dev and prod never drift.
function tickerProxyPlugin(): Plugin {
  return {
    name: "ticker-proxy",
    configureServer(server) {
      server.middlewares.use("/api/ticker", async (req, res) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const venue = url.searchParams.get("venue") ?? "";
        const { price, error } = await fetchVenuePrice(venue);
        res.setHeader("content-type", "application/json");
        if (error && price === null) {
          res.statusCode = error === "unknown venue" ? 400 : 502;
          res.end(JSON.stringify({ venue, error }));
          return;
        }
        res.end(JSON.stringify({ venue, price }));
      });
    },
  };
}

// TPL2: the same GET-only NHL schedule proxy the web Worker serves (worker/index.ts handleSports), so `npm run dev` works too.
// The mocked Playwright server sets PRAETORIAL_SPORTS_PROXY=off: an unmocked picker fetch then fails (502) instead of reaching the network.
function sportsProxyPlugin(): Plugin {
  return {
    name: "praetorial-sports-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!(req.url ?? "").startsWith("/_proxy/sports")) return next();
        const { handleSports } = await import("./worker/index");
        const url = new URL(req.url ?? "", "http://localhost");
        const off = process.env.PRAETORIAL_SPORTS_PROXY === "off";
        const r = await handleSports(new Request(url, { method: req.method }), url, off ? (async () => new Response("off", { status: 503 })) as typeof fetch : fetch);
        res.statusCode = r.status;
        r.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await r.arrayBuffer()));
      });
    },
  };
}

// K0: __PRAETORIAL_KIT__ (lib/kitBuild.ts). Merged into `define` by Vite; kitMode throws for VITE_KIT=1 with a mainnet network.
function kitDefinePlugin(env: Record<string, string | undefined>): Plugin {
  return { name: "praetorial-kit-define", config: () => ({ define: kitDefines(env) }) };
}

// V1: the public checker (repo-root scripts/verify-bet.mjs, no dependencies) served by the site itself at /verify-bet.mjs, so anyone
// can download it from About › How to verify a bet (the source repo is not public yet). One file, no copy: emitted at build,
// served from the same path in dev.
const VERIFY_SCRIPT_PATH = fileURLToPath(new URL("../../scripts/verify-bet.mjs", import.meta.url));
function verifyScriptPlugin(): Plugin {
  return {
    name: "praetorial-verify-script",
    configureServer(server) {
      server.middlewares.use("/verify-bet.mjs", (_req, res) => { res.setHeader("content-type", "text/javascript; charset=utf-8"); res.end(readFileSync(VERIFY_SCRIPT_PATH, "utf8")); });
    },
    generateBundle() { this.emitFile({ type: "asset", fileName: "verify-bet.mjs", source: readFileSync(VERIFY_SCRIPT_PATH, "utf8") }); },
  };
}

// TPL1: dev-only /_proxy/kraken (Kraken's public market data has no CORS). Same handler as the production worker
// (worker/index.ts), so the two never drift.
function krakenProxyPlugin(): Plugin {
  return {
    name: "kraken-proxy",
    configureServer(server) {
      server.middlewares.use("/_proxy/kraken", async (req, res) => {
        try {
          const r = await handleWorker(new Request(`http://dev.local/_proxy/kraken${req.url ?? "/"}`, { method: req.method }), { ASSETS: { fetch: async () => new Response("", { status: 404 }) } });
          res.statusCode = r.status;
          r.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) { res.statusCode = 502; res.end(String(e)); }
      });
    },
  };
}

// Minimal dev server for the Option-1 round-trip test app. Port fixed
// at 3000 per the task spec; Playwright drives this exact origin.
export default defineConfig(({ command, mode }) => {
  // WEBSRC1: refuse a build whose source-check URL is still the mainnet placeholder.
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  if (command === "build") assertSourcecheckDeployReady(env);
  return {
  // K0: kitDefinePlugin adds __PRAETORIAL_KIT__ (the /kit playground only for VITE_KIT=1; never with a mainnet network).
  plugins: [react(), tickerProxyPlugin(), krakenProxyPlugin(), sportsProxyPlugin(), kitDefinePlugin(env), verifyScriptPlugin()],
  // MAINPREP: __PRAETORIAL_BUILD_NETWORK__ lets Rollup drop the testnet-only tables from a mainnet bundle (lib/networkSelect.ts).
  // NAV1: ... and __PRAETORIAL_TEST_HOOKS__ compiles the mocked-e2e window seams out of a mainnet production bundle (lib/testHooks.ts).
  define: buildDefines(env, command),
  server: {
    // Overridable via `vite --port N` (used when 3000 is taken by a
    // concurrent worktree's dev server); defaults to 3000 per spec.
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
};
});

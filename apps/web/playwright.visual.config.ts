// Q1 (UIR1 §4 Q1): the screenshot regression gate. `npx playwright test -c playwright.visual.config.ts` (test.sh fast runs it).
// Every screen and state of the app at 375 and 1280 px against a MAINNET bundle with the test seams on (VITE_E2E_HOOKS=1: a
// screenshot-only bundle the deploy guard refuses; never deployed), served by `vite preview`, every network call mocked or blocked
// (tests/visual/world.ts). Each screen asserts no horizontal scroll and no raw id / base units / nep141: on screen (tests/visual/gate.ts).
// Screenshots: test-results/visual/ (gitignored); VISUAL_SHOTS=<dir> writes them elsewhere. Specs are *.visual.ts so the default
// playwright.config.ts (*.spec.ts) never loads them.
import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// One port for the whole run: the config is evaluated again in each worker, which inherits this env.
process.env.VISUAL_PORT ??= execFileSync("node", ["scripts/free-port.mjs"], { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" }).trim();
const port = Number(process.env.VISUAL_PORT);
const dist = join(tmpdir(), `praetorial-visual-${port}`);
const env = [
  "NETWORK_ID=mainnet", "VITE_NETWORK_ID=mainnet", "VITE_E2E_HOOKS=1",
  "VITE_INDEXER_URL=/_proxy/indexer", "VITE_RELAYER_URL=/_proxy/relayer", "VITE_REGISTRY_URL=/_proxy/registry",
  // The mainnet funding Worker is not configured in the deployed build yet; the gate points the bundle at a mocked one so the Add money,
  // Cash out and Convert screens are covered (tests/visual/world.ts FUNDING).
  "VITE_FUNDING_URL=https://funding.praetorial.com",
  "VITE_SOURCECHECK_URL=https://sourcecheck.praetorial.com/sourcecheck",
].join(" ");

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: "**/*.visual.ts",
  timeout: 90_000,
  fullyParallel: true,
  workers: process.env.VISUAL_WORKERS ? Number(process.env.VISUAL_WORKERS) : 4,
  reporter: [["list"]],
  outputDir: "test-results/visual-artifacts",
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    // Never capture artifacts automatically (same rule as playwright.config.ts); the gate writes its own screenshots.
    trace: "off", video: "off", screenshot: "off",
    actionTimeout: 8_000, navigationTimeout: 20_000,
  },
  webServer: {
    command: `env ${env} npx vite build --outDir ${dist} --emptyOutDir --logLevel error >/dev/null 2>&1 && npx vite preview --outDir ${dist} --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

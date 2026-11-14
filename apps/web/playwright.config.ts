import { defineConfig } from "@playwright/test";

// Headless only. Tracing/video/screenshots are OFF everywhere --
// the login step fills a real test email + OTP into the DOM, and we
// never want that captured into an artifact file even locally.
//
// Two modes (FE1):
//   default            `npm run test:e2e`       every spec EXCEPT those tagged @live (fully mocked; CI-safe).
//   PW_LIVE=1          `npm run test:e2e:live`  ONLY the @live specs: they need a real Privy test login
//                                              (PRIVY_TEST_EMAIL / PRIVY_TEST_OTP) and use port 3000.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const live = !!process.env.PW_LIVE;

export default defineConfig({
  testDir: "./tests",
  // Only *.spec.ts are Playwright specs; *.unit.test.ts belong to `npm test` (node:test) and must not be loaded here.
  testMatch: "**/*.spec.ts",
  timeout: 150_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  ...(live ? { grep: /@live/ } : { grepInvert: /@live/ }),
  use: {
    // Overridable so a concurrent worktree's dev server on the default
    // port doesn't collide with this one's test run.
    baseURL,
    trace: "off",
    video: "off",
    screenshot: "off",
    headless: true,
  },
  // Starts vite on PLAYWRIGHT_BASE_URL's port when nothing is listening there (CI); reuses a running dev server.
  webServer: {
    command: `npx vite --port ${new URL(baseURL).port || "80"} --strictPort`,
    url: baseURL,
    // PW_CI=1 (set by test.sh): never reuse a foreign server (another worktree's vite); a busy port fails loudly.
    reuseExistingServer: !process.env.PW_CI,
    // WEBNET1: mocked specs route the local indexer/relayer ports; the testnet default is now the live Workers, so the
    // env override (VITE_*, wins per field) points the dev server at the mocked origins. Specs themselves are unchanged.
    env: { PRAETORIAL_SPORTS_PROXY: live ? "" : "off", VITE_INDEXER_URL: "http://localhost:8787", VITE_RELAYER_URL: "http://localhost:8788", ...(live ? {} : { VITE_SOURCECHECK_URL: "http://localhost:8790/sourcecheck" }) }, // @live specs use the real network-selected sourcecheck Worker
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

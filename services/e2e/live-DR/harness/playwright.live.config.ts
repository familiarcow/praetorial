// DR0 part 4: Playwright LIVE config for the dress rehearsal. Separate from apps/web/playwright.config.ts (the mocked
// one behind `npm run test:e2e`); run explicitly: `npx playwright test -c services/e2e/live-DR/harness/playwright.live.config.ts`
// from apps/web (where @playwright/test is installed). Never part of `npm run test:e2e` or ./test.sh fast.
//
// Tracing / video / screenshots are OFF: the maker's login types a real email + one-time code into the DOM and none
// of it may land in an artifact. This file reads no login code and no secret, and logs nothing. Specs are *.live.spec.ts
// (a name no node:test glob matches). The dev server is started by hand; only its URL is configured here.
// Plain object (no @playwright/test import) so `services` tsc / node:test can load it without that dependency.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const use = { baseURL, trace: "off", video: "off", screenshot: "off", headless: true } as const;

export default {
  testDir: dirname(dirname(fileURLToPath(import.meta.url))), // live-DR/: the harness dir plus each scenario dir (DR5/..., DR6/...)
  testMatch: "**/*.live.spec.ts",
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use,
  // one project per party; taker and referee sign through window.__e2eTestWallet (liveContexts.ts), the maker via Privy
  projects: [
    { name: "maker", use: { ...use, browserName: "chromium" } },
    { name: "taker", use: { ...use, browserName: "chromium" } },
    { name: "referee", use: { ...use, browserName: "chromium" } },
  ],
};

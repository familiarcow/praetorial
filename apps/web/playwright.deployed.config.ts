import { defineConfig } from "@playwright/test";

// WEBDEP1: smoke against the DEPLOYED testnet Worker. Separate config so the default mocked run and ./test.sh fast never
// touch it (the default config also has no @deployed specs: tests/deployed/ is outside its testMatch via grepInvert).
// Usage: DEPLOYED_URL=https://praetorial-web-testnet.<subdomain>.workers.dev npm run test:deployed
const baseURL = process.env.DEPLOYED_URL;
if (!baseURL) throw new Error("DEPLOYED_URL is required (the workers.dev URL of praetorial-web-testnet)");

export default defineConfig({
  testDir: "./tests/deployed",
  testMatch: "**/*.deployed.ts",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL, trace: "off", video: "off", screenshot: "off", headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

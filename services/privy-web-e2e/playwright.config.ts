import { defineConfig } from "@playwright/test";

// Headless only. Tracing/video/screenshots are OFF everywhere --
// the login step fills a real test email + OTP into the DOM, and we
// never want that captured into an artifact file even locally.
export default defineConfig({
  testDir: "./tests",
  timeout: 150_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "off",
    video: "off",
    screenshot: "off",
    headless: true,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

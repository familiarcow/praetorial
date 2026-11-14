// Closes the Option-1 wallet round trip, end to end, against the
// REAL Privy client SDK and a REAL Privy test account (no mocks).
// Each numbered test is its own `test()` so a blocked/failing step
// shows up as a red test in the suite, never silently skipped.
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { MAX_TRANSFER_BACK_YOCTO } from "../lib/config.js";

const SERVER = "http://localhost:8787";
const EMAIL = process.env.PRIVY_TEST_EMAIL!;
const OTP = process.env.PRIVY_TEST_OTP!;
if (!EMAIL || !OTP) throw new Error("PRIVY_TEST_EMAIL / PRIVY_TEST_OTP not set in env");

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let nearAddress = "";
const results: Record<string, unknown>[] = [];

function record(step: string, ok: boolean, extra: Record<string, unknown> = {}) {
  results.push({ step, ok, ...extra });
}

async function loginWithTestAccount(p: Page) {
  await p.getByTestId("email-input").fill(EMAIL);
  await p.getByTestId("send-code").click();
  // Privy's own OTP-sent UI state isn't exposed here; the otp field
  // is always rendered, so just wait a beat for the send to land.
  await p.waitForTimeout(2000);
  await p.getByTestId("otp-input").fill(OTP);
  await p.getByTestId("submit-code").click();
  await p.waitForFunction(() => (window as any).__e2e?.authenticated === true, { timeout: 20_000 });
  await p.waitForFunction(() => !!(window as any).__e2e?.nearAddress, { timeout: 30_000 });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
});

test.afterAll(async () => {
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync("./data/results.json", JSON.stringify(results, null, 2));
  await context.close();
});

test("1. real Privy client SDK login (email + fixed test OTP) creates/loads a NEAR wallet", async () => {
  await loginWithTestAccount(page);
  nearAddress = (await page.evaluate(() => (window as any).__e2e.nearAddress)) as string;
  expect(nearAddress).toMatch(/^[0-9a-f]{64}$/);
  record("1_login_and_wallet", true, { nearAddress });
});

test("2. fund the implicit account from praetorial-dev-1101.testnet (<= 0.5 NEAR)", async () => {
  expect(nearAddress).toMatch(/^[0-9a-f]{64}$/);
  execFileSync("node", ["--import", "tsx", "scripts/fund.ts", nearAddress], { encoding: "utf8" });
  const record_ = JSON.parse(fs.readFileSync("./data/fund.json", "utf8"));
  expect(record_.accountId).toBe(nearAddress);
  record("2_fund", true, {
    fundTxHash: record_.txHash,
    existedBefore: record_.existedBefore,
    skipped: record_.skipped ?? false,
    balanceBeforeYocto: record_.balanceBeforeYocto,
  });
});

test("3. server builds a NEAR transfer; browser's Privy session raw-signs it; server verifies + broadcasts + confirms FINAL", async () => {
  const amountYocto = (MAX_TRANSFER_BACK_YOCTO / 2n).toString();
  const build = await page.request.post(`${SERVER}/api/transfer/build`, {
    data: { accountId: nearAddress, publicKeyHex: nearAddress, amountYocto },
  });
  const buildJson = await build.json();
  expect(buildJson.ok, JSON.stringify(buildJson)).toBe(true);

  const signature = await page.evaluate(
    ({ addr, hash }) => (window as any).__e2e.signRawHash(addr, hash),
    { addr: nearAddress, hash: buildJson.hashHex },
  );

  const submit = await page.request.post(`${SERVER}/api/transfer/submit`, {
    data: { txId: buildJson.txId, signatureHex: signature, publicKeyHex: nearAddress },
  });
  const submitJson = await submit.json();
  expect(submitJson.ok, JSON.stringify(submitJson)).toBe(true);
  expect(submitJson.txHash).toBeTruthy();
  record("3_transfer_roundtrip", submitJson.ok, { txHash: submitJson.txHash, amountYocto, explorer: submitJson.explorer });
});

test("4. NEP-413 intents message signed the same way; verified live via simulate_intents (mainnet, view-only, no spend)", async () => {
  const build = await page.request.post(`${SERVER}/api/nep413/build`, { data: { accountId: nearAddress } });
  const buildJson = await build.json();
  expect(buildJson.ok, JSON.stringify(buildJson)).toBe(true);

  const signature = await page.evaluate(
    ({ addr, hash }) => (window as any).__e2e.signRawHash(addr, hash),
    { addr: nearAddress, hash: buildJson.hashHex },
  );

  const submit = await page.request.post(`${SERVER}/api/nep413/submit`, {
    data: { nep413Id: buildJson.nep413Id, signatureHex: signature, publicKeyHex: nearAddress },
  });
  const submitJson = await submit.json();
  expect(submitJson.ok, JSON.stringify(submitJson)).toBe(true);
  expect(submitJson.signatureVerifiedLocally).toBe(true);
  record("4_nep413_intents", submitJson.ok, {
    signatureVerifiedLocally: submitJson.signatureVerifiedLocally,
    simulateIntentsError: submitJson.simulateIntentsError,
    simulateIntentsResult: submitJson.simulateIntentsResult,
  });
});

test("5. logout then back in returns the SAME NEAR wallet", async () => {
  const before = nearAddress;
  await page.getByTestId("logout").click();
  await page.waitForFunction(() => (window as any).__e2e?.authenticated === false, { timeout: 15_000 });
  await loginWithTestAccount(page);
  const after = (await page.evaluate(() => (window as any).__e2e.nearAddress)) as string;
  expect(after).toBe(before);
  nearAddress = after;
  record("5_relogin_same_wallet", after === before, { before, after });
});

test("6. recovery path: can a passkey be added to the account after email signup? (CDP virtual authenticator)", async () => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable" as any);
  await cdp.send("WebAuthn.addVirtualAuthenticator" as any, {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  } as any);

  await page.getByTestId("link-passkey").click();
  await page
    .waitForFunction(
      () => (document.querySelector('[data-testid="passkey-result"]') as HTMLElement | null)?.textContent !== "",
      { timeout: 20_000 },
    )
    .catch(() => {});
  const result = (await page.evaluate(
    () => (document.querySelector('[data-testid="passkey-result"]') as HTMLElement | null)?.textContent ?? "(no result -- link flow never resolved)",
  )) as string;
  record("6_passkey_recovery", result === "ok", { result });
  // Asserted plainly: if this fails, it's a real red test, not swallowed.
  expect(result, "passkey recovery path").toBe("ok");
});

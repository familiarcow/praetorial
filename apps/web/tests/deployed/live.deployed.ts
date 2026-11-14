// LIVE1 @live: the deployed testnet site, real Privy login + signing, real Workers, real testnet contracts.
// Run via scripts/live-testnet-e2e.sh (or: DEPLOYED_URL=... npx playwright test -c playwright.deployed.config.ts --grep @live).
// Assertions are on chain state (RPC views), not just UI text. Every tx hash is appended to $LIVE_OUT (JSONL).
// Never skipped: missing credentials fail loudly.
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { viewFunction, viewAccountBalanceYocto } from "../../lib/rpc";
import { fromBaseUnits } from "../../lib/decimal";
import { INTENTS_CONTRACT_ID } from "../../lib/config";
import { HttpUserRegistry } from "../../lib/refereeRegistry";
import { TESTNET_REGISTRY_URL } from "../../lib/networkSelect";
import { utcToLocalInput } from "../../lib/betDetails";
import { openMoreOptions } from "../betDetailsHelpers";
import { fetchHistory } from "../../lib/indexerClient";
import { KeyPair } from "@near-js/crypto";
import AxeBuilder from "@axe-core/playwright";
import { screenPath } from "../lib/screens";
import { getBet } from "../../lib/escrowAdapter";
import { indexWaitMs, INDEXER_TICK_MS, INDEXER_BATCH_BETS } from "../lib/indexerCadence";

const EMAIL = process.env.PRIVY_TEST_EMAIL;
const OTP = process.env.PRIVY_TEST_OTP;
const OUT = process.env.LIVE_OUT;
const DEV = "praetorial-dev-1101.testnet";
const WNEAR = "nep141:wrap.testnet";
const record = (o: Record<string, unknown>) => { if (OUT) fs.appendFileSync(OUT, JSON.stringify({ suite: "@live-ui", at: new Date().toISOString(), ...o }) + "\n"); };

async function devTransfer(to: string, near: string): Promise<string> {
  const out = execFileSync("npx", ["tsx", "tests/live/devFund.ts", to, near], { cwd: process.cwd(), encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!).tx;
}
const intents = async (acct: string, token: string) => BigInt(String((await viewFunction<string>(INTENTS_CONTRACT_ID, "mt_balance_of", { account_id: acct, token_id: token })) ?? "0"));
const wnearInWallet = async (acct: string) => BigInt(String((await viewFunction<string>("wrap.testnet", "ft_balance_of", { account_id: acct })) ?? "0"));

// MODAL1d: per-step screenshots at 375 (sheet) and 1280 (dialog), written only with UPDATE_SCREENS=1 (SHOTS1: a plain run leaves git clean).
// Every captured step also gets an axe check (0 serious/critical) so the live run proves the same a11y bar as the mocked specs.
async function shot(p: Page, name: string) {
  for (const [label, size] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 720 }]] as const) {
    await p.setViewportSize(size);
    await p.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
    const bad = (await new AxeBuilder({ page: p }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 100)}`), `axe at ${label}px on ${name}`).toEqual([]);
    if (process.env.UPDATE_SCREENS === "1") await p.screenshot({ path: screenPath(`modal1d/${name}-${label}.png`) });
  }
  await p.setViewportSize({ width: 1280, height: 720 });
}
// MODAL1c5 moved "Move to betting balance" into a modal (terms -> move-confirm -> flow-success/flow-failure); the old inline move-status is gone.
async function moveNear(p: Page): Promise<string | null> {
  await expect(p.getByTestId("move-NEAR-native")).toBeVisible({ timeout: 30_000 });
  await p.getByTestId("move-NEAR-native").click();
  await expect(p.locator("dialog[open]").last().getByTestId("move-terms")).toBeVisible();
  await p.locator("dialog[open]").last().getByTestId("move-confirm").click();
  const d = p.locator("dialog[open]").last();
  await expect(d.getByTestId("flow-success").or(d.getByTestId("flow-failure"))).toBeVisible({ timeout: 120_000 });
  const detail = (await d.getByTestId("move-error-detail").count()) ? ` [${await d.getByTestId("move-error-detail").textContent()}]` : "";
  const text = ((await d.getByTestId("move-result").textContent()) ?? "") + detail;
  await d.getByTestId("flow-done").or(d.getByTestId("flow-retry")).first().click().catch(() => undefined);
  return text;
}
const dlg = (p: Page) => p.locator("dialog[open]").last();
let liveBetId = Number(process.env.LIVE_BET_ID ?? 0); // set by @live 5, read by @live 6 (or pass LIVE_BET_ID to run 6 alone)

test.describe.configure({ mode: "serial" });
test.describe("@live deployed testnet: real user", () => {
  test.setTimeout(240_000);
  let page: Page;
  let me = "";

  test.beforeAll(async ({ browser }) => {
    if (!EMAIL || !OTP) throw new Error("PRIVY_TEST_EMAIL / PRIVY_TEST_OTP not set (source $PRAETORIAL_SECRETS_DIR/praetorial-privy.env)");
    page = await (await browser.newContext()).newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log(`[browser] ${m.text().slice(0, 300)}`); });
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, undefined, { timeout: 30_000 });
  });

  async function login() {
    await page.getByTestId("email-input").fill(EMAIL!);
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("otp-input")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("otp-input").fill(OTP!);
    await page.getByTestId("submit-code").click();
    await page.waitForFunction(() => (window as any).__e2e?.authenticated === true, undefined, { timeout: 30_000 });
    // 20s app timeout + margin: must resolve on its own (no reload), or show the error with Try again.
    await page.waitForFunction(() => /^[0-9a-f]{64}$/.test((window as any).__e2e?.nearAddress ?? "") || /wallet-error/.test((window as any).__e2e?.status ?? ""), undefined, { timeout: 30_000 });
    me = await page.evaluate(() => (window as any).__e2e.nearAddress);
    expect(me).toMatch(/^[0-9a-f]{64}$/);
    record({ step: "login", account: me });
  }

  test("@live 1. Privy login -> NEAR wallet resolves without a refresh (LIVE1 3a)", async () => {
    await login();
  });

  test("@live 2. username: the account has (or claims) a username on the deployed registry", async () => {
    const reg = new HttpUserRegistry(TESTNET_REGISTRY_URL);
    let u = await reg.byAccount(me);
    if (!u) {
      await expect(page.getByTestId("username-input")).toBeVisible({ timeout: 20_000 });
      const name = `live1${Date.now().toString(36)}`;
      await page.getByTestId("username-input").fill(name);
      await page.getByTestId("username-claim-btn").click();
      await expect(page.getByTestId("username-input")).toHaveCount(0, { timeout: 30_000 });
      u = await reg.byAccount(me);
      expect(u?.username ?? (u as any)?.name).toBe(name);
    }
    expect(u).toBeTruthy();
    record({ step: "username", account: me, user: u });
  });

  test("@live 3. Move NEAR from wallet to Escrow balance: the whole wrapped amount lands on intents (LIVE1 2a/2b)", async () => {
    const fundTx = await devTransfer(me, "0.3");
    record({ step: "fund-wallet", account: me, tx: fundTx, near: "0.3" });
    const before = await intents(me, WNEAR);
    // RELAYDEP1 / D-RELAYDEP1: the wrap carries the user's NEAR, so the USER pays it. The relayer balance may only move by gas.
    const RELAYER_ACCT = "relayer.praetorial-dev-1101.testnet";
    const relayerBefore = (await viewAccountBalanceYocto(RELAYER_ACCT))!;
    const sent: string[] = [];
    page.on("response", async (r) => { if (r.request().method() === "POST" && /rpc/.test(r.url())) { const b = r.request().postData() ?? ""; if (b.includes("send_tx")) sent.push((await r.text().catch(() => "")).slice(0, 300)); } });
    await page.goto("/add-money");
    const mv = await moveNear(page);
    expect(mv, `move failed: ${mv}`).toBe("Moved to your betting balance.");
    const relayerAfter = (await viewAccountBalanceYocto(RELAYER_ACCT))!;
    // Gas only (a 1-yocto relayed ft_transfer_call): the 0.25 NEAR deposit must NOT have left the relayer.
    expect(relayerBefore - relayerAfter < 10_000_000_000_000_000_000_000n, `relayer balance fell by ${relayerBefore - relayerAfter}`).toBe(true);
    record({ step: "move-near-relayer-balance", account: me, relayerBefore: relayerBefore.toString(), relayerAfter: relayerAfter.toString() });
    console.log(`RELAYDEP1 direct send_tx responses: ${sent.join(" | ")}`);
    console.log(`RELAYDEP1 relayer before=${relayerBefore} after=${relayerAfter}`);
    const after = await intents(me, WNEAR);
    // At least the funded 0.3 NEAR minus the 0.05 NEAR reserve and wrap's 0.00125 storage fee arrived.
    expect(after - before >= 248_000_000_000_000_000_000_000n, `intents wNEAR grew by ${after - before}`).toBe(true);
    expect(await wnearInWallet(me)).toBe(0n); // nothing stranded
    record({ step: "move-near", account: me, intentsBefore: before.toString(), intentsAfter: after.toString() });
  });

  test("@live 4. Withdraw to wallet (LIVE2 WITHDRAW1): wallet wNEAR rises and the Escrow balance falls by EXACTLY the amount", async () => {
    const amount = 100_000_000_000_000_000_000_000n; // 0.1 NEAR
    const intentsBefore = await intents(me, WNEAR);
    expect(intentsBefore >= amount, `needs >= 0.1 wNEAR on intents, has ${intentsBefore}`).toBe(true);
    const walletBefore = await wnearInWallet(me);
    await page.goto("/add-money");
    await expect(page.getByTestId("withdraw-btn-NEAR")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("withdraw-btn-NEAR").click();
    await page.getByTestId("withdraw-amount-NEAR").fill("0.1");
    await shot(page, "withdraw-1-amount");
    await page.getByTestId("withdraw-review").click();
    await expect(dlg(page).getByTestId("withdraw-terms")).toBeVisible();
    await shot(page, "withdraw-2-review");
    await page.getByTestId("withdraw-confirm").click();
    const d4 = dlg(page);
    await expect(d4.getByTestId("flow-success").or(d4.getByTestId("flow-failure"))).toBeVisible({ timeout: 150_000 });
    const err = await d4.getByTestId("withdraw-error-detail").count() ? await d4.getByTestId("withdraw-error-detail").textContent() : null;
    expect(err, `withdraw failed: ${err}`).toBeNull();
    await expect(d4.getByTestId("withdraw-result")).toContainText("is in your wallet");
    await shot(page, "withdraw-3-done");
    const walletAfter = await wnearInWallet(me);
    const intentsAfter = await intents(me, WNEAR);
    expect(walletAfter - walletBefore).toBe(amount);
    expect(intentsBefore - intentsAfter).toBe(amount);
    record({ step: "withdraw-near", account: me, amount: amount.toString(), walletBefore: walletBefore.toString(), walletAfter: walletAfter.toString(), intentsBefore: intentsBefore.toString(), intentsAfter: intentsAfter.toString() });
  });

  test("@live 5. Open a person-decided (named human referee) bet through the deployed UI with 2 readable sources (SRCREF1d)", async () => {
    test.setTimeout(420_000);
    if (!me) await login(); // running alone (--grep '@live 5'): same Privy login as @live 1
    const STAKE = "2.75"; // the testnet minimum stake is ~2.72 NEAR (stake-limits line); testnet NEAR is uncapped (D-TNEAR1)
    const NEED = 3_000_000_000_000_000_000_000_000n; // stake + storage deposit headroom
    // The Escrow balance must already hold the stake (+ storage deposit). If not, move some first exactly like @live 3.
    if ((await intents(me, WNEAR)) < NEED) {
      record({ step: "fund-wallet", account: me, tx: await devTransfer(me, "3.5"), near: "3.5", for: "live5" });
      await page.goto("/add-money");
      expect(await moveNear(page)).toBe("Moved to your betting balance.");
    }

    // A fresh, unfunded testnet implicit account claims a username on the deployed registry (same path as the product) -> the named referee.
    const fresh = JSON.parse(execFileSync("npx", ["tsx", "tests/live/claimFresh.ts"], { cwd: process.cwd(), encoding: "utf8" }).trim().split("\n").pop()!);
    const refereeAccount: string = fresh.account, refereeName: string = fresh.username;
    expect(refereeAccount).toMatch(/^[0-9a-f]{64}$/);
    record({ step: "live5-referee", referee: refereeAccount, username: refereeName });

    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const start = new Date(Date.now() - 3_600_000).toISOString().slice(0, 16);
    const tag = Date.now().toString(36);
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, undefined, { timeout: 30_000 });
    await page.getByTestId("nav-create").click();
    await shot(page, "create-1-bet-type");
    await page.getByTestId("bet-type-card-custom").click();
    await page.getByTestId("cb-claim").fill(`LIVE5 deployed check ${tag} on ${day}: the named referee answers YES.`);
    // BET1a: claim + deadline (local time) + two links; the rest under More options. A person decides is set on Who decides.
    await page.getByTestId("cb-deadline").fill(utcToLocalInput(`${day}T12:00`));
    await page.getByTestId("cb-source-url-0").fill("https://example.com/");
    await page.getByTestId("cb-source-url-1").fill("https://www.iana.org/");
    await openMoreOptions(page);
    await page.getByTestId("cb-element-0").fill(`Does the named referee answer YES for LIVE5 check ${tag} on ${day} UTC?`);
    await page.getByTestId("cb-windowStart").fill(start);
    await page.getByTestId("cb-early").fill("Early YES resolution is allowed once the event has happened.");
    await page.getByTestId("cb-source-publisher-0").fill("Example Domain");
    await page.getByTestId("cb-source-publisher-1").fill("IANA");
    await page.getByTestId("cb-fallback").fill("Fallback: if a named source is unavailable, any other listed source may confirm.");
    await expect(page.getByTestId("fill-next")).toBeEnabled();
    await shot(page, "create-2-fill");
    await page.getByTestId("fill-next").click();

    await page.getByTestId("decider-person").check();
    await page.getByTestId("referee-search").fill(refereeName);
    await expect(page.getByTestId("referee-result-0")).toContainText(refereeName, { timeout: 30_000 });
    await page.getByTestId("referee-result-0").click();
    await expect(page.getByTestId("referee-selected")).toContainText(refereeName);
    await page.getByTestId("maker-amount").fill(STAKE);
    await shot(page, "create-3-stake");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expect(page.getByTestId("review-open-gate")).toHaveText("ready");

    // Human mode has no preflight UI: the app runs the (one) sourcecheck silently and the Open button unlocks only once it passes
    // (capped 60/IP/hour on testnet; never looped here). A failed check would show human-attest-error instead.
    await expect(page.getByTestId("human-no-preflight")).toBeVisible();
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 90_000 });
    await expect(page.getByTestId("human-attest-error")).toHaveCount(0);
    await shot(page, "create-4-review-sources");
    // The app leaves the review (and open-tx) for the share screen on success, so capture the relayer's txHash from the response.
    const relayed: string[] = [];
    page.on("response", async (r) => {
      if (r.request().method() !== "POST" || /rpc|privy|sourcecheck|registry/i.test(r.url())) return;
      try { const j = await r.json(); if (j && typeof j.txHash === "string") relayed.push(j.txHash); } catch { /* not JSON */ }
    });
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("share-screen").or(page.getByTestId("open-result"))).toBeVisible({ timeout: 180_000 });
    const result = await page.getByTestId("open-result").count() ? await page.getByTestId("open-result").textContent() : null;
    expect(result, `open did not land: ${result}`).toBeNull();
    const txHash = relayed.at(-1) ?? ((await page.getByTestId("open-tx").count()) ? await page.getByTestId("open-tx").textContent() : null);
    const link = await page.getByTestId("share-link").inputValue();
    const betId = Number(/\/bet\/(\d+)/.exec(link)?.[1]);
    expect(betId, `share link ${link}`).toBeGreaterThan(0);
    liveBetId = betId;
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible();
    await shot(page, "create-5-success");
    record({ step: "live5-open", account: me, referee: refereeAccount, betId, tx: txHash });
    console.log(`LIVE5 open: bet ${betId} tx ${txHash} referee ${refereeAccount} (@${refereeName})`);

    // FUND1b: chain first (get_bet is the truth), then the indexer, whose wait is derived from its documented tick cadence
    // (keeper cron every 60 s, 12 bets swept per tick): same assertion as before, just a bound that can't be beaten by tick lag.
    await expect.poll(async () => (await getBet(betId))?.status, { timeout: 60_000, intervals: [2_000], message: "get_bet on chain" }).toBe("Open");
    const waitMs = indexWaitMs(betId);
    test.setTimeout(420_000 + waitMs);
    record({ step: "live5-indexer-wait", betId, waitMs, tickMs: INDEXER_TICK_MS, batch: INDEXER_BATCH_BETS });
    await expect.poll(async () => (await fetchHistory(me)).find((h) => h.bet_id === betId)?.status, { timeout: waitMs, intervals: [5_000], message: `indexer shows bet ${betId} Open (within ${waitMs / 1000}s = tick cadence bound)` }).toBe("Open");
    const viaReferee = await (await fetch(`${process.env.INDEXER_URL ?? "https://praetorial-indexer-testnet.familiarcow.workers.dev"}/history?referee=${refereeAccount}`)).json();
    expect(viaReferee.some((h: any) => h.bet_id === betId)).toBe(true);
    expect(txHash).toBeTruthy();
  });

  test("@live 6. A second account takes the bet through the Take modal (terms -> confirm -> success), real relay + chain", async ({ browser }) => {
    test.setTimeout(420_000);
    expect(liveBetId, "no bet to take: run @live 5 first or set LIVE_BET_ID").toBeGreaterThan(0);
    // A fresh implicit testnet account (random ed25519 key, never mainnet) signs through the app's window.__e2eTestWallet seam
    // (the deployed build has no second Privy identity: the creds file holds one email). Signing is real; the relayer is the real deployed one.
    const kp = KeyPair.fromRandom("ed25519");
    const taker = Buffer.from(kp.getPublicKey().data).toString("hex");
    const ctx = await browser.newContext();
    const tp = await ctx.newPage();
    await tp.exposeFunction("__liveSign", (hashHex: string) => Buffer.from(kp.sign(Buffer.from(hashHex.replace(/^0x/, ""), "hex")).signature).toString("hex"));
    await tp.addInitScript((address) => {
      (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async (_a: string, h: string) => (window as any).__liveSign(h) };
    }, taker);
    record({ step: "live6-taker-account", taker, betId: liveBetId, fund: await devTransfer(taker, "3.5") });
    await tp.goto("/add-money");
    await tp.waitForFunction(() => (window as any).__e2e?.ready === true, undefined, { timeout: 30_000 });
    // A brand-new account must pick a username first (the Username modal): claim it through the UI, as @live 2 does.
    await expect(tp.getByTestId("username-input")).toBeVisible({ timeout: 30_000 });
    await tp.getByTestId("username-input").fill(`live6${Date.now().toString(36)}`);
    await tp.getByTestId("username-claim-btn").click();
    await expect(tp.getByTestId("username-input")).toHaveCount(0, { timeout: 60_000 });
    expect(await moveNear(tp)).toBe("Moved to your betting balance.");
    expect(await intents(taker, WNEAR) >= 3_000_000_000_000_000_000_000_000n).toBe(true);

    const relayed: string[] = [];
    tp.on("response", async (r) => {
      if (r.request().method() !== "POST" || /rpc|privy|sourcecheck|registry/i.test(r.url())) return;
      try { const j = await r.json(); if (j && typeof j.txHash === "string") relayed.push(j.txHash); } catch { /* not JSON */ }
    });
    await tp.goto(`/bet/${liveBetId}`);
    await tp.waitForFunction(() => (window as any).__e2e?.ready === true, undefined, { timeout: 30_000 });
    await expect(tp.getByTestId("bet-status")).toHaveText("Open", { timeout: 60_000 });
    await tp.getByTestId("take-open").click();
    await expect(dlg(tp).getByTestId("take-terms")).toBeVisible({ timeout: 30_000 });
    await expect(dlg(tp).getByTestId("take-confirm")).toBeVisible(); // M1: Take is one confirm step
    await shot(tp, "take-1-confirm");
    await dlg(tp).getByTestId("take-confirm").click();
    await expect(dlg(tp).getByTestId("flow-success").or(dlg(tp).getByTestId("flow-failure"))).toBeVisible({ timeout: 180_000 });
    const kind = await dlg(tp).getByTestId("take-result").getAttribute("data-kind");
    expect(kind, `take result: ${await dlg(tp).getByTestId("take-result").textContent()}`).toBe("taken");
    await expect(dlg(tp).getByTestId("take-result")).toContainText("You took this bet");
    await shot(tp, "take-3-success");
    const txHref = await dlg(tp).getByTestId("tx-link").getAttribute("href");
    const txHash = relayed.at(-1) ?? /([1-9A-HJ-NP-Za-km-z]{40,})/.exec(txHref ?? "")?.[1];
    record({ step: "live6-take", betId: liveBetId, taker, tx: txHash });
    console.log(`LIVE6 take: bet ${liveBetId} tx ${txHash} taker ${taker}`);
    const bet = await viewFunction<any>(process.env.ESCROW_ID ?? (await import("../../lib/config")).ESCROW_CONTRACT_ID, "get_bet", { bet_id: liveBetId });
    expect(bet.status).toBe("Taken");
    expect(bet.taker).toBe(taker);
    await ctx.close();
  });
  test("@live 7. FUND1: NEAR in the account -> Add money shows the exact missing amount -> Move -> balance covers the bet", async () => {
    if (!me) await login();
    const bal0 = await intents(me, WNEAR);
    const needNear = fromBaseUnits((bal0 + 2n * 10n ** 24n).toString(), 24).replace(/0+$/, "").replace(/\.$/, "");
    const fundTx = await devTransfer(me, "3.5");
    record({ step: "fund1-fund-wallet", account: me, tx: fundTx, near: "3.5" });
    await page.goto(`/add-money?asset=NEAR&need=${needNear}`);
    await expect(page.getByTestId("missing-amount")).toContainText("2 NEAR missing", { timeout: 30_000 });
    await expect(page.getByTestId("missing-amount")).toContainText("You can cover it by moving");
    const mv = await moveNear(page);
    expect(mv, `move failed: ${mv}`).toBe("Moved to your betting balance.");
    const bal1 = await intents(me, WNEAR);
    expect(bal1 - bal0 >= 3_400_000_000_000_000_000_000_000n, `intents grew by ${bal1 - bal0}`).toBe(true);
    await page.reload();
    await expect(page.getByTestId("balance-headline")).toContainText("You have enough for this bet", { timeout: 30_000 });
    await expect(page.getByTestId("missing-amount")).toHaveCount(0);
    record({ step: "fund1-move-near", account: me, intentsBefore: bal0.toString(), intentsAfter: bal1.toString() });
  });
});

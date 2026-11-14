// RFRZ2d: cancel orphan open bets 3 and 4 (frz3) as the same Privy maker through the web (cancel-bet -> cancel-confirm). Existing contract cancel only.
// Run (from apps/web): source $PRAETORIAL_SECRETS_DIR/praetorial-privy.env; PLAYWRIGHT_BASE_URL=https://praetorial-web-testnet.familiarcow.workers.dev npx playwright test -c ../../services/e2e/live-RFRZ2c/playwright.live.config.ts --project=maker cancel.live
import { test, expect } from "../live-DR/DR6/pw.js";
import fs from "node:fs";
import path from "node:path";
import { type BetView, } from "../live-DR/DR6/expected.js";
import { ESCROW, FEE, view, bal, escrowMethods, sleep } from "../live-DR/DR6/chain.js";
import { expectedCancelRefund } from "../live-DR/DR6/expected.js";
const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, "run", "cancel_results.json");
const R: Record<string, any> = { steps: [], cancels: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(R, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const EMAIL = process.env.PRIVY_TEST_EMAIL!, OTP = process.env.PRIVY_TEST_OTP!; // only to fill the form; never logged or stored
const PREV = JSON.parse(fs.readFileSync(path.join(DIR, "run", "results.json"), "utf8"));
async function ready(p: any) { await p.waitForFunction(() => (globalThis as { __e2e?: { ready?: boolean } }).__e2e?.ready === true, undefined, { timeout: 30_000 }); }

test("RFRZ2d: maker cancels orphan open bets 3 and 4", async ({ browser }) => {
  test.setTimeout(900_000);
  const sinceNs = BigInt(Date.now() - 60_000) * 1_000_000n;
  const maker = await (await browser.newContext()).newPage();
  await maker.goto("/"); await ready(maker);
  await maker.getByTestId("email-input").fill(EMAIL);
  await maker.getByTestId("send-code").click();
  await maker.waitForTimeout(2500);
  await maker.getByTestId("otp-input").fill(OTP);
  await maker.getByTestId("submit-code").click();
  await maker.waitForFunction(() => !!(globalThis as { __e2e?: { nearAddress?: string } }).__e2e?.nearAddress, undefined, { timeout: 60_000 });
  const makerAddr = (await maker.getByTestId("near-address").textContent())!.trim();
  expect(makerAddr).toBe(PREV.maker);
  for (const id of [3, 4]) {
    const bet: BetView = await view("get_bet", { bet_id: id });
    if (bet.status === "Cancelled") { R.cancels.push({ id, status: "Cancelled", note: "already cancelled before this run (earlier cancel run, tx 3atkQuXzig4nNN5tyM2iRz3d9DwgQh7zryivhAuyAFNS for bet 3)" }); save(); continue; }
    expect(bet.status).toBe("Open");
    const refund = expectedCancelRefund(bet);
    const mBefore = await bal(makerAddr), fBefore = await bal(FEE);
    await maker.goto(`/bet/${id}`); await ready(maker);
    await expect(maker.getByTestId("cancel-bet")).toBeVisible({ timeout: 60_000 });
    await maker.getByTestId("cancel-bet").click();
    await maker.getByTestId("cancel-confirm").click();
    await expect(maker.getByTestId("cancel-result")).toBeVisible({ timeout: 180_000 });
    for (let i = 0; i < 40 && !(await view("is_fully_paid", { bet_id: id })); i++) await sleep(3000);
    const fin: BetView = await view("get_bet", { bet_id: id });
    const mAfter = await bal(makerAddr);
    R.cancels.push({ id, status: fin.status, refund: refund.maker, maker_delta: mAfter - mBefore, fee_delta: (await bal(FEE)) - fBefore, fully_paid: await view("is_fully_paid", { bet_id: id }) }); save();
    expect(fin.status).toBe("Cancelled");
    expect(mAfter - mBefore).toBe(refund.maker);
    expect((await bal(FEE)) - fBefore).toBe(0n);
  }
  await sleep(4000);
  R.escrow_tx_methods = await escrowMethods(sinceNs); save();
  void ESCROW;
});

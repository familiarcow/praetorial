// V1 (familiarcow 2026-11-11: "We should be able to verify the results of every action ... users should easily be able to get all of their
// information to verify"). The real bet page on REAL testnet bet 49 (get_bet text, resolver keys, its 28 indexed transactions),
// fully mocked: RPC views + the indexer's GET /bet/txs. Read-only by design: nothing is signed or relayed here.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { mockUsernames } from "./lib/betPage";
// @ts-ignore -- plain JS module
import { runChecks } from "../../../scripts/verify-bet.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/v1/bet49-testnet.json", import.meta.url), "utf8"));
const RPC = "https://test.rpc.fastnear.com";
const INDEXER = "http://localhost:8787";
const MAKER = "979f2614c265b2dfacbde2628b66979c26afac83ba2f98f826a010aaab8eba7d";
const TAKER = "371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488";

const WALLET = "11".repeat(32); // an onlooker: neither side of bet 49
async function setup(page: Page, o: { indexerDown?: boolean } = {}) {
  const seen = { txs: 0, writes: 0 };
  await page.addInitScript((a) => { (window as any).__e2eTestWallet = { nearAddress: a, signRawHash: async () => { throw new Error("V1 specs never sign"); } }; }, WALLET);
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const p = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    const fn = (text: string) => ok({ result: Array.from(Buffer.from(text, "utf8")) });
    if (body.method === "send_tx" || body.method === "broadcast_tx_commit" || body.method === "broadcast_tx_async") seen.writes++;
    if (body.method === "block") return ok({ header: { height: 100, timestamp_nanosec: String(Date.now() * 1e6) } });
    if (p.request_type === "view_account") return ok({ amount: "0", code_hash: fx.code_hash_b58 });
    if (p.request_type === "view_access_key_list") return ok({ keys: [] });
    if (p.request_type === "call_function") {
      switch (p.method_name) {
        case "get_bet": return fn(fx.get_bet_text);
        case "resolver_keys": return fn(JSON.stringify(fx.resolver_keys));
        case "outlayer_config": return fn(JSON.stringify(fx.outlayer_config));
        case "judge_chain": return fn(JSON.stringify([{ model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017", model_b: "z-ai/glm-5.3-flash" }]));
        case "is_paused": case "is_shutdown": return fn("false");
        case "pending_payouts": return fn("[]");
        default: return fn("null");
      }
    }
    return ok({});
  });
  await page.route(`${INDEXER}/bet/txs*`, (r) => { seen.txs++; return o.indexerDown ? r.fulfill({ status: 503, body: "down" }) : r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fx.txs) }); });
  await mockUsernames(page, { [MAKER]: "maya", [TAKER]: "theo" });
  return seen;
}
const open = async (page: Page) => { await page.goto("/bet/49"); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); await expect(page.getByTestId("bet-details")).toBeVisible(); };
const activity = async (page: Page) => { const a = page.getByTestId("bet-activity"); if (!(await a.evaluate((d) => (d as HTMLDetailsElement).open))) await a.locator("summary").first().click(); return a; };

test.describe("V1 verify every action", () => {
  test("Activity: every row has Verify; it shows the tx (NearBlocks link), who acted (@username, id under it) and the exact amount", async ({ page }) => {
    const seen = await setup(page);
    await open(page);
    const a = await activity(page);
    const rows = a.locator(".k-activity > li");
    const n = await rows.count();
    expect(n).toBeGreaterThan(5);
    await expect(a.locator(".k-vtoggle")).toHaveCount(n);
    await page.getByTestId("verify-made").locator("summary").click();
    const r = page.getByTestId("receipt-made");
    await expect(r).toHaveAttribute("data-state", "found");
    await expect(r.getByTestId("receipt-explorer")).toHaveAttribute("href", /^https:\/\/testnet\.nearblocks\.io\/txns\/3FtMzC9D/);
    await expect(r).toContainText("20.062783 USDC");
    await expect(r).toContainText("@maya");
    const t = await r.innerText();
    expect(t.indexOf("@maya")).toBeLessThan(t.indexOf(MAKER.slice(0, 10)));
    await page.getByTestId("verify-paid").locator("summary").click();
    await expect(page.getByTestId("receipt-paid")).toContainText("44 USDC");
    await expect(page.getByTestId("receipt-paid")).toContainText("Praetorial fee account");
    expect(seen.txs).toBeGreaterThan(0);
    expect(seen.writes).toBe(0);
  });

  test("ruling card -> the AI judge's Verify sheet: asked, program, where, said (signature checked in the browser), accepted; About link", async ({ page }) => {
    await setup(page);
    await open(page);
    await page.getByTestId("ruling-verify").click();
    const s = page.getByTestId("verify-sheet");
    await expect(s).toBeVisible();
    for (const id of ["asked", "program", "where", "said", "accepted"]) await expect(s.getByTestId(`verify-section-${id}`)).toBeVisible();
    await expect(s.getByTestId("verify-item-terms-hash")).toHaveAttribute("data-status", "ok");
    await expect(s.getByTestId("verify-item-signature")).toHaveAttribute("data-status", "ok");
    await expect(s.getByTestId("verify-item-signature")).toContainText("Checks out (checked in your browser)");
    await expect(s.getByTestId("verify-item-signing-key")).toHaveAttribute("data-status", "ok");
    await expect(s.getByTestId("verify-link-wasm-hash")).toHaveAttribute("href", `${fx.outlayer_config.wasm_base_url}/${fx.resolver_keys[2]}.wasm`);
    await expect(s.getByTestId("verify-link-submit")).toHaveAttribute("href", "https://testnet.nearblocks.io/txns/AXvXrG32NxybxRhrxCWBBVCipWG99PhvDsN8t5WqvJ7m");
    await expect(s.getByTestId("verify-cmd-wasm-hash")).toContainText("| shasum -a 256");
    await expect(s.getByTestId("verify-about-link")).toHaveAttribute("href", "/docs/verification#verify"); // DOCS1: About is now Docs
    await s.getByTestId("verify-close").click();
    await expect(s).toBeHidden();
  });

  test("Details › AI judge opens the same sheet", async ({ page }) => {
    await setup(page);
    await open(page);
    await page.getByTestId("details-judge").locator("summary").first().click();
    await page.getByTestId("judge-verify").click();
    await expect(page.getByTestId("verify-sheet").getByTestId("verify-section-program")).toBeVisible();
  });

  test("Download verification file: one JSON the public checker PASSes (no FAIL), with every ruling and transaction", async ({ page }) => {
    await setup(page);
    await open(page);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("verify-download-cta").click()]);
    expect(dl.suggestedFilename()).toBe("praetorial-bet-49-testnet-verification.json");
    const file = JSON.parse(readFileSync(await dl.path(), "utf8"));
    expect(file.format).toBe("praetorial-verification/1");
    expect(file.bet_id).toBe(49);
    expect(file.get_bet_text).toBe(fx.get_bet_text);
    expect(file.rulings.map((r: any) => r.run_no)).toEqual([9, 10]);
    expect(file.transactions).toHaveLength(fx.txs.length);
    expect(file.escrow.code_hash_b58).toBe(fx.code_hash_b58);
    const res = runChecks(file, null);
    expect(res.filter((r: any) => r.status === "FAIL")).toEqual([]);
    expect(res.filter((r: any) => r.status === "PASS").map((r: any) => r.id)).toEqual(expect.arrayContaining(["terms-hash", "ruling-sig-9", "ruling-sig-10"]));
  });

  test("indexer down: receipts say so and link to the escrow's NearBlocks page; the sheet lists the gap; nothing invented", async ({ page }) => {
    await setup(page, { indexerDown: true });
    await open(page);
    await activity(page);
    await page.getByTestId("verify-made").locator("summary").click();
    await expect(page.getByTestId("receipt-made")).toHaveAttribute("data-state", "unavailable");
    await expect(page.getByTestId("receipt-made").getByTestId("receipt-escrow")).toHaveAttribute("href", /testnet\.nearblocks\.io\/address\//);
    await page.getByTestId("ruling-verify").click();
    await expect(page.getByTestId("verify-gaps")).toContainText("transaction list");
    await expect(page.getByTestId("verify-item-submit")).toHaveAttribute("data-status", "missing");
  });

  test("Docs › How to verify a bet (DOCS1: was About): numbered steps, what it proves and doesn't, developer box; the checker downloads from this site", async ({ page }) => {
    await setup(page);
    await page.goto("/about#verify"); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/docs\/verification#verify$/); // the old link (Verify sheets already shared) still lands here
    const v = page.getByTestId("about-verify");
    await expect(v.locator("h2")).toHaveText("How to verify a bet");
    expect(await v.locator("ol.steps > li").count()).toBeGreaterThanOrEqual(5);
    await expect(page.getByTestId("about-verify-bullets-title")).toHaveText("What this proves, and what it doesn't");
    await expect(page.getByTestId("about-dev-command")).toHaveText("node verify-bet.mjs <bet id> praetorial-bet-<bet id>-verification.json");
    await expect(v).toContainText("8791413f…");
    const href = await page.getByTestId("about-dev-script").getAttribute("href");
    expect(href).toBe("/verify-bet.mjs");
    const script = await page.evaluate(async (h) => (await fetch(h!)).text(), href);
    expect(script).toContain("verify-bet.mjs — check a Praetorial bet yourself");
    expect(script).toBe(readFileSync(new URL("../../../scripts/verify-bet.mjs", import.meta.url), "utf8"));
  });
});

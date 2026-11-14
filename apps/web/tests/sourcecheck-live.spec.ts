// WEBSRC1 @live: the TESTNET build (no VITE_SOURCECHECK_URL override) calls the real deployed sourcecheck Worker for a btc_touch sheet.
// Asserts ok:true, a signature valid under the escrow's pinned attest key (resolver_keys()[1], read via a real testnet RPC view call),
// and that 'Open the bet' is enabled on the review screen. Wallet seam + NEAR RPC for the create flow are mocked; resolver_keys is real.
// Run (port 3000: the Worker allows only localhost:3000/5173 + the preview origin): PW_LIVE=1 npx playwright test tests/sourcecheck-live.spec.ts
import { test, expect } from "@playwright/test";
import nacl from "tweetnacl";
import { ESCROW_CONTRACT_ID } from "../lib/config";
import { TESTNET_SOURCECHECK_URL } from "../lib/networkSelect";
import { openBetType } from "./betTypeNav";

const RPC = "https://test.rpc.fastnear.com";
const WALLET = "11".repeat(32);

async function realView(method: string): Promise<unknown> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "query", params: { request_type: "call_function", finality: "final", account_id: ESCROW_CONTRACT_ID, method_name: method, args_base64: Buffer.from("{}").toString("base64") } }) });
  const j: any = await r.json();
  return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
}
const hexOf = (k: string) => (k.startsWith("ed25519:") ? Buffer.from(require("bs58").decode(k.slice(8))).toString("hex") : k);

test("@live testnet build: real sourcecheck ok:true, attest-key-valid signature, Open the bet enabled", async ({ page }) => {
  test.setTimeout(240_000);
  const keys = (await realView("resolver_keys")) as string[];
  const attestHex = hexOf(keys[1]);
  await page.addInitScript(({ address }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) };
    (window as any).__e2eRegistryUrl = "";
  }, { address: WALLET });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "1" }; break;
        case "resolver_keys": r = keys; break;
        case "mt_balance_of": r = "1" + "0".repeat(30); break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 100000 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 30_000 });

  await openBetType(page, "btc_touch");
  await page.getByTestId("guided-direction").selectOption("at_or_above");
  await page.getByTestId("guided-x_usd").fill("200000");
  const dl = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 16); // <=5h window (Coinbase 300-candle cap)
  await page.getByTestId("guided-deadline_utc").fill(dl);
  await page.getByTestId("fill-next").click();
  await page.getByTestId("maker-amount").fill("10");
  // C1: the check runs by itself on entering Review, so listen before pressing Review
  const respP = page.waitForResponse((r) => r.url() === TESTNET_SOURCECHECK_URL && r.request().method() === "POST", { timeout: 120_000 });
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
  const resp = await respP;
  expect(resp.status()).toBe(200);
  const raw = await resp.text();
  const j = JSON.parse(raw.replace(/("checked_at"\s*:\s*)(\d+)/, '$1"$2"'));
  expect(j.ok).toBe(true);
  const sig = Buffer.from(j.signing.signature_hex, "hex");
  const msg = Buffer.from(`praetorial:sourcecheck:v1:${j.spec_hash}:${j.checked_at}`, "utf8");
  expect(nacl.sign.detached.verify(msg, sig, Buffer.from(attestHex, "hex")), "signature valid under escrow resolver_keys()[1]").toBe(true);
  await expect(page.getByTestId("source-check-status")).toContainText(/The AI can read these sources/, { timeout: 30_000 });
  await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
});

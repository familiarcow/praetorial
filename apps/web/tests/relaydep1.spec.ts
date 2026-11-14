// RELAYDEP1 / D-RELAYDEP1: the relayer never pays a deposit. "Move NEAR" wraps with a transaction the USER signs and pays
// (broadcast straight to the NEAR RPC); only the 1-yocto ft_transfer_call into Intents goes to POST /relay. Fully mocked.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { SCHEMA, decodeSignedTransaction } from "@near-js/transactions";
import * as borsh from "borsh";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" };
const NEAR = 10n ** 24n;
const BLOCK_HASH = "FDM3JkqRhGKqxqDqJm7cnzT1LgzDn3dHjkh8gCgV2tHB";

async function setup(page: Page) {
  const w = { native: 5n * NEAR, wnear: 0n, intents: 0n, relays: [] as { method: string; deposit: string }[], broadcasts: [] as { receiver: string; method: string; deposit: bigint; signer: string }[] };
  await page.addInitScript((address) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { (window as any).__signs = ((window as any).__signs ?? 0) + 1; return "22".repeat(64); } };
  }, WALLET);
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100, hash: BLOCK_HASH } });
    if (body.method === "broadcast_tx_async" || body.method === "send_tx") {
      const raw = Array.isArray(params) ? params[0] : params.signed_tx_base64;
      const st = decodeSignedTransaction(Buffer.from(raw, "base64"));
      const fc = st.transaction.actions[0].functionCall!;
      w.broadcasts.push({ receiver: st.transaction.receiverId, method: fc.methodName, deposit: fc.deposit, signer: st.transaction.signerId });
      if (fc.methodName === "near_deposit") { w.wnear += fc.deposit - 1_250_000_000_000_000_000_000n; w.native -= fc.deposit; }
      return ok(body.method === "send_tx" ? { status: { SuccessValue: "" }, receipts_outcome: [] } : "DIRECTTX1111111111111111111111111111111111111");
    }
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: [] } }] });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: w.native.toString() });
    if (params.request_type === "call_function") {
      const a = JSON.parse(Buffer.from(params.args_base64 ?? "", "base64").toString() || "{}");
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "mt_balance_of": r = w.intents.toString(); break;
        case "ft_balance_of": r = params.account_id === "wrap.testnet" ? w.wnear.toString() : "0"; break;
        case "storage_balance_of": r = { total: "1250000000000000000000", available: "0" }; break;
      }
      void a;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(`${RELAYER}/relay`, async (r) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors });
    const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(JSON.parse(r.request().postData() ?? "{}").signedDelegate, "base64"));
    const fc = sd.delegateAction.actions[0].functionCall;
    w.relays.push({ method: fc.methodName, deposit: String(fc.deposit) });
    if (fc.methodName === "ft_transfer_call") { w.intents += w.wnear; w.wnear = 0n; }
    return r.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, txHash: `TX${w.relays.length}` }) });
  });
  return w;
}
const open = async (page: Page, path: string) => { await page.goto(path); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); };
const dlg = (p: Page) => p.locator("dialog[open]").last();

test.describe("RELAYDEP1 the relayer never pays a deposit", () => {
  test("Move NEAR: the wrap is a direct user-signed transaction (no /relay POST carries a deposit); only the 1-yocto transfer is relayed", async ({ page }) => {
    const w = await setup(page);
    await open(page, "/add-money");
    await page.getByTestId("move-NEAR-native").click(); // NAV1: the Move button is on the Wallet page (Add money is no longer a modal)
    await dlg(page).getByTestId("move-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 25_000 });
    expect(w.broadcasts).toHaveLength(1);
    expect(w.broadcasts[0]).toMatchObject({ receiver: "wrap.testnet", method: "near_deposit", signer: WALLET });
    expect(w.broadcasts[0].deposit > 0n).toBe(true);
    expect(w.relays.map((r) => r.method)).toEqual(["ft_transfer_call"]);
    expect(w.relays.every((r) => BigInt(r.deposit) <= 1n)).toBe(true);
    expect(await page.evaluate(() => (window as any).__signs ?? 0)).toBe(2);
  });
});

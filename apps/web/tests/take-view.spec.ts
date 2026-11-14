// FE9 (S10, S11): read-only bet page for the link holder (every unavailable state), login-on-take that returns to the bet,
// the taker review card, the race guard, Take signing with referee_ack, and the read-back. Fully mocked: NEAR RPC (views + tx logs),
// relayer POST /relay, wallet seam. Never a real Privy login; never a testnet write.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mockUsernames } from "./lib/betPage";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const FUND_NS = Date.UTC(2037, 0, 2, 3, 4) * 1_000_000;
const RESOLVE_NS = Date.UTC(2037, 0, 5, 3, 4) * 1_000_000;

interface World {
  relays: number; signs: number; getBets: number;
  status: string; taker: string | null; referee: string | null; stakeTaker: string; termsHash: string;
  takerAllow: any; fundingNs: number; paused: boolean; takeOnRelay: "taken" | "none"; txLogs: string[] | null;
}
const world = (o: Partial<World> = {}): World => ({ relays: 0, signs: 0, getBets: 0, status: "Open", taker: null, referee: "ref.testnet", stakeTaker: "10000000", termsHash: "ab".repeat(32), takerAllow: "Any", fundingNs: FUND_NS, paused: false, takeOnRelay: "taken", txLogs: [], ...o });

const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: "maker.testnet", taker_allow: w.takerAllow, terms_hash: w.termsHash, models_snapshot_hash: "cd".repeat(32), terms: null, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: w.stakeTaker, taker_options: [], fee_bps: 100, funding_deadline: w.fundingNs, resolve_deadline: RESOLVE_NS, settlement_period: 86_400_000_000_000,
    referee: w.referee ? { account: w.referee, mode: "Human" } : null },
  status: w.status, taker: w.taker, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "500000",
});

async function setup(page: Page, w: World, opts: { wallet?: boolean; decline?: boolean } = {}) {
  await page.addInitScript(({ address, wallet, decline }) => {
    if (wallet) (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { (window as any).__signs = ((window as any).__signs ?? 0) + 1; if (decline) throw new Error("User rejected the request"); return "22".repeat(64); } };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
  }, { address: WALLET, wallet: opts.wallet !== false, decline: !!opts.decline });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") {
      if (w.txLogs === null) return reply({ error: { name: "UNKNOWN_TRANSACTION", cause: { name: "UNKNOWN_TRANSACTION" } } });
      return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: w.txLogs } }] });
    }
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": r = w.paused; break;
        case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "1" + "0".repeat(20); break;
        case "required_challenge_bond": r = null; break;
        case "get_bet": w.getBets++; r = args.bet_id === 7 ? betJson(w) : null; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  const relayed: any[] = [];
  await page.route(`${RELAYER}/relay`, (r) => {
    w.relays++;
    relayed.push(JSON.parse(r.request().postData() ?? "{}"));
    if (w.takeOnRelay === "taken") { w.status = "Taken"; w.taker = WALLET; }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relays}` }) });
  });
  return relayed;
}
const open = async (page: Page, path = "/bet/7") => {
  await mockUsernames(page); // B1: people are @usernames (registered last so the spec's catch-all route doesn't shadow it)
  await page.goto(path);
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
};
const signs = (page: Page) => page.evaluate(() => (window as any).__signs ?? 0);

test.describe("FE9 take view", () => {
  for (const [name, over, kind, text] of [
    ["taken", { status: "Taken", taker: "someone.testnet" }, "taken", /Someone already took this bet/],
    ["cancelled", { status: "Cancelled" }, "cancelled", /The maker cancelled this bet/],
    ["expired (status)", { status: "Expired" }, "expired", /This offer has expired/],
    ["expired (deadline passed)", { fundingNs: Date.UTC(2020, 0, 1) * 1_000_000 }, "expired", /This offer has expired/],
    ["paused", { paused: true }, "paused", /paused/i],
    ["named taker is not you", { takerAllow: { Account: "bob.testnet" } }, "not-you", /This bet is only for @bob\./], // B1: the named taker by @username
  ] as [string, Partial<World>, string, RegExp][]) {
    test(`unavailable state: ${name}`, async ({ page }) => {
      const w = world(over);
      await setup(page, w);
      await open(page);
      await expect(page.getByTestId("take-state")).toHaveAttribute("data-kind", kind);
      await expect(page.getByTestId("take-state")).toContainText(text);
      await expect(page.getByTestId("take-confirm")).toHaveCount(0);
      await expect(page.getByTestId("take-open")).toHaveCount(0);
      expect(w.relays).toBe(0);
      expect(await signs(page)).toBe(0);
    });
  }

  // LOGIN1 (UX-29): was "logged out: read-only bet with a login prompt". Logged out is now only the login page (naming the
  // bet); the "Log in to take this bet" prompt remains for a signed-in user whose NEAR wallet is still being set up.
  test("logged out: only the login page for /bet/7; signed in (wallet setting up) -> take prompt; wallet ready -> same bet, take enabled", async ({ page }) => {
    const w = world();
    await setup(page, w, { wallet: false });
    await open(page);
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page.getByTestId("login-line")).toHaveText("Log in to see bet #7. You will go straight to it.");
    await expect(page.getByTestId("take-review")).toHaveCount(0);
    const before = page.url();
    await page.evaluate(() => {
      (window as any).__e2eTestWallet = { nearAddress: null, signRawHash: async () => { throw new Error("no wallet"); } };
      window.dispatchEvent(new Event("e2e-wallet-changed"));
    });
    await expect(page.getByTestId("take-login")).toContainText("Log in to take this bet");
    await expect(page.getByTestId("take-open")).toBeDisabled();
    await page.evaluate((address) => {
      (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) };
      window.dispatchEvent(new Event("e2e-wallet-changed"));
    }, WALLET);
    await expect(page.getByTestId("take-open")).toBeEnabled({ timeout: 10_000 });
    expect(page.url()).toBe(before);
    await expect(page.getByTestId("take-login")).toHaveCount(0);
  });

  test("take review (M1: one sheet): the shared 5 lines from the taker's side, the referee as a person, pay-now with storage, tip carved out of the stake", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await expect(page.getByTestId("take-review")).toBeVisible();
    await page.getByTestId("take-open").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    // C1: the shared review, take variant (5 lines + Full terms; lib/money amounts; the referee as a person, never the id)
    await expect(page.getByTestId("review-card")).toHaveAttribute("data-variant", "take");
    await expect(page.getByTestId("review-stakes")).toHaveText(/^You put in 10\.00 USDC · they put in [\d.]+ USDC$/);
    await expect(page.getByTestId("review-term-pay-now")).toContainText("USDC");
    await expect(page.getByTestId("review-term-storage")).toContainText("USDC");
    await expect(page.getByTestId("review-decider")).toHaveText(/, a person \(no AI\)$/);
    await expect(page.getByTestId("review-card")).not.toContainText("ref.testnet");
    await expect(page.getByTestId("review-term-tip")).toContainText("No tip");
    await page.getByTestId("take-tip-checkbox").check();
    await expect(page.getByTestId("review-term-tip")).toContainText("out of your 10.00 USDC stake. It is not added on top.");
    await expect(page.getByTestId("review-term-their-storage")).toHaveCount(0);
    // M1: the one take sheet's pay box (what leaves the balance now) and the tip carved out of the stake
    await expect(page.getByTestId("take-confirm-summary").locator('dd[data-row="pay-now"]')).toContainText("storage)");
    await expect(page.getByTestId("take-confirm-summary").locator('dd[data-row="tip"]')).toContainText("out of your stake");
    await expect(page.getByTestId("take-lose")).toContainText("not on top");
  });

  test("take success: one signature, Take msg carries referee_ack and tip, success only after get_bet shows me as taker", async ({ page }) => {
    const w = world();
    const relayed = await setup(page, w);
    await open(page);
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-tip-checkbox").check();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    await expect(page.getByTestId("take-result")).toHaveAttribute("data-kind", "taken", { timeout: 20_000 });
    await expect(page.getByTestId("take-result")).toContainText("You took this bet");
    expect(w.relays).toBe(1);
    expect(relayed.length).toBe(1);
    expect(await signs(page)).toBe(1);
  });

  test("race: referee changed between view and take -> refused with a clear message, nothing signed", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("take-open")).toBeEnabled();
    w.referee = "evil.testnet"; // the maker swapped the referee after the page loaded
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    await expect(page.getByTestId("take-error")).toContainText(/referee changed/i);
    await expect(page.getByTestId("take-error")).toContainText(/nothing was (sent|signed)/i);
    expect(w.relays).toBe(0);
    expect(await signs(page)).toBe(0);
  });

  test("race: stakes changed between view and take -> refused, nothing signed", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("take-open")).toBeEnabled();
    w.stakeTaker = "90000000";
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    await expect(page.getByTestId("take-error")).toContainText(/stakes changed/i);
    expect(w.relays).toBe(0);
    expect(await signs(page)).toBe(0);
  });

  test("race: terms changed between view and take -> refused, nothing signed", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("take-open")).toBeEnabled();
    w.termsHash = "ee".repeat(32);
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    await expect(page.getByTestId("take-error")).toContainText(/terms changed/i);
    expect(w.relays).toBe(0);
    expect(await signs(page)).toBe(0);
  });

  test("someone else took it first: honest message, not a success", async ({ page }) => {
    const w = world({ takeOnRelay: "none" });
    await setup(page, w);
    await page.route(`${RELAYER}/relay`, (r) => { w.relays++; w.status = "Taken"; w.taker = "other.testnet"; return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "TXL" }) }); });
    await open(page);
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    await expect(page.getByTestId("take-result")).toHaveAttribute("data-kind", "lost", { timeout: 20_000 });
    await expect(page.getByTestId("take-result")).toContainText("Someone else took this bet first");
  });

  test("contract refusal: mapped message from the take_rejected log, refund stated", async ({ page }) => {
    const w = world({ takeOnRelay: "none", txLogs: ["take_rejected reason=referee_ack does not match the bet's referee"] });
    await setup(page, w);
    await open(page);
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    await expect(page.getByTestId("take-result")).toHaveAttribute("data-kind", "refused", { timeout: 20_000 });
    await expect(page.getByTestId("take-result")).toContainText("The contract refused this take: the referee on this bet changed");
    await expect(page.getByTestId("take-result")).toContainText("Your money was returned.");
  });

  test("wallet declined: plain message, nothing sent, can try again", async ({ page }) => {
    const w = world();
    await setup(page, w, { decline: true });
    await open(page);
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    await expect(page.getByTestId("take-result")).toHaveAttribute("data-kind", "declined");
    await expect(page.getByTestId("take-result")).toHaveText("You cancelled. Nothing was sent.");
    expect(w.relays).toBe(0);
    await page.getByTestId("flow-retry").click();
    await expect(page.getByTestId("take-confirm")).toBeEnabled();
  });
});

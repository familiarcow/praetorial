// F3 (FUND4 SPEC §3, familiarcow UX-37 / D-FUND4a, SM2 STATES.md M5), mocked: the Account page. @username header with the grey ≈ $ total
// (hidden when a price is missing), one row per token with only non-zero secondary lines, in bets + being paid out from the user's
// bets, stray tokens (known, unknown, dust) with the Convert entry, transfers in flight, one failing section never hiding the
// others, the empty hero, Account details holding the raw id, 375 px without horizontal scroll, axe, screenshots.
// The mainnet-only reads (stray tokens, 1Click prices) are turned on in this testnet dev build with the deposit-API seam.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import AxeBuilder from "@axe-core/playwright";
import { ONECLICK_TOKENS, ID } from "./funding/fixtures";

const ME = "a1".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
const INDEXER = "http://localhost:8787";
const REG = "http://registry.f3.e2e.test";
const USDC = "nep141:usdc.testnet", WNEAR = "nep141:wrap.testnet";
const DAY = 86_400_000;
const E24 = 10n ** 24n;
const SHOTS = process.env.F3_SHOTS === "1" ? "../../spikes/fund4/shots" : "test-results/screens/f3";

interface World {
  betting: Record<string, string>; bettingFails: boolean;
  near: { usdc?: string; wnear?: string; native?: string };
  owned: string[]; strayBalances: Record<string, string>;
  bets: Record<number, unknown>; payouts: Record<number, unknown[]>;
  tokens: unknown[]; username: string | null;
  // AFIX1: hold the intents balance read / the bet list until released; make one source fail.
  hold?: Promise<void>; holdBets?: Promise<void>;
  fail?: "near-token" | "near-native" | "stray" | "bets" | "payouts" | "betting-429";
}
const world = (o: Partial<World> = {}): World => ({
  betting: { [USDC]: "42100000", [WNEAR]: (5n * E24).toString() }, bettingFails: false,
  near: {}, owned: [], strayBalances: {}, bets: {}, payouts: {}, tokens: ONECLICK_TOKENS, username: "alice", ...o,
});

function bet(id: number, o: { maker: string; taker?: string | null; status: string; sm?: string; outcome?: string | null }) {
  return {
    envelope: {
      bet_id: id, version: 1, maker: o.maker, taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "x", outcomes: ["YES", "NO"], maker_side: "YES",
      maker_asset: USDC, taker_asset: USDC, stake_maker: o.sm ?? "10000000", stake_taker: o.sm ?? "10000000", taker_options: [], fee_bps: 100, reserve_per_side: "0",
      storage_charge_per_side: "0", keep_terms: true, terms: JSON.stringify({ claimText: `Bet ${id}` }), run_price: "0", max_paid_runs: 3, tier: 1, arbiter: null, arbiter_fee: "0",
      funding_deadline: (Date.now() + 6 * DAY) * 1e6, early_settle_outcome: null, finality_delay: 0, settlement_period: DAY * 1e6,
      resolve_deadline: (Date.now() + 30 * DAY) * 1e6, consent_party_controlled: false, referee: null,
    },
    status: o.status, taker: o.taker ?? null, created_at: Date.parse("2026-03-04T10:00:00Z") * 1e6, taken_at: null, proposed_at: Date.now() * 1e6, outcome: o.outcome ?? null,
    reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0,
  };
}

async function mock(page: Page, w: World) {
  await page.addInitScript(({ me, sig, reg }) => {
    (window as any).__e2eTestWallet = { nearAddress: me, signRawHash: async () => sig };
    (window as any).__e2eDepositApi = true;
    if (reg) (window as any).__e2eRegistryUrl = reg;
  }, { me: ME, sig: SIG, reg: w.username === null ? "" : REG });
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(w.tokens) }));
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const p = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    const err = () => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "boom" } }) });
    if (p.request_type === "view_account") return w.fail === "near-native" ? err() : ok({ amount: w.near.native ?? "0" });
    if (p.request_type !== "call_function") return ok({});
    const args = JSON.parse(Buffer.from(p.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
    const m = p.method_name as string;
    let r: unknown = null;
    const all = { ...w.betting, ...w.strayBalances };
    if ((m === "mt_batch_balance_of" || m === "mt_balance_of") && p.account_id !== "intents.near") {
      if (w.hold) await w.hold;
      // 429 on the batch read; the per-token fallback then fails too (keeps the spec ~20 s: each 429 costs the client >= 1 s x 4 x 3).
      if (w.fail === "betting-429") return m === "mt_batch_balance_of" ? route.fulfill({ status: 429, headers: { "retry-after": "0" }, body: "slow down" }) : err();
    }
    if (m === "mt_tokens_for_owner" && w.fail === "stray") return err();
    if (m === "ft_balance_of" && w.fail === "near-token" && p.account_id === "usdc.testnet") return err();
    if (m === "mt_batch_balance_of") { if (w.bettingFails && p.account_id !== "intents.near") return err(); r = (args.token_ids as string[]).map((id) => all[id] ?? "0"); }
    else if (m === "mt_balance_of") { if (w.bettingFails) return err(); r = all[args.token_id] ?? "0"; }
    else if (m === "mt_tokens_for_owner") r = Number(args.from_index) > 0 ? [] : w.owned.map((token_id) => ({ token_id }));
    else if (m === "ft_balance_of") r = p.account_id === "usdc.testnet" ? (w.near.usdc ?? "0") : p.account_id === "wrap.testnet" ? (w.near.wnear ?? "0") : "0";
    else if (m === "is_paused" || m === "is_shutdown") r = false;
    else if (m === "get_bet") r = w.bets[args.bet_id] ?? null;
    else if (m === "pending_payouts" && w.fail === "payouts") return err();
    else if (m === "pending_payouts") r = w.payouts[args.bet_id] ?? [];
    else if (m === "open_offers") r = [];
    return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
  });
  await page.route(`${INDEXER}/**`, async (route) => {
    const u = new URL(route.request().url());
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.searchParams.get("account") && w.holdBets) await w.holdBets;
    if (u.searchParams.get("account") && w.fail === "bets") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    if (u.searchParams.get("account")) return json(Object.entries(w.bets).map(([id, b]: [string, any]) => ({ bet_id: Number(id), maker: b.envelope.maker, taker: b.taker, status: b.status, outcome: b.outcome })));
    return json([]);
  });
  await page.route(`${REG}/**`, async (route) => {
    const u = new URL(route.request().url());
    const json = (status: number, b: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(b) });
    if (u.pathname.startsWith("/lookup/account/")) return w.username ? json(200, { username: w.username }) : json(404, { error: "not_found" });
    if (u.pathname === "/search") return json(200, w.username ? [{ username: w.username, account_tail: ME.slice(-8) }] : []);
    return json(404, {});
  });
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
async function noSeriousAxe(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
}
const noHScroll = async (page: Page, w: number) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);

const FULL = () => world({
  near: { usdc: "3000000" },
  owned: [ID.USDC, ID.NEAR, ID.ETH_USDC, ID.UNKNOWN, ID.BASE_USDC], // mainnet intents ids (the bet tokens are not strays)
  strayBalances: { [ID.ETH_USDC]: "1000000", [ID.UNKNOWN]: "7", [ID.BASE_USDC]: "10" },
  bets: {
    1: bet(1, { maker: ME, status: "Open", sm: "25000000" }),
    2: bet(2, { maker: "bob.testnet", taker: ME, status: "Finalized", outcome: "NO" }),
    3: bet(3, { maker: ME, taker: "carol.testnet", status: "Settled", outcome: "YES" }),
  },
  payouts: { 2: [{ id: 1, bet_id: 2, token_id: USDC, receiver: ME, amount: "18200000", reason: "win", attempts: 1, done: false, in_flight: false }] },
});

test.describe("F3 Account page", () => {
  for (const [name, size] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]] as const) {
    test(`${name}px: header, rows, in bets, being paid out, stray tokens, Convert entry; axe; no horizontal scroll`, async ({ page }) => {
      await page.setViewportSize(size);
      await mock(page, FULL());
      await page.goto("/account"); await ready(page);
      // Header: the @username (also in the nav), grey ≈ $ total from 1Click prices, the record and first bet.
      await expect(page.getByTestId("wallet-username")).toHaveText("@alice");
      await expect(page.getByTestId("nav-account")).toHaveText("@alice");
      await expect(page.getByTestId("account-total-usd")).toHaveText("≈ $60.33"); // 42.10 USDC x 0.999527 + 5 NEAR x 3.65
      await expect(page.getByTestId("account-record")).toContainText("2 won · 0 lost");
      await expect(page.getByTestId("account-since")).toHaveText("Member since Mar 2026");
      // The raw id appears nowhere outside Account details (PEOPLE RULE).
      expect(await page.locator("body").evaluate((b, me) => {
        const d = b.querySelector("[data-testid=account-details]")!; const clone = b.cloneNode(true) as HTMLElement;
        clone.querySelector("[data-testid=account-details]")?.remove(); void d; return clone.textContent!.includes(me);
      }, ME)).toBe(false);
      // Rows: token units; secondary lines only when non-zero.
      await expect(page.getByTestId("balance-row-USDC")).toHaveText("42.10 USDC");
      await expect(page.getByTestId("balance-row-NEAR")).toHaveText("5 NEAR");
      await expect(page.getByTestId("wallet-amount-USDC")).toHaveText("In your NEAR account: 3.00 USDC");
      await expect(page.getByTestId("in-bets-USDC")).toHaveText("In bets: 25.00 USDC (1 bet)");
      await expect(page.getByTestId("paying-USDC")).toHaveText("Being paid out: 18.20 USDC");
      for (const id of ["wallet-amount-NEAR", "in-bets-NEAR", "paying-NEAR"]) await expect(page.getByTestId(id)).toHaveCount(0);
      await expect(page.getByTestId("payout-row")).toContainText("18.20 USDC");
      await expect(page.getByTestId("payout-row").getByRole("link")).toHaveAttribute("href", "/bet/2");
      // Stray tokens: known (Convert into USDC), unknown (visible, Contact support), dust (can't convert).
      const strays = page.getByTestId("stray-row");
      await expect(strays).toHaveCount(3);
      await expect(strays.nth(0)).toContainText("USDC (Ethereum)");
      await expect(strays.nth(0).getByTestId("stray-amount")).toHaveText("1.00 USDC");
      await expect(strays.nth(0).getByTestId("stray-convert")).toHaveText("Convert to USDC");
      await expect(strays.nth(1)).toHaveAttribute("data-unknown", "1");
      await expect(strays.nth(1)).toContainText("Contact support");
      await expect(strays.nth(1).getByTestId("stray-convert")).toHaveCount(0);
      await expect(strays.nth(2).getByTestId("stray-note")).toHaveText("Too small to convert");
      // The only $ on the page is the grey total in the header (FUND 11); every amount is in token units.
      expect(await page.getByTestId("add-money").evaluate((el) => { const c = el.cloneNode(true) as HTMLElement; c.querySelector("[data-testid=account-total-usd]")?.remove(); return c.textContent; })).not.toMatch(/\$/);
      await noHScroll(page, size.width);
      await noSeriousAxe(page);
      await page.screenshot({ path: `${SHOTS}/account-full-${name}.png`, fullPage: true });
      // Account details: the full id with Copy, the username, and whether the user is in referee search.
      await page.getByTestId("account-details").locator("summary").click();
      await expect(page.getByTestId("wallet-account-id")).toHaveText(ME);
      await expect(page.getByTestId("account-referee-listed")).toHaveAttribute("data-listed", "true");
      await noSeriousAxe(page);
      await page.screenshot({ path: `${SHOTS}/account-details-${name}.png`, fullPage: true });
      // Token sheet and the Convert entry.
      await page.getByTestId("asset-row-USDC").click();
      await expect(page.getByTestId("token-sheet-betting")).toHaveText("42.10 USDC");
      await expect(page.getByTestId("withdraw-btn-USDC")).toBeVisible();
      await expect(page.getByTestId("sheet-move-USDC-token")).toHaveText("Move 3.00 USDC to betting");
      await noSeriousAxe(page);
      await page.screenshot({ path: `${SHOTS}/account-token-sheet-${name}.png` });
      await page.getByTestId("modal-close").click();
      // F5: Convert opens the real Convert sheet (only the 6; estimate from the funding service, unmocked here = "unavailable").
      await page.route("https://praetorial-funding-testnet.familiarcow.workers.dev/**", (r) => r.fulfill({ status: 503, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "upstream_down" }) }));
      await strays.nth(0).getByTestId("stray-convert").click();
      await expect(page.getByTestId("cv-title")).toHaveText("Convert 1.00 USDC (Ethereum)");
      await expect(page.getByTestId("cv-error")).toHaveText("Adding money and cashing out are unavailable right now. Your balances are safe.");
      await page.screenshot({ path: `${SHOTS}/account-convert-${name}.png` });
    });
  }

  test("≈ $ total is hidden when any held token has no price; still no $ anywhere else", async ({ page }) => {
    await mock(page, world({ tokens: ONECLICK_TOKENS.map((t) => (t.assetId === ID.NEAR ? { ...t, price: null } : t)) }));
    await page.goto("/account"); await ready(page);
    await expect(page.getByTestId("balance-row-NEAR")).toHaveText("5 NEAR");
    await expect(page.getByTestId("account-total-usd")).toHaveCount(0);
  });

  test("one failing section never hides the others: betting unread -> 'can't read' (never 0), NEAR account and strays still shown", async ({ page }) => {
    await mock(page, world({ bettingFails: true, near: { usdc: "3000000" }, owned: [ID.ETH_USDC], strayBalances: { [ID.ETH_USDC]: "1000000" } }));
    await page.goto("/account"); await ready(page);
    await expect(page.getByTestId("balance-error")).toContainText("We can't read your balance right now.");
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("Can't read");
    await expect(page.getByTestId("wallet-amount-USDC")).toHaveText("In your NEAR account: 3.00 USDC");
    await expect(page.getByTestId("move-USDC-token")).toBeVisible();
    await expect(page.getByTestId("stray-row")).toContainText("USDC (Ethereum)");
    await expect(page.getByTestId("account-total-usd")).toHaveCount(0);
    await expect(page.getByTestId("account-empty")).toHaveCount(0);
  });

  test("empty: one Add money hero at the top, then the betting balance rows at 0 (ACCT2); Cash out hidden; Add money opens F4's one-time-address sheet (never a bridge address)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mock(page, world({ betting: {} }));
    const bridge: string[] = [];
    await page.route("https://bridge.chaindefuser.com/**", (r) => { bridge.push(r.request().url()); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { tokens: [] } }) }); });
    await page.goto("/account"); await ready(page);
    await expect(page.getByTestId("account-empty")).toContainText("Add money to start betting");
    // ACCT2 (familiarcow 11-13): under the hero, the same rows as a funded account, every bet token at 0 (testnet: USDC + NEAR).
    await expect(page.getByTestId("balances")).toBeVisible();
    await expect(page.locator("[data-testid^=asset-card-]")).toHaveCount(2);
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("0.00 USDC");
    await expect(page.getByTestId("balance-row-NEAR")).toHaveText(/^0(\.0+)? NEAR$/);
    const hero = (await page.getByTestId("account-empty").boundingBox())!, list = (await page.getByTestId("balances").boundingBox())!;
    expect(hero.y + hero.height).toBeLessThanOrEqual(list.y); // the hero on top, the list below
    await expect(page.getByTestId("account-empty-tokens")).toHaveCount(0); // the rows name the tokens now
    await expect(page.getByTestId("account-cash-out")).toHaveCount(0);
    await expect(page.getByTestId("account-total-usd")).toHaveCount(0); // nothing to total
    await expect(page.getByTestId("account-add-money")).toHaveCount(0); // the hero carries the one Add money
    await noHScroll(page, 375);
    await noSeriousAxe(page);
    await page.screenshot({ path: `${SHOTS}/account-empty-375.png`, fullPage: true });
    // A 0 row still opens its token sheet, and Add money from there opens the sheet.
    await page.getByTestId("asset-row-USDC").click();
    await expect(page.getByTestId("token-sheet-USDC")).toBeVisible();
    await expect(page.getByTestId("token-add-money-USDC")).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("token-sheet-USDC")).toHaveCount(0);
    await page.getByTestId("empty-add-money").click();
    await expect(page.getByTestId("add-money-sheet")).toBeVisible();
    // F4 (familiarcow UX-37 FUND 13): "What do you have?" (any token, any network), no per-token permanent deposit address.
    await expect(page.getByTestId("fund-picker")).toContainText("What do you have?");
    await expect(page.locator("[data-testid^=deposit-toggle-]")).toHaveCount(0);
    expect(bridge).toEqual([]);
  });

  test("transfers in flight (this device's record): the card at the top, token units, no address", async ({ page }) => {
    await mock(page, world());
    const rec = {
      id: "TQx9cMHT8hNqMB4x1aP6YbkzjXtRUKk3Lm", account: ME, kind: "fund",
      origin: { assetId: ID.TRON_USDT, symbol: "USDT", blockchain: "tron", decimals: 6 }, destination: { assetId: ID.USDT, symbol: "USDT", blockchain: "near", decimals: 6 },
      amountIn: "50000000", minAmountIn: "49500000", amountOut: "49800000", minAmountOut: "49000000", depositAddress: "TQx9cMHT8hNqMB4x1aP6YbkzjXtRUKk3Lm",
      depositMemo: null, recipient: null, deadline: new Date(Date.now() + 3_600_000).toISOString(), createdAt: Date.now(), updatedAt: Date.now(), state: "converting",
      lastStatus: "PROCESSING", received: null, delivered: null, refunded: null, refundReason: null, correlationId: null, signed: null, needReturn: null, checkFailures: 0,
    };
    await page.addInitScript(({ key, rec }) => localStorage.setItem(key, JSON.stringify([rec])), { key: `praetorial:funding:v1:${ME}`, rec });
    await page.goto("/account"); await ready(page);
    await expect(page.getByTestId("inflight-card")).toContainText("1 deposit in progress");
    await expect(page.getByTestId("inflight-line")).toHaveText("Adding 50.00 USDT (Tron) → USDT · Converting");
    await expect(page.getByTestId("inflight-card")).not.toContainText("TQx9");
  });

  // ---------------------------------------------------------------- AFIX1 (familiarcow 11-13, mainnet): no fake coin list, no false "empty"
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  const AFIX1_SHOTS = process.env.AFIX1_SHOTS === "1" ? `../../spikes/afix1/shots/${process.env.AFIX1_TAG ?? "after"}` : "test-results/screens/afix1";
  // ACCT2: after loading, the list is always there; the empty hero sits above it only for an empty account.
  const resolved = async (page: Page, empty: boolean) => {
    await expect(page.getByTestId("account-loading")).toHaveCount(0);
    expect(await page.getByTestId("balances").count()).toBe(1);
    expect(await page.getByTestId("account-empty").count()).toBe(empty ? 1 : 0);
  };

  for (const [name, w] of [["empty account", () => world({ betting: {} })], ["funded account", () => world()]] as const) {
    test(`AFIX1 ${name}: while the balance read is slow, one neutral placeholder (no coin list, no empty hero); then the list (+ the hero when empty)`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      const g = gate();
      const ww = w(); ww.hold = g.p;
      await mock(page, ww);
      await page.goto("/account"); await ready(page);
      await page.waitForTimeout(1500); // familiarcow: "at first I see the coins and balances" -- the read is still out
      await page.screenshot({ path: `${AFIX1_SHOTS}/loading-${name.split(" ")[0]}-375.png`, fullPage: true });
      await expect(page.getByTestId("account-loading")).toBeVisible();
      await expect(page.getByTestId("balances")).toHaveCount(0);
      await expect(page.getByTestId("account-empty")).toHaveCount(0);
      await expect(page.getByTestId("account-cash-out")).toHaveCount(0);
      g.open();
      if (name === "empty account") {
        await expect(page.getByTestId("account-empty")).toContainText("Add money to start betting"); // copy unchanged
        await expect(page.getByTestId("balance-row-USDC")).toHaveText("0.00 USDC"); // ACCT2: the rows at 0 under the hero
      }
      else await expect(page.getByTestId("balance-row-USDC")).toHaveText("42.10 USDC");
      await resolved(page, name === "empty account");
      await page.screenshot({ path: `${AFIX1_SHOTS}/resolved-${name.split(" ")[0]}-375.png`, fullPage: true });
    });
  }

  test("AFIX1 the bet list is slow: still the placeholder after the balances arrive (an empty verdict needs the bets too)", async ({ page }) => {
    const g = gate();
    await mock(page, { ...world({ betting: {} }), holdBets: g.p });
    await page.goto("/account"); await ready(page);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("account-loading")).toBeVisible();
    await expect(page.getByTestId("balances")).toHaveCount(0);
    await expect(page.getByTestId("account-empty")).toHaveCount(0);
    g.open();
    await expect(page.getByTestId("account-empty")).toBeVisible();
    await resolved(page, true);
  });

  const SOURCES: [NonNullable<World["fail"]> | "betting", string][] = [
    ["betting", "balance-error"], ["betting-429", "balance-error"], ["near-token", "wallet-amount-USDC"], ["near-native", "wallet-amount-NEAR"],
    ["stray", "stray-error"], ["bets", "bets-error"], ["payouts", "bets-error"],
  ];
  for (const [src, notice] of SOURCES) {
    test(`AFIX1 an all-zero account whose ${src} read fails: its error notice, never "Add money to start betting"`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      // payouts: a Finalized bet I won whose pending_payouts can't be read (the money being paid out must not read as "none").
      const bets = src === "payouts" ? { 2: bet(2, { maker: "bob.testnet", taker: ME, status: "Finalized", outcome: "NO" }) } : {};
      await mock(page, src === "betting" ? world({ betting: {}, bettingFails: true }) : world({ betting: {}, bets, fail: src }));
      await page.goto("/account"); await ready(page);
      // 429 measured ~65 s to the notice: the client waits out Retry-After (>= 1 s) 4x per call, retries the call twice, and every
      // read shares one 350 ms pace. Correct (the placeholder, never "empty") but slow; see spikes/afix1/REPORT.md.
      await expect(page.getByTestId(notice)).toBeVisible({ timeout: src === "betting-429" ? 120_000 : 20_000 });
      await expect(page.getByTestId(notice)).toContainText(/can't read/i);
      // Every read has answered (money and bets): the page shows what it read, with the notice, not a verdict.
      await expect(page.getByTestId("balances")).toBeVisible();
      await expect(page.getByTestId("balance-row-USDC")).not.toHaveText("…");
      await expect(page.getByTestId("account-loading")).toHaveCount(0);
      await expect(page.getByTestId("account-empty")).toHaveCount(0);
      await expect(page.getByText("Add money to start betting")).toHaveCount(0);
      await page.screenshot({ path: `${AFIX1_SHOTS}/unread-${src}.png`, fullPage: true });
    });
  }

  test("AFIX1 FUND1 focus re-read keeps the last good values on screen while it refreshes (never back to the placeholder)", async ({ page }) => {
    const w = world();
    await mock(page, w);
    await page.goto("/account"); await ready(page);
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("42.10 USDC");
    const g = gate();
    w.hold = g.p; w.betting = { ...w.betting, [USDC]: "50000000" };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(1000);
    await expect(page.getByTestId("account-loading")).toHaveCount(0);
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("42.10 USDC");
    g.open();
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("50.00 USDC");
    await resolved(page, false);
  });
});

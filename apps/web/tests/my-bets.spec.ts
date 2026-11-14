// FE14 (S16) + H1 (UIR1 §3.2, familiarcow UX-37 #3/#4, PEOPLE RULE): My Bets on Home. Fully mocked: NEAR RPC views (get_bet,
// pending_payouts, required_challenge_bond), the indexer's /history and /offers, the username registry, wallet seam. No real Privy
// login; no write. "Needs you" first (only those cards have a button, and it opens the page that offers the action), Open offers,
// In progress, Bets you decide; Settled is one collapsed summary row; no Duplicate; people are @usernames, never ids.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { screenPath } from "./lib/screens";
import { ESCROW_CONTRACT_ID } from "../lib/config";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const INDEXER = "http://localhost:8787";
const REG = "http://registry.e2e.test";
const NAMES: Record<string, string> = { [WALLET]: "me", "other.testnet": "olga", "friend.testnet": "fred", "m.testnet": "mia", "t.testnet": "tom" };
const USDC = "nep141:usdc.testnet";
const HOUR = 3_600_000;
const RESOLVE_MS = Date.UTC(2037, 0, 5);

interface World { bets: Record<number, any>; history: any[]; offers: any[]; pending: Record<number, any[]>; indexerDown: boolean; scanDown: boolean; refereeDown: boolean }
const world = (o: Partial<World> = {}): World => ({ bets: {}, history: [], offers: [], pending: {}, indexerDown: false, scanDown: false, refereeDown: false, ...o });

const mk = (id: number, o: { maker?: string; taker?: string | null; status?: string; outcome?: string | null; proposedAt?: number | null; referee?: string | null; allow?: any; fundingMs?: number; claim?: string; makerSide?: string } = {}) => ({
  envelope: { bet_id: id, version: 1, maker: o.maker ?? WALLET, taker_allow: o.allow ?? "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: JSON.stringify({ claimText: o.claim ?? `Claim ${id}` }), outcomes: ["YES", "NO"], maker_side: o.makerSide ?? "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, keep_terms: false, funding_deadline: (o.fundingMs ?? Date.now() - 48 * HOUR) * 1e6, resolve_deadline: RESOLVE_MS * 1e6, settlement_period: 3_600_000_000_000,
    referee: o.referee ? { account: o.referee, mode: "Human" } : null, tip_maker: false },
  status: o.status ?? "Taken", taker: o.taker === undefined ? "other.testnet" : o.taker, created_at: 0, taken_at: null, proposed_at: o.proposedAt ?? null, outcome: o.outcome ?? null, reserve_remaining: "0",
  bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: "0", tip_taker: "0", storage_maker: "20000", storage_taker: "20000", last_resolution_raw: null,
});
const hist = (b: any, id: number) => ({ bet_id: id, maker: b.envelope.maker, taker: b.taker, status: b.status, outcome: b.outcome });

async function setup(page: Page, w: World) {
  await page.addInitScript(({ address, reg }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 2 };
    (window as any).__e2eRegistryUrl = reg;
  }, { address: WALLET, reg: REG });
  await page.route(`${REG}/**`, (route) => {
    const m = /\/lookup\/account\/([^/?]+)/.exec(new URL(route.request().url()).pathname);
    const name = m ? NAMES[decodeURIComponent(m[1]!)] : undefined;
    return name ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ username: name }) })
      : route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "not found" });
  });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": r = false; break;
        case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "0"; break;
        case "required_challenge_bond": r = { amount: "5000000", asset: USDC }; break;
        case "get_bet": r = w.bets[args.bet_id] ?? null; break;
        case "pending_payouts": r = w.pending[args.bet_id] ?? []; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  const json = (route: any, v: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(v) });
  const down = (route: any) => route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "down" });
  await page.route(`${INDEXER}/history**`, (route) => {
    const u = new URL(route.request().url());
    const acct = u.searchParams.get("account");
    const ref = u.searchParams.get("referee");
    if (w.indexerDown) return down(route);
    if (ref) { // IDXREF1: current referee == ref (the bet's own envelope is the truth, as the indexer's amended view is)
      if (w.refereeDown) return down(route);
      return json(route, w.history.filter((h) => w.bets[h.bet_id]?.envelope.referee?.account === ref));
    }
    if (!acct && w.scanDown) return down(route);
    return json(route, acct ? w.history.filter((h) => h.maker === acct || h.taker === acct) : w.history);
  });
  await page.route(`${INDEXER}/offers**`, (route) => (w.indexerDown ? down(route) : json(route, w.offers)));
}
const open = async (page: Page) => { await page.goto("/my-bets"); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); };
const rows = (page: Page) => page.locator("[data-testid=my-bets] [data-testid^='mybet-row-']").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-testid")!.replace("mybet-row-", ""))));
// /my-bets redirects to Home. Groups in order: Needs you, Open offers, In progress, Bets you decide; then the Settled summary row.
const grp = (page: Page, id: string) => page.getByTestId(`mybets-group-${id}`);
const grpRows = (page: Page, id: string) => grp(page, id).locator("[data-testid^='mybet-row-']").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-testid")!.replace("mybet-row-", ""))));
const groupOrder = (page: Page) => page.locator("[data-testid=my-bets] [data-testid^='mybets-group-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("mybets-group-", "")));

function populated(): World {
  const proposedAt = (Date.now() - 1000) * 1e6;
  const bets: Record<number, any> = {
    1: mk(1, { status: "Open", taker: null, fundingMs: Date.now() + 5 * 24 * HOUR, claim: "Open one" }),
    2: mk(2, { status: "Taken", claim: "Live one" }),
    3: mk(3, { status: "Settled", outcome: "YES", proposedAt: 5, claim: "Won one" }),
    4: mk(4, { status: "Finalized", outcome: "YES", proposedAt: 5, claim: "Stuck payout" }),
    5: mk(5, { status: "Proposed", outcome: "NO", proposedAt, claim: "Challengeable" }),
    6: mk(6, { maker: "friend.testnet", status: "Open", taker: null, allow: { Account: WALLET }, fundingMs: Date.now() + 5 * 24 * HOUR, claim: "Made to me" }),
    7: mk(7, { status: "Voided", outcome: "VOID", claim: "Refunded one" }),
    20: mk(20, { maker: "m.testnet", taker: "t.testnet", referee: WALLET, claim: "I decide this" }),
    21: mk(21, { maker: "m.testnet", taker: "t.testnet", referee: "else.testnet", claim: "Not mine" }),
  };
  return world({
    bets,
    history: [1, 2, 3, 4, 5, 7, 20, 21].map((i) => hist(bets[i], i)),
    offers: [{ bet_id: 6, maker: "friend.testnet", taker_allow: JSON.stringify({ Account: WALLET }) }, { bet_id: 99, maker: "z.testnet", taker_allow: "Any" }],
    pending: { 4: [{ id: 1, bet_id: 4, token_id: USDC, receiver: WALLET, amount: "19000000", reason: "payout_winner", attempts: 2, done: false, in_flight: false }] },
  });
}

test.describe("H1 My Bets (FE14 S16, NAV1 Home section)", () => {
  test("everything empty: the first-bet message with a Create bet button; no groups, no Settled row", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("mybets-empty")).toHaveText(/You haven't made a bet yet\./);
    expect(await rows(page)).toEqual([]);
    expect(await groupOrder(page)).toEqual([]);
    await expect(page.getByTestId("mybets-settled")).toHaveCount(0);
    await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" })); // the create form's token list
    await page.getByTestId("mybets-create").click();
    await expect(page).toHaveURL(/\/new$/);
  });

  test("only settled bets: no groups, just the collapsed 'Settled (1) · won 1' row; no empty state", async ({ page }) => {
    const b = { 3: mk(3, { status: "Settled", outcome: "YES", proposedAt: 5 }) };
    await setup(page, world({ bets: b, history: [hist(b[3], 3)] }));
    await open(page);
    await expect(page.getByTestId("mybets-settled")).toBeVisible();
    expect(await groupOrder(page)).toEqual([]);
    await expect(page.getByTestId("mybets-settled").locator("summary")).toContainText("Settled (1)");
    await expect(page.getByTestId("mybets-settled-summary")).toHaveText("won 1");
    await expect(page.getByTestId("mybets-empty")).toHaveCount(0);
  });

  test("populated: Needs you first (newest first), then Open offers, In progress; Settled collapsed with its summary", async ({ page }) => {
    await setup(page, populated());
    await open(page);
    await expect.poll(() => groupOrder(page)).toEqual(["needs", "open", "progress"]);
    expect(await grpRows(page, "needs")).toEqual([20, 6, 5, 4]);
    expect(await grpRows(page, "open")).toEqual([1]);
    expect(await grpRows(page, "progress")).toEqual([2]);
    await expect(grp(page, "needs").locator("h3")).toHaveText("Needs you (4)");
    // Settled: one summary row, collapsed; opening it shows the compact cards
    const settled = page.getByTestId("mybets-settled");
    await expect(settled).not.toHaveAttribute("open", "");
    await expect(settled.locator("summary")).toContainText("Settled (2)");
    await expect(page.getByTestId("mybets-settled-summary")).toHaveText("won 1 · refunded 1");
    await expect(page.getByTestId("mybet-row-3")).toBeHidden();
    await settled.locator("summary").click();
    await expect(page.getByTestId("mybet-row-3")).toBeVisible();
    await expect(page.getByTestId("mybet-row-3")).toHaveAttribute("data-variant", "compact");
    await expect(page.getByTestId("mybet-row-3").locator("[data-kit=StatusPill]")).toHaveText("Won");
    await expect(page.getByTestId("mybet-row-7").locator("[data-kit=StatusPill]")).toHaveText("Refunded");
  });

  test("card: pill, question, my side + stake vs @username, who decides; the whole card opens the bet", async ({ page }) => {
    await setup(page, populated());
    await open(page);
    const live = page.getByTestId("mybet-row-2");
    await expect(live).toHaveAttribute("data-variant", "mine");
    await expect(live.locator("[data-kit=StatusPill]")).toHaveText("Waiting for result"); // betView's pill: the event date has passed
    await expect(live.locator(".k-card__q")).toHaveText("Live one");
    await expect(live.locator("[data-kit=Sides]")).toContainText("You");
    await expect(live.locator("[data-kit=Sides]")).toContainText("YES");
    await expect(live.locator("[data-kit=Sides]")).toContainText("10.00 USDC");
    await expect(live.locator("[data-kit=Sides]")).toContainText("@olga");
    await expect(page.getByTestId("mybet-row-1").locator("[data-kit=Sides]")).toContainText("Anyone"); // nobody took it yet
    await expect(page.getByTestId("mybet-row-1").locator("[data-kit=TimeLeft]")).toContainText(/in 4 days|in 5 days/); // relative, not raw UTC
    await live.locator(".k-card__link").click();
    await expect(page).toHaveURL(/\/bet\/2$/);
  });

  test("PEOPLE RULE: no raw account id anywhere in My Bets; an unnamed person is 'Unnamed account'", async ({ page }) => {
    const w = populated();
    w.bets[2].taker = "nobody-registered.testnet"; w.history.find((h) => h.bet_id === 2)!.taker = "nobody-registered.testnet";
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("mybet-row-2").locator("[data-kit=Sides]")).toContainText("Unnamed account");
    await page.getByTestId("mybets-settled").locator("summary").click();
    const text = await page.getByTestId("my-bets").innerText();
    expect(text).not.toMatch(/\.testnet|\.near\b|[0-9a-f]{64}/);
  });

  test("only Needs you cards have a button (Challenge / Retry payout / Take / Rule now); no Duplicate anywhere on Home", async ({ page }) => {
    await setup(page, populated());
    await open(page);
    await expect.poll(() => grpRows(page, "needs")).toEqual([20, 6, 5, 4]);
    await expect(page.getByTestId("mybet-row-5").getByTestId("action-challenge")).toHaveText("Challenge the ruling");
    await expect(page.getByTestId("mybet-row-4").getByTestId("action-retry-payout")).toHaveText("Retry payout");
    await expect(page.getByTestId("mybet-row-6").getByTestId("action-take")).toHaveText("Take this bet");
    await expect(page.getByTestId("mybet-row-20").getByTestId("action-rule")).toHaveText("Rule now");
    await expect(page.getByTestId("mybet-row-20")).toHaveAttribute("data-variant", "decide");
    for (const id of [1, 2]) await expect(page.getByTestId(`mybet-row-${id}`).locator("[data-kit=ActionBar]")).toHaveCount(0);
    await page.getByTestId("mybets-settled").locator("summary").click();
    await expect(page.getByTestId("mybet-row-3").locator("[data-kit=ActionBar]")).toHaveCount(0);
    await expect(page.getByTestId("home").getByRole("button", { name: /duplicate/i })).toHaveCount(0);
  });

  test("a Needs you button opens the bet page that offers that action", async ({ page }) => {
    await setup(page, populated());
    await open(page);
    await page.getByTestId("mybet-row-5").getByTestId("action-challenge").click();
    await expect(page).toHaveURL(/\/bet\/5$/);
    await expect(page.getByTestId("challenge-btn")).toBeVisible();
    await page.goBack();
    await page.getByTestId("mybet-row-4").getByTestId("action-retry-payout").click();
    await expect(page).toHaveURL(/\/bet\/4$/);
    await expect(page.getByTestId("payout-retry-btn")).toBeVisible();
    await page.goBack();
    await page.getByTestId("mybet-row-20").getByTestId("action-rule").click();
    await expect(page).toHaveURL(/\/bet\/20$/);
    await expect(page.getByTestId("referee-banner")).toBeVisible();
    await page.goBack();
    await page.getByTestId("mybet-row-6").getByTestId("action-take").click();
    await expect(page).toHaveURL(/\/bet\/6$/);
    await expect(page.getByTestId("take-section")).toBeVisible();
  });

  test("Bets you decide: a bet that names me but can't be ruled yet; the one I can rule now is under Needs you", async ({ page }) => {
    const w = populated();
    w.bets[22] = mk(22, { maker: "m.testnet", taker: "t.testnet", referee: WALLET, claim: "Later", fundingMs: Date.now() + 5 * 24 * HOUR });
    w.history.push(hist(w.bets[22], 22));
    await setup(page, w);
    await open(page);
    await expect.poll(() => grpRows(page, "decide")).toEqual([22]);
    const r = page.getByTestId("mybet-row-22");
    await expect(r).toHaveAttribute("data-variant", "decide");
    await expect(r.locator("[data-kit=Sides]")).toContainText("@mia");
    await expect(r.locator("[data-kit=Sides]")).toContainText("@tom");
    await expect(r.locator("[data-kit=ActionBar]")).toHaveCount(0);
    expect(await grpRows(page, "needs")).toContain(20);
  });

  test("indexer down: plain error and Retry brings the list back", async ({ page }) => {
    const w = populated();
    w.indexerDown = true;
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("mybets-error")).toHaveText(/We can't load your bets\./);
    await expect(page.getByTestId("mybets-empty")).toHaveCount(0);
    w.indexerDown = false;
    await page.getByTestId("mybets-retry").click();
    await expect(page.getByTestId("mybets-error")).toHaveCount(0);
    await expect.poll(() => grpRows(page, "needs")).toEqual([20, 6, 5, 4]);
  });

  test("exact referee list down but the scan works: fallback lists what it finds AND shows 'may be incomplete'", async ({ page }) => {
    const w = populated();
    w.refereeDown = true;
    await setup(page, w);
    await open(page);
    await expect.poll(() => grpRows(page, "needs")).toContain(20); // the scan still finds the rule item
    await expect(page.getByTestId("mybets-incomplete")).toContainText("may be incomplete");
  });

  test("exact list and scan both down: my groups still load, the referee part shows its own error", async ({ page }) => {
    const w = populated();
    w.refereeDown = true; w.scanDown = true;
    await setup(page, w);
    await open(page);
    await expect.poll(() => grpRows(page, "needs")).toEqual([6, 5, 4]); // 20 (I only referee it) comes from the referee lists
    await expect(page.getByTestId("mybets-referee-error")).toHaveText(/We can't load the bets you decide\./);
    await expect(page.getByTestId("mybets-error")).toHaveCount(0);
  });

  test("exact list: an older bet beyond the newest 50 is still listed; no incomplete note", async ({ page }) => {
    const w = populated();
    w.bets[3] = mk(3, { maker: "m.testnet", taker: "t.testnet", referee: WALLET, claim: "Very old", fundingMs: Date.now() + 5 * 24 * HOUR });
    w.history = [hist(w.bets[3], 3)];
    for (let i = 100; i < 160; i++) { w.bets[i] = mk(i, { maker: "m.testnet", taker: "t.testnet", referee: "else.testnet" }); w.history.push(hist(w.bets[i], i)); }
    await setup(page, w);
    await open(page);
    await expect.poll(() => grpRows(page, "decide")).toEqual([3]);
    await expect(page.getByTestId("mybets-incomplete")).toHaveCount(0);
  });

  test("amended-away referee is no longer listed", async ({ page }) => {
    const w = populated();
    w.bets[20].envelope.referee = { account: "new.testnet", mode: "Human" };
    await setup(page, w);
    await open(page);
    await expect.poll(() => grpRows(page, "needs")).toEqual([6, 5, 4]);
    await expect(grp(page, "decide")).toHaveCount(0);
    await expect(page.getByTestId("mybet-row-20")).toHaveCount(0);
  });

  test("refresh: 'Updated just now' (exact local + UTC on hover) and the button reloads the list", async ({ page }) => {
    const w = populated();
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("mybets-updated")).toHaveText("Updated just now");
    await expect(page.getByTestId("mybets-refresh")).toHaveAttribute("title", /UTC$/);
    w.bets[2] = mk(2, { status: "Taken", claim: "Live one, reloaded" }); // the next get_bet sees the change
    await page.getByTestId("mybets-refresh").click();
    await expect(page.getByTestId("mybet-row-2").locator(".k-card__q")).toHaveText("Live one, reloaded");
  });

  // H1 screenshots: the whole Home (My Bets with Needs you + Settled row, Explore with chips, In progress = others only).
  for (const [w, h] of [[375, 1600], [1280, 1400]] as const) {
    test(`screenshots: Home at ${w}px (Settled closed, then open)`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      const world = populated();
      world.bets[30] = mk(30, { maker: "friend.testnet", status: "Open", taker: null, fundingMs: Date.now() + 2 * 24 * HOUR, claim: "ETH trades above 6,000 USD on Coinbase before 1 Jan 2027" });
      world.bets[31] = mk(31, { maker: "m.testnet", status: "Open", taker: null, fundingMs: Date.now() + 26 * HOUR, claim: "It snows in central London on 1 Dec 2026 (Met Office)" });
      world.offers.push({ bet_id: 30, maker: "friend.testnet", taker_allow: "Any", contract_id: ESCROW_CONTRACT_ID }, { bet_id: 31, maker: "m.testnet", taker_allow: "Any", contract_id: ESCROW_CONTRACT_ID });
      await setup(page, world);
      await open(page);
      await expect.poll(() => grpRows(page, "needs")).toEqual([20, 6, 5, 4]);
      await expect(page.getByTestId("progress-row-21")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: screenPath(`h1/home-${w}.png`), fullPage: true });
      await page.getByTestId("mybets-settled").locator("summary").click();
      await page.getByTestId("my-bets").screenshot({ path: screenPath(`h1/mybets-settled-open-${w}.png`) });
    });
  }
});

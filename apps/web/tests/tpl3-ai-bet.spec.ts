// TPL3 (familiarcow 11-12): the custom bet form without the "controlled by a bettor" box, the "Write it with your AI" link + Copy
// prompt, the "Paste from your AI" box (valid / invalid / missing / extra fields) and the public /guide/custom-bet page.
// Fully mocked like bet-type-picker.spec (NEAR RPC via page.route, wallet via window.__e2eTestWallet); 375 shots -> test-results/screens/tpl3 (TPL3_SHOTS=1: spikes/tpl3/shots).
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fillDeadlineUtc, openMoreOptions } from "./betDetailsHelpers";
import { BET_EXAMPLES, BET_PROMPT } from "../lib/betPrompt";
import { utcToLocalInput } from "../lib/betDetails";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
// PUB1: default = gitignored apps/web/test-results/screens/tpl3 (tree stays clean); TPL3_SHOTS=1 regenerates the tracked spikes/tpl3/shots.
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), process.env.TPL3_SHOTS === "1" ? "../../../spikes/tpl3/shots" : "../test-results/screens/tpl3");
const shot = async (page: Page, name: string) => { if (page.viewportSize()?.width === 375) await page.screenshot({ path: join(SHOTS, `${name}-375.png`), fullPage: true }); };

async function mockRpc(page: Page) {
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const name = params.method_name;
      const r = name === "is_paused" || name === "is_shutdown" ? false : name === "open_offers" ? [] : name === "asset_limit" ? { storage_per_kib: "1" } : null;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 100000 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
}

async function openCustom(page: Page) {
  await page.addInitScript(({ address, sig }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; }, { address: WALLET, sig: SIG });
  await mockRpc(page);
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await page.getByTestId("bet-type-card-custom").click();
  await expect(page.getByTestId("custom-builder")).toBeVisible();
}

const paste = async (page: Page, text: string) => {
  if ((await page.getByTestId("ai-paste-toggle").getAttribute("aria-expanded")) !== "true") await page.getByTestId("ai-paste-toggle").click();
  await page.getByTestId("ai-paste").fill(text);
  await page.getByTestId("ai-paste-fill").click();
};

const VALID = BET_EXAMPLES[0]!.json;

for (const width of [375, 1280]) {
  test.describe(`TPL3 custom bet form + AI paste @${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("no 'controlled by a bettor' box anywhere; Sources says to use public sources neither of you can edit", async ({ page }) => {
      await openCustom(page);
      await expect(page.getByTestId("cb-sources-public")).toHaveText("Use public sources neither of you can edit.");
      await openMoreOptions(page);
      await expect(page.getByTestId("cb-sources")).toBeVisible();
      await expect(page.locator('[data-testid^="cb-source-party-"]')).toHaveCount(0);
      await expect(page.getByText(/controlled by a bettor/i)).toHaveCount(0);
      await shot(page, "form-more-options");
    });

    test("'Write it with your AI': the guide link opens /guide/custom-bet in a new tab; Copy prompt copies the exact prompt", async ({ page, context }) => {
      await openCustom(page);
      const link = page.getByTestId("ai-guide-link");
      await expect(link).toHaveAttribute("href", "/guide/custom-bet");
      await expect(link).toHaveAttribute("target", "_blank");
      await shot(page, "form-ai-box");
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.getByTestId("ai-copy-prompt").click();
      await expect(page.getByTestId("ai-copy-prompt")).toHaveText("Copied");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(BET_PROMPT);
    });

    test("paste valid JSON (in ```json fences): fills claim, deadline, sources, question and rules; the checks pass and Next unlocks", async ({ page }) => {
      await openCustom(page);
      await paste(page, "Here you go:\n```json\n" + JSON.stringify(VALID, null, 2) + "\n```");
      await expect(page.getByTestId("ai-paste-error")).toHaveCount(0);
      await expect(page.getByTestId("ai-paste-done")).toContainText("Filled in");
      await expect(page.getByTestId("cb-claim")).toHaveValue(String(VALID.claim));
      await expect(page.getByTestId("cb-deadline")).toHaveValue(utcToLocalInput("2027-12-31T23:59"));
      await expect(page.getByTestId("cb-source-url-0")).toHaveValue("https://www.apple.com/newsroom/");
      await expect(page.getByTestId("cb-source-url-1")).toHaveValue("https://www.reuters.com/technology/");
      await openMoreOptions(page);
      await expect(page.getByTestId("cb-element-0")).toHaveValue(String(VALID.question));
      await expect(page.getByTestId("cb-leading")).toHaveValue((VALID.what_counts as string[]).join("\n"));
      await expect(page.getByTestId("cb-source-publisher-0")).toHaveValue("Apple Newsroom");
      await expect(page.getByTestId("fill-error")).toHaveCount(0);
      await expect(page.getByTestId("fill-next")).toBeEnabled();
      await shot(page, "paste-valid");
      await page.getByTestId("fill-next").click();
      await expect(page.getByTestId("step-resolver")).toBeVisible();
    });

    test("paste invalid JSON: one plain error, the form is left exactly as it was", async ({ page }) => {
      await openCustom(page);
      await page.getByTestId("cb-claim").fill("Typed by hand before the paste.");
      await paste(page, '{ "claim": "half a bet", ');
      await expect(page.getByTestId("ai-paste-error")).toContainText("That isn't the bet from the prompt");
      await expect(page.getByTestId("ai-paste-error")).not.toContainText(/JSON\.parse|SyntaxError|Unexpected/);
      await expect(page.getByTestId("cb-claim")).toHaveValue("Typed by hand before the paste.");
      await expect(page.getByTestId("ai-paste")).toHaveValue('{ "claim": "half a bet", '); // kept, so it can be fixed
      await shot(page, "paste-invalid");
    });

    test("paste with missing fields: names them, never a partial fill", async ({ page }) => {
      await openCustom(page);
      await paste(page, JSON.stringify({ claim: "Only a claim, by December 31, 2027." }));
      await expect(page.getByTestId("ai-paste-error")).toContainText("Your AI left out deadline_utc, sources");
      await expect(page.getByTestId("cb-claim")).toHaveValue("");
      await expect(page.getByTestId("cb-deadline")).toHaveValue("");
    });

    test("paste with extra fields: they are ignored (and named); the known fields fill", async ({ page }) => {
      await openCustom(page);
      await paste(page, JSON.stringify({ ...VALID, judge_model: "x", party_controlled: true }));
      await expect(page.getByTestId("ai-paste-done")).toHaveText("Filled in. Ignored: judge_model, party_controlled.");
      await expect(page.getByTestId("cb-claim")).toHaveValue(String(VALID.claim));
      await expect(page.getByTestId("fill-next")).toBeEnabled();
    });

    test("a pasted bet the checks refuse fills in and shows the normal problems at once (paste never bypasses them)", async ({ page }) => {
      await openCustom(page);
      await paste(page, JSON.stringify({ ...VALID, claim: "I post a video by December 31, 2027." }));
      await expect(page.getByTestId("cb-claim")).toHaveValue("I post a video by December 31, 2027.");
      await expect(page.getByTestId("fill-error")).toContainText("Bet on something neither of you controls");
      await expect(page.getByTestId("fill-next")).toHaveAttribute("aria-disabled", "true");
      await shot(page, "paste-refused");
    });

    test("typing still works the same after the AI box: claim + deadline + two links unlock Next", async ({ page }) => {
      await openCustom(page);
      await page.getByTestId("cb-claim").fill("Apple makes a foldable iPhone available to buy in the US during 2027.");
      await fillDeadlineUtc(page, "2027-12-31T23:59");
      await page.getByTestId("cb-source-url-0").fill("https://www.apple.com/newsroom/");
      await page.getByTestId("cb-source-url-1").fill("https://www.reuters.com/");
      await expect(page.getByTestId("fill-next")).toBeEnabled();
    });

    test("/guide/custom-bet is public: logged out it shows the guide (prompt, rules, 3 examples), not the login page", async ({ page }) => {
      await mockRpc(page);
      await page.goto("/guide/custom-bet");
      await expect(page.getByTestId("guide-page")).toBeVisible();
      await expect(page.getByTestId("login-gate")).toHaveCount(0);
      await expect(page.getByTestId("guide-prompt")).toHaveText(BET_PROMPT);
      await expect(page.getByTestId("guide-page")).toContainText("Use public sources neither of you can edit");
      for (let i = 0; i < 3; i++) await expect(page.getByTestId(`guide-example-${i}`)).toBeVisible();
      // the steps read as a numbered list and the rules as bullets (the CSS reset strips list markers)
      await expect(page.getByTestId("guide-steps")).toHaveCSS("list-style-type", "decimal");
      await expect(page.getByTestId("guide-rules")).toHaveCSS("list-style-type", "disc");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(page, "guide");
      await page.goto("/new"); // every other route is still behind the login page
      await expect(page.getByTestId("login-gate")).toBeVisible();
    });
  });
}

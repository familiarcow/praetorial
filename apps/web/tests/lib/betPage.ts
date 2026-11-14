// B1 (UIR1 §3.5, familiarcow UX-37 #4 #9, familiarcow 2026-11-11 "people are @usernames everywhere"): shared steps for specs that drive the
// rebuilt bet page.
//   openMoreActions: concede, cancel, add evidence, change who decides and Duplicate live under the collapsed "More actions"
//                    disclosure now, so a person (and a spec) opens it first. It asserts the disclosure really opens.
//   mockUsernames:   the page names people by their Praetorial @username (registry /lookup/account). Specs that check a person's
//                    name give every *.testnet account the username before the dot ("taker.testnet" -> "@taker"), any other account
//                    "@me", unless told otherwise (null = no username).
import { expect, type Page } from "@playwright/test";

export async function openMoreActions(page: Page): Promise<void> {
  const more = page.getByTestId("more-actions");
  await expect(more).toBeVisible();
  if (!(await more.evaluate((d) => (d as HTMLDetailsElement).open))) await more.locator("summary").first().click();
  await expect(more).toHaveJSProperty("open", true);
}

export const E2E_REGISTRY = "http://names.e2e.test";
// Any other account (the signed-in test wallet's implicit id) is "me", so the app's claim-a-username gate stays out of the way.
export const usernameOf = (account: string): string | null =>
  /^[a-z0-9_-]+\.testnet$/.test(account) ? account.replace(/\.testnet$/, "").replace(/[^a-z0-9_]/g, "_") : "me";

/** Call before page.goto. `names` overrides/extends the default "<name>.testnet -> name" rule (null = no username). */
export async function mockUsernames(page: Page, names: Record<string, string | null> = {}): Promise<void> {
  await page.addInitScript((reg) => { const w = window as any; if (!w.__e2eRegistryUrl) w.__e2eRegistryUrl = reg; }, E2E_REGISTRY);
  await page.route(`${E2E_REGISTRY}/**`, async (route) => {
    const url = new URL(route.request().url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (url.pathname.startsWith("/lookup/account/")) {
      const account = decodeURIComponent(url.pathname.slice("/lookup/account/".length));
      const username = account in names ? names[account] : usernameOf(account);
      return username ? json(200, { username, account }) : json(404, { error: "not found" });
    }
    if (url.pathname.startsWith("/lookup/username/")) {
      const q = decodeURIComponent(url.pathname.slice("/lookup/username/".length)).replace(/^@/, "").toLowerCase();
      const hit = Object.entries(names).find(([, u]) => u === q)?.[0] ?? (/^[a-z0-9_]+$/.test(q) ? `${q}.testnet` : null);
      return hit ? json(200, { username: q, account_id: hit }) : json(404, { error: "not found" });
    }
    return json(200, []);
  });
}

// BET1a: shared e2e helpers for the "any web page" Details step (claim + deadline + 2 links shown; the rest under More options).
import { expect, type Page } from "@playwright/test";
import { utcToLocalInput } from "../lib/betDetails";

/** Open "More options" (idempotent). */
export async function openMoreOptions(page: Page) {
  const t = page.getByTestId("details-more-toggle");
  if ((await t.getAttribute("aria-expanded")) !== "true") await t.click();
  await expect(page.getByTestId("details-more")).toBeVisible();
}

/** The deadline is typed in local time; tests think in UTC. The browser and this process share the host time zone. */
export async function fillDeadlineUtc(page: Page, utcMinute: string) {
  await page.getByTestId("cb-deadline").fill(utcToLocalInput(utcMinute));
}

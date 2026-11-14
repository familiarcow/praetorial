// TPL1 (PM 14:05, familiarcow): the price types sit under the "Asset prices" tile. Opening one from the main picker takes two taps.
import { type Page } from "@playwright/test";

export const PRICE_IDS = ["btc_close_at_t", "btc_touch", "outperform"];
/** Open a bet type the way a user does: a price type through "Asset prices" (unless its sub-choice is already open). */
export async function openBetType(page: Page, id: string) {
  if (PRICE_IDS.includes(id) && (await page.getByTestId("bet-type-prices").count()) === 0) await page.getByTestId("bet-type-card-prices").click();
  await page.getByTestId(`bet-type-card-${id}`).click();
}

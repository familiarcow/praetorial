// FE3b Q5: drives the REAL custom ("any web page") builder, field by field, to the D-DEMO1 canonical sheet
// (services/e2e/live-run8/jason_terms_with_urls.json). No preset button, no deep link: every value is typed into a general builder field.
import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalTerms, termsHash } from "../lib/templates";
import { fillDeadlineUtc, openMoreOptions } from "./betDetailsHelpers";

const here = dirname(fileURLToPath(import.meta.url));
export const CANON: any = JSON.parse(readFileSync(join(here, "../../../services/e2e/live-run8/jason_terms_with_urls.json"), "utf8"));
export const CANON_HASH = termsHash(canonicalTerms(CANON));
const t = (id: string) => (p: Page) => p.getByTestId(id);

export async function fillCanonicalCustom(page: Page) {
  const d: string[] = CANON.custom_definitions;
  const slice = (iso: string) => iso.slice(0, 16);
  await page.getByTestId("cb-claim").fill(CANON.claim);
  // BET1a: the deadline (local time) and the first two links are on the main Details view; the rest is under More options.
  await fillDeadlineUtc(page, slice(CANON.time.window_end));
  await openMoreOptions(page);
  await page.getByTestId("cb-element-0").fill(CANON.elements[0].q);
  await page.getByTestId("cb-add-source").click();
  const tier = CANON.source_classes, pins = CANON.ticker_pins;
  for (let i = 0; i < CANON.sources_allowed.length; i++) {
    const s = CANON.sources_allowed[i];
    await page.getByTestId(`cb-source-publisher-${i}`).fill(s.publisher);
    await page.getByTestId(`cb-source-url-${i}`).fill(s.url);
    await page.getByTestId(`cb-source-id-${i}`).locator("xpath=ancestor::details").locator("summary").click();
    await page.getByTestId(`cb-source-id-${i}`).fill(s.id);
    await page.getByTestId(`cb-source-tier-${i}`).selectOption(tier[s.publisher]);
    await page.getByTestId(`cb-source-ticker-${i}`).fill(pins[s.publisher]);
  }
  await page.getByTestId("cb-windowStart").fill(slice(CANON.time.window_start));
  await page.getByTestId("cb-evidenceCutoff").fill(slice(CANON.time.evidence_cutoff));
  await page.getByTestId("cb-windowClose").fill(slice(CANON.window_close));
  await page.getByTestId("cb-leading").fill(d.slice(0, 4).join("\n"));
  await page.getByTestId("cb-fallback").fill(d[4]);
  await page.getByTestId("cb-early").fill("");
  await page.getByTestId("cb-other").fill(d.slice(5).join("\n"));
  await page.getByTestId("cb-clause-PARTIAL_NONE_V1").locator("xpath=ancestor::details").locator("summary").click(); // BET1a: standard rules are collapsed
  await page.getByTestId("cb-clause-PARTIAL_NONE_V1").uncheck();
  for (const c of CANON.clauses.slice(1)) await page.getByTestId(`cb-clause-${c}`).check();
  const notes = Object.keys(CANON).filter((k) => k.startsWith("_"));
  for (let i = 0; i < notes.length; i++) {
    await page.getByTestId("cb-add-note").click();
    await page.getByTestId(`cb-note-name-${i}`).fill(notes[i].slice(1));
    await page.getByTestId(`cb-note-text-${i}`).fill(CANON[notes[i]]);
  }
}
void t;

// Q1 (UIR1 §4 Q1, familiarcow UX-37): the per-screen regression checks of the visual gate.
//   1. No horizontal scroll: the page (and every open dialog) is no wider than the viewport, and no visible element sticks out past
//      its right edge (that is cut-off content inside a clipped sheet).
//   2. No raw machine values in what the user can read (document.body.innerText: closed <details> and hidden nodes are not in it):
//      asset ids (nep141:/nep245:/1cs_v1:), raw account ids (64-hex implicit, *.near/*.testnet names, 0x addresses),
//      base units (a bare integer of 7+ digits, more than 8 decimals, 1e-7 notation) and broken values (undefined, NaN, [object Object]).
//      A raw id/address is allowed only where familiarcow allows it (UX-37: "raw account ids/addresses only in Account > funding/cash-out and
//      Details"; amounts "exact in Details"): Add money / Cash out / the opened "Account details" row pass the exact strings in `allow`;
//      an opened bet Details region is passed in `details` (ids and exact amounts allowed there). Asset ids, bare base-unit integers
//      and broken values are never allowed anywhere.
import { expect, type Page } from "@playwright/test";

export interface Finding { rule: string; match: string; context: string }

// `strict: true` rules are lifted inside a Details region (raw ids and exact amounts belong there).
const RULES: Array<{ rule: string; re: RegExp; strict?: boolean }> = [
  { rule: "asset id", strict: false, re: /\b(?:nep141|nep245|nep171|1cs_v1):\S*/gi },
  { rule: "raw account id (64-hex)", strict: true, re: /\b[0-9a-f]{64}\b/gi },
  { rule: "raw account id (.near/.testnet)", strict: true, re: /\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:near|testnet)\b/gi },
  { rule: "raw address (0x)", strict: true, re: /\b0x[0-9a-f]{40}\b/gi },
  { rule: "base units (bare integer >= 7 digits)", re: /(?<![\w.,])\d{7,}(?![\w,]|\.\d)/g },
  // A token amount at <= 6 significant digits never needs more than 12 decimals (0.00000679 BTC is fine); 1e-19 NEAR is base units.
  { rule: "base units (> 12 decimals)", strict: true, re: /\d\.\d{13,}/g },
  { rule: "scientific notation", re: /\b\d(?:\.\d+)?e[-+]?\d+\b/gi },
  { rule: "broken value", re: /\b(?:undefined|NaN)\b|\[object Object\]/g },
];

/** Pure: every forbidden value in `text` once the `allow`ed exact strings are taken out. */
export function scanText(text: string, allow: readonly string[] = [], inDetails = false): Finding[] {
  let t = text;
  for (const a of allow) if (a) t = t.split(a).join(" ");
  const out: Finding[] = [];
  for (const { rule, re, strict } of RULES) {
    if (inDetails && strict) continue;
    for (const m of t.matchAll(re)) {
      const i = m.index ?? 0;
      out.push({ rule, match: m[0], context: t.slice(Math.max(0, i - 40), i + m[0].length + 40).replace(/\s+/g, " ") });
    }
    t = t.replace(re, " "); // one finding per value (nep141:wrap.near is an asset id, not also a .near account)
  }
  return out;
}

/** In the page: what overflows sideways (page, open dialogs, visible elements past the right edge). */
export async function overflowAt(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    const sw = document.documentElement.scrollWidth;
    if (sw > vw) out.push(`page scrollWidth ${sw} > ${vw}`);
    const label = (el: Element) => {
      const tid = el.closest("[data-testid]")?.getAttribute("data-testid");
      return `<${el.tagName.toLowerCase()}${tid ? ` in [data-testid=${tid}]` : ""}> "${(el.textContent ?? "").trim().slice(0, 50)}"`;
    };
    const all = Array.from(document.body.querySelectorAll("*")) as HTMLElement[];
    const shown = (el: HTMLElement) => el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true } as any) && !el.closest("[aria-hidden=true], [data-q1-offscreen-ok]");
    // A box that scrolls sideways (anywhere: page or sheet) is a horizontal scroll.
    const scrollers = new Set<Element>();
    for (const el of all) {
      const cs = getComputedStyle(el);
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1 && shown(el)) {
        scrollers.add(el);
        out.push(`scrolls sideways (${el.scrollWidth} > ${el.clientWidth}): ${label(el)}`);
      }
    }
    // A visible element whose box ends past the viewport's right edge (or starts before its left edge) is cut off, unless an ancestor
    // truncates it on purpose (overflow hidden + text-overflow: ellipsis shows "…") or is a scroller already reported above.
    const reported = new Set<Element>();
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || (r.right <= vw + 1 && r.left >= -1)) continue;
      if (!shown(el)) continue;
      let p: HTMLElement | null = el, excused = false;
      while (p && p !== document.body) {
        if (reported.has(p) || scrollers.has(p)) { excused = true; break; }
        if (p !== el) {
          const cs = getComputedStyle(p);
          if (cs.overflowX !== "visible" && cs.textOverflow === "ellipsis") { excused = true; break; }
        }
        p = p.parentElement;
      }
      reported.add(el);
      if (!excused) out.push(`sticks out (${Math.round(r.left)}..${Math.round(r.right)} of ${vw}): ${label(el)}`);
    }
    return out;
  });
}

/** In the page: the text the user can read (innerText: closed <details>, display:none and hidden nodes are not in it), split into the
 * Details regions matched by `details` (selectors) and everything else. */
export async function visibleText(page: Page, details: readonly string[] = []): Promise<{ main: string; details: string }> {
  return page.evaluate((sels) => {
    const regions = sels.flatMap((s) => Array.from(document.querySelectorAll<HTMLElement>(s)));
    const det = regions.map((r) => r.innerText).join("\n");
    const prev = regions.map((r) => r.style.display);
    regions.forEach((r) => (r.style.display = "none"));
    const main = document.body.innerText;
    regions.forEach((r, i) => (r.style.display = prev[i]!));
    return { main, details: det };
  }, [...details]);
}

export interface ScreenOpts {
  /** Exact strings familiarcow allows on this screen (the user's own id, one-time deposit / destination addresses). */
  allow?: readonly string[];
  /** Selectors of opened Details regions: raw ids and exact amounts are allowed inside them. */
  details?: readonly string[];
  dialog?: boolean;
}
export const SHOTS_DIR = process.env.VISUAL_SHOTS ?? "test-results/visual";

/** Screenshot + both checks. Soft expectations: one screen reports every problem it has, and the test still fails. */
export async function checkScreen(page: Page, name: string, width: number, o: ScreenOpts = {}) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.evaluate(() => document.fonts.ready);
  const dialog = o.dialog || (await page.locator("dialog[open]").count()) > 0;
  await page.screenshot({ path: `${SHOTS_DIR}/${name}-${width}.png`, fullPage: !dialog });
  const overflow = await overflowAt(page);
  const text = await visibleText(page, o.details ?? []);
  const found = [...scanText(text.main, o.allow ?? []), ...scanText(text.details, o.allow ?? [], true)];
  expect.soft(found.map((f) => `${f.rule}: "${f.match}" in "…${f.context}…"`), `${name} @${width}: raw values on screen`).toEqual([]);
  expect.soft(overflow, `${name} @${width}: horizontal scroll / cut-off`).toEqual([]);
}

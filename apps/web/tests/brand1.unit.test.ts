// BRAND1: the praetorial brand's token pairs pass WCAG AA, status tones stay distinct from each other and from the brand accent,
// and the one switch (src/theme/brand.ts) resolves classic | praetorial. spikes/brand1/REPORT.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRAETEXTA, STATUS_PAIRS, TEXT_PAIRS, type PraetextaToken } from "../src/theme/brandTokens";
import { resolveBrand, DEFAULT_BRAND } from "../src/theme/brand";

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  assert.ok(/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h), `not a #rrggbb[aa] colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function hue(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
const v = (t: PraetextaToken) => PRAETEXTA[t];

test("contrast helper matches WCAG reference values", () => {
  assert.equal(Math.round(contrast("#000000", "#ffffff") * 10) / 10, 21);
  assert.equal(Math.round(contrast("#777777", "#ffffff") * 100) / 100, 4.48);
});

test("every status pill (won / lost / void / pending / challenged) passes AA (4.5:1) for its text on its tint", () => {
  for (const [name, [bg, fg]] of Object.entries(STATUS_PAIRS)) {
    const c = contrast(v(bg), v(fg));
    assert.ok(c >= 4.5, `${name}: ${fg} ${v(fg)} on ${bg} ${v(bg)} is ${c.toFixed(2)}:1`);
  }
});

test("every text-on-surface pair the brand uses passes AA (4.5:1)", () => {
  for (const [bg, fg] of TEXT_PAIRS) {
    const c = contrast(v(bg), v(fg));
    assert.ok(c >= 4.5, `${fg} ${v(fg)} on ${bg} ${v(bg)} is ${c.toFixed(2)}:1`);
  }
});

test("UI accents meet the 3:1 non-text minimum against the page (accent, status strokes, focus ring)", () => {
  for (const t of ["--color-accent", "--color-success", "--color-error", "--color-info"] as const) {
    const c = contrast(v(t), v("--color-background-page"));
    assert.ok(c >= 3, `${t} on page is ${c.toFixed(2)}:1`);
  }
});

test("status tones are unambiguous: distinct tints, hues far apart, none close to the porphyry accent", () => {
  const tints = Object.values(STATUS_PAIRS).map(([bg]) => v(bg));
  assert.equal(new Set(tints).size, tints.length, "two statuses share a background");
  const hues = { won: hue(v("--color-on-success-muted")), lost: hue(v("--color-on-error-muted")), pending: hue(v("--color-on-info-muted")), challenged: hue(v("--color-on-warning-muted")) };
  const names = Object.keys(hues) as Array<keyof typeof hues>;
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++)
    assert.ok(hueGap(hues[names[i]], hues[names[j]]) >= 30, `${names[i]} and ${names[j]} hues are too close`);
  const accent = hue(v("--color-accent"));
  for (const n of names) assert.ok(hueGap(accent, hues[n]) >= 30, `accent hue is too close to ${n}`);
});

test("the switch: VITE_BRAND picks the brand, ?brand= previews, default is praetorial, junk falls back", () => {
  assert.equal(DEFAULT_BRAND, "praetorial");
  assert.equal(resolveBrand(undefined), "praetorial");
  assert.equal(resolveBrand("classic"), "classic");
  assert.equal(resolveBrand(" Classic "), "classic");
  assert.equal(resolveBrand("praetorial"), "praetorial");
  assert.equal(resolveBrand("neon"), "praetorial");
  assert.equal(resolveBrand("praetorial", "?brand=classic"), "classic");
  assert.equal(resolveBrand("classic", "?x=1&brand=praetorial"), "praetorial");
  assert.equal(resolveBrand("classic", "?brand=neon"), "classic");
});

test("classic stays exactly as it was: brand.css rules are all scoped, the classic theme file is untouched", () => {
  const css = readFileSync(new URL("../src/theme/brand.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // every selector list outside @font-face / @media wrappers starts with the brand scope
  const rules = css.replace(/@font-face\s*{[^}]*}/g, "").replace(/@media[^{]*{/g, "").match(/[^{}]+(?={)/g) ?? [];
  for (const sel of rules.map((r) => r.trim()).filter(Boolean))
    for (const part of sel.split(/,(?![^(]*\))/)) assert.match(part.trim(), /^:root\[data-brand="praetorial"\]/, `unscoped selector: ${part.trim()}`);
  const classic = readFileSync(new URL("../src/theme/praetorialTheme.ts", import.meta.url), "utf8");
  assert.match(classic, /"--color-accent": "#3b3fd9"/);
  assert.match(classic, /heading: { family: "Inter"/);
});

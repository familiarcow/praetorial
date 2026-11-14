// BRAND1: the one brand switch (spikes/brand1/REPORT.md "How to switch back").
//   VITE_BRAND=classic     -> today's look exactly (praetorialTheme, no brand.css rules apply, the square mark)
//   VITE_BRAND=praetorial  -> the "Praetexta" brand (default when unset)
// `?brand=classic|praetorial` on any URL previews the other brand without a rebuild (not remembered).
import { praetorialTheme } from "./praetorialTheme";
import { praetextaTheme } from "./praetextaTheme";

export type BrandName = "classic" | "praetorial";
export const DEFAULT_BRAND: BrandName = "praetorial";

const isBrand = (v: unknown): v is BrandName => v === "classic" || v === "praetorial";

/** Pure: the brand from the build env and an optional `?brand=` preview override. Unknown values fall back. */
export function resolveBrand(envValue: string | undefined, search = ""): BrandName {
  const q = new URLSearchParams(search).get("brand");
  if (isBrand(q)) return q;
  const e = envValue?.trim().toLowerCase();
  return isBrand(e) ? e : DEFAULT_BRAND;
}

export const BRAND: BrandName = resolveBrand(
  import.meta.env?.VITE_BRAND,
  typeof window !== "undefined" ? window.location.search : "",
);

export const brandTheme = (b: BrandName = BRAND) => (b === "classic" ? praetorialTheme : praetextaTheme);

/** Marks <html data-brand=...>: every rule in src/theme/brand.css is scoped to html[data-brand="praetorial"]. */
export function applyBrand(b: BrandName = BRAND): void {
  if (typeof document !== "undefined") document.documentElement.dataset.brand = b;
}

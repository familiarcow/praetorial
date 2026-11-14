import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";
import { PRAETEXTA } from "./brandTokens";

// BRAND1: the "praetorial" brand (spikes/brand1/DIRECTION.md). Same base and type scale as the classic praetorialTheme; porphyry +
// ivory colour tokens (src/theme/brandTokens.ts) and Newsreader for headings (self-hosted, @font-face in src/theme/brand.css).
// Light only, like classic.
export const praetextaTheme = defineTheme({
  name: "praetexta",
  extends: neutralTheme,
  typography: {
    scale: { base: 15, ratio: 1.2 },
    body: { family: "Inter", fallbacks: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
    heading: { family: "Newsreader", fallbacks: "'Iowan Old Style', Charter, Georgia, serif" },
  },
  tokens: { ...PRAETEXTA },
});

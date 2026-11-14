import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";

// ASTRYX1: neutral base, tuned brand colour + typography. LIGHT ONLY: the accent is a single value, not a
// [light, dark] tuple, and <Theme mode="light"> in main.tsx never follows prefers-color-scheme.
export const praetorialTheme = defineTheme({
  name: "praetorial",
  extends: neutralTheme,
  typography: {
    scale: { base: 15, ratio: 1.2 },
    body: { family: "Inter", fallbacks: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
    heading: { family: "Inter", fallbacks: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  },
  tokens: {
    "--color-accent": "#3b3fd9",
  },
});

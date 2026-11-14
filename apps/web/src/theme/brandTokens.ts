// BRAND1 ("Praetexta", spikes/brand1/DIRECTION.md): the colour tokens of the praetorial brand, as plain data so the contrast unit test
// (tests/brand1Contrast.unit.test.ts) reads exactly what the theme ships. Light only (the app has no dark mode).
// The classic brand (today's look) is src/theme/praetorialTheme.ts, untouched.

export const PRAETEXTA = {
  // ground: undyed wool, white cards on it
  "--color-background-page": "#f8f5ef",
  "--color-background-body": "#f8f5ef",
  "--color-background-card": "#ffffff",
  "--color-background-surface": "#ffffff",
  "--color-background-popover": "#ffffff",
  "--color-background-muted": "#f0ebe2",
  "--color-skeleton": "#f0ebe2",
  // ink
  "--color-text-primary": "#1c1720",
  "--color-text-secondary": "#5a5260",
  "--color-text-disabled": "#958d98",
  "--color-icon-primary": "#1c1720",
  "--color-icon-secondary": "#6e6672",
  // porphyry: the praetexta stripe
  "--color-accent": "#6a1b5a",
  "--color-accent-muted": "#f4e6ef",
  "--color-text-accent": "#6a1b5a",
  "--color-icon-accent": "#6a1b5a",
  "--color-on-accent": "#ffffff",
  // seal bronze: decoration only, never text
  "--color-brand-bronze": "#9a6b1f",
  // warm stone hairlines
  "--color-border": "#e6dfd3",
  "--color-border-emphasized": "#cdc2b2",
  "--color-shadow": "#2a142621",
  // status: won / paying / final
  "--color-success": "#2e7d46",
  "--color-success-muted": "#e1f0e4",
  "--color-on-success": "#ffffff",
  "--color-on-success-muted": "#1a4d2a",
  "--color-text-success": "#2a6e3f",
  "--color-border-success": "#8cc39b",
  // status: lost / stuck / errors
  "--color-error": "#b3261e",
  "--color-error-muted": "#f9e1de",
  "--color-on-error": "#ffffff",
  "--color-on-error-muted": "#7a1712",
  "--color-text-error": "#a8231c",
  "--color-border-error": "#e5a29b",
  // status: challenged / needs you
  "--color-warning": "#d9a21b",
  "--color-warning-muted": "#fbefd2",
  "--color-on-warning": "#1c1720",
  "--color-on-warning-muted": "#5c3d00",
  "--color-text-warning": "#7a5200",
  "--color-border-warning": "#d9a93f",
  // status: pending / waiting / AI deciding
  "--color-info": "#2f5f9e",
  "--color-info-muted": "#e2ebf6",
  "--color-on-info": "#ffffff",
  "--color-on-info-muted": "#183f70",
  "--color-text-info": "#2a5590",
  "--color-border-info": "#9db8dc",
} as const;

export type PraetextaToken = keyof typeof PRAETEXTA;

/** The pill each bet status uses (lib/betView.ts PILL_WORDS tone): background token, text token. */
export const STATUS_PAIRS = {
  "won (good)": ["--color-success-muted", "--color-on-success-muted"],
  "lost (bad)": ["--color-error-muted", "--color-on-error-muted"],
  "void / refunded / cancelled (neutral)": ["--color-background-muted", "--color-text-secondary"],
  "pending / waiting / AI deciding (info)": ["--color-info-muted", "--color-on-info-muted"],
  "challenged / needs you (warn)": ["--color-warning-muted", "--color-on-warning-muted"],
} as const satisfies Record<string, readonly [PraetextaToken, PraetextaToken]>;

/** Every other text-on-background pair the theme relies on: [background, text]. */
export const TEXT_PAIRS: ReadonlyArray<readonly [PraetextaToken, PraetextaToken]> = [
  ...(["--color-background-page", "--color-background-card", "--color-background-muted"] as const).flatMap((bg) =>
    (["--color-text-primary", "--color-text-secondary", "--color-text-accent", "--color-text-error", "--color-text-warning", "--color-text-success", "--color-text-info"] as const)
      .map((fg) => [bg, fg] as const)),
  ["--color-accent", "--color-on-accent"],
  ["--color-accent-muted", "--color-text-accent"],
  ["--color-error", "--color-on-error"],
  ["--color-success", "--color-on-success"],
  ["--color-info", "--color-on-info"],
  ["--color-warning", "--color-on-warning"],
  ["--color-background-muted", "--color-text-primary"],
];

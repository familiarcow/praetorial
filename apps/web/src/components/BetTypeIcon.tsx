import React from "react";
import type { BetTypeIconId } from "../../lib/betTypePicker";

// BET1a: one small line icon per bet-type card. Inline SVG bundled with the app (no image request, no third-party icon set);
// strokes use currentColor so the icon follows the theme.
const PATHS: Record<BetTypeIconId, React.ReactNode> = {
  clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  target: (<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.2" /></>),
  compare: (<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>),
  trophy: (<><path d="M8 4h8v5a4 4 0 0 1-8 0z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4" /><path d="M12 13v4M9 20h6M10 17h4" /></>),
  thermometer: (<><path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z" /><path d="M12 9v7" /></>),
  globe: (<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></>),
};

export default function BetTypeIcon({ icon }: { icon: BetTypeIconId }) {
  return (
    <svg data-testid={`bet-type-icon-${icon}`} aria-hidden="true" focusable="false" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[icon]}
    </svg>
  );
}

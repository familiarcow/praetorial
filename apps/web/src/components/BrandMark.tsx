// A1 (UIR1 §3.1 / §3.11): the brand: a small mark + "Praetorial". One component for the login card and the nav, theme tokens only.
import React from "react";
import { BRAND } from "../theme/brand";

export function BrandMark({ size = 22 }: { size?: number }) {
  // BRAND1: the praetorial brand draws the mark as a round seal (porphyry disc, bronze ring); classic keeps the square.
  if (BRAND === "praetorial") return (
    <svg className="brand-mark" width={size + 2} height={size + 2} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="11.5" fill="var(--color-accent, currentColor)" />
      <circle cx="12" cy="12" r="9.6" fill="none" stroke="var(--color-brand-bronze, currentColor)" strokeWidth="0.9" />
      <path d="M12 7v10M8.5 17h7M7 9.5h10M7 9.5l-1.8 3.5h3.6zM17 9.5l-1.8 3.5h3.6z" stroke="var(--color-on-accent, #fff)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--color-text-primary, currentColor)" />
      {/* a balance beam on a pillar: two people, one decision */}
      <path d="M12 6v12M7 18h10M6 9h12M6 9l-2 4h4zM18 9l-2 4h4z" stroke="var(--color-background-card, #fff)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function Brand({ testId }: { testId?: string }) {
  return (
    <span className="brand-lockup" data-testid={testId}>
      <BrandMark />
      <span className="brand-word">Praetorial</span>
    </span>
  );
}

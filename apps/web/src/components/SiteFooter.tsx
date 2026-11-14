// CFIX1 (PM, PM 21:50 + 21:52): one site footer on every page (both brands, guest / logged in / logged out, phones too): the source
// code on GitHub, the X account and "Built at NEAR HACKATHON". No personal name. Rendered once, after <App /> (src/main.tsx), so every
// route and every early return (login, logged-out Docs, the guide) gets it. The repo is private until publish, so the GitHub link 404s
// until then (expected). Sticky bottom bars (bet page actions, the create step bar) end above it: see .site-footer in styles.css.
import React from "react";

export const FOOTER_LINKS = {
  github: { href: "https://github.com/familiarcow/praetorial", label: "Source code on GitHub" },
  x: { href: "https://x.com/familiarcow", label: "familiarcow on X" },
} as const;
export const FOOTER_BUILT_AT = "Built at NEAR HACKATHON";

export default function SiteFooter() {
  return (
    <footer className="site-footer" data-testid="site-footer">
      <a href={FOOTER_LINKS.github.href} target="_blank" rel="noopener noreferrer" data-testid="footer-github">{FOOTER_LINKS.github.label}</a>
      <span aria-hidden="true" className="site-footer__dot">·</span>
      <a href={FOOTER_LINKS.x.href} target="_blank" rel="noopener noreferrer" data-testid="footer-x">{FOOTER_LINKS.x.label}</a>
      <span aria-hidden="true" className="site-footer__dot">·</span>
      <span data-testid="footer-built-at">{FOOTER_BUILT_AT}</span>
    </footer>
  );
}

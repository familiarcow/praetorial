// DFIX1: publishes the sticky app nav's height as --app-nav-h on <html>, so other sticky elements (the Docs sidebar) stick BELOW the
// nav instead of under/over it, whatever the nav's height (brand, wrapping tabs, font load). Rendered next to the nav: while there is
// no app nav (logged-out pages) the variable is unset and users fall back to 0.
import { useLayoutEffect } from "react";

export const APP_NAV_VAR = "--app-nav-h";

export function AppNavHeight({ selector = ".app-nav" }: { selector?: string }) {
  useLayoutEffect(() => {
    const nav = document.querySelector<HTMLElement>(selector);
    const root = document.documentElement.style;
    if (!nav) return;
    const set = () => root.setProperty(APP_NAV_VAR, `${nav.getBoundingClientRect().height}px`);
    set();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(set);
    ro?.observe(nav);
    return () => { ro?.disconnect(); root.removeProperty(APP_NAV_VAR); };
  }, [selector]);
  return null;
}

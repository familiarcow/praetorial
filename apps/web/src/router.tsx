import { useCallback, useEffect, useState } from "react";
import { guardedUrl } from "../lib/navGuard";
import { legacyRedirect, matchRoute, type Route } from "../lib/router";

function currentUrl(): string {
  const { pathname, search, hash } = window.location;
  const to = legacyRedirect(pathname, search, hash);
  if (to) window.history.replaceState({}, "", to);
  return window.location.pathname;
}

/** Tiny history-API router hook: current route + navigate(path). Back/forward and #judge-models are handled. */
export function useRoute(): { route: Route; path: string; navigate: (to: string) => void } {
  const [path, setPath] = useState(currentUrl);
  useEffect(() => {
    const onPop = () => {
      // MODAL1c1b: a send is in flight; Back stays on the flow's url so its result screen is not lost.
      const stay = guardedUrl();
      if (stay !== null) {
        window.history.pushState({}, "", stay);
        setPath(window.location.pathname);
        return;
      }
      setPath(currentUrl());
    };
    const onHash = () => {
      if (window.location.hash === "#judge-models") {
        window.history.pushState({}, "", "/about");
        setPath("/about");
      }
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  const navigate = useCallback((to: string) => {
    // NAV1: in-app links to a moved page (e.g. the funding hand-off's /add-money?asset=..) land on its new home.
    const u = new URL(to, window.location.origin);
    to = legacyRedirect(u.pathname, u.search, u.hash) ?? to;
    if (to !== window.location.pathname + window.location.search) window.history.pushState({}, "", to);
    setPath(window.location.pathname);
  }, []);
  return { route: matchRoute(path), path, navigate };
}

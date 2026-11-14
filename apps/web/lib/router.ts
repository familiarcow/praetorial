// FE1: pure route table for the app shell. No React, no window, so it runs under `tsx --test`.
// A ~40-line history-API router instead of react-router-dom: four flat routes, no nested layouts,
// loaders or data APIs are needed, and it avoids a new dependency (and lockfile churn on a
// frozen-release web build). src/router.tsx wraps these functions in a hook.

// NAV1 (UX-31): three sections -- Home (/: My Bets, Explore Bets, In progress), About (/about) and Wallet (/wallet). The old
// /browse and /my-bets (now Home), /judges (now About) and /add-money (now Wallet) are redirected by legacyRedirect.
// DOCS1 (familiarcow 11-12): About is replaced by Docs (/docs, one URL per page, lib/docs.ts); /about and its deep links redirect there.
import { DOCS_PAGES, docsPath, type DocsPageId } from "./docs";

export type Route =
  | { name: "home" }
  | { name: "docs"; page: DocsPageId }
  | { name: "account" }
  | { name: "new" }
  | { name: "bet"; id: number }
  | { name: "guide" }
  | { name: "not-found" };

export function matchRoute(pathname: string): Route {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  switch (p) {
    case "/": return { name: "home" };
    // DOCS1: /about is redirected to /docs before matching (legacyRedirect); matched here too so it can never 404.
    case "/about": return { name: "docs", page: "what" };
    case "/account": return { name: "account" };
    case "/new": return { name: "new" };
    case "/guide/custom-bet": return { name: "guide" };
  }
  const doc = DOCS_PAGES.find((d) => docsPath(d.id) === p);
  if (doc) return { name: "docs", page: doc.id };
  const m = /^\/bet\/(\d+)$/.exec(p);
  if (m) {
    const id = Number(m[1]);
    if (Number.isSafeInteger(id)) return { name: "bet", id };
  }
  return { name: "not-found" };
}

/** LOGIN1 (UX-29, familiarcow: "It should be a page with just the login"): logged out, every route shows only the login page.
 * The URL is left as it is, so a deep link (/bet/7, /my-bets, ...) renders its page as soon as the user is signed in.
 * Earlier /bet/:id, /browse, /judges and the landing page were public reads; no product rule requires that, so they are gated too. */
// TPL3 (familiarcow 11-12): the one exception is the "write it with your AI" guide (/guide/custom-bet), a static help page with no
// account data, so a bettor can send it to their agent or read it before signing up.
// DOCS1: the Docs pages are static too (familiarcow: "reachable without logging in").
export function routeRequiresLogin(r: Route): boolean {
  return r.name !== "guide" && r.name !== "docs";
}

const BRAND_LINE = "Trustless AI Escrow";
/** The one short line under the brand on the login page. */
export function loginPageLine(r: Route): string {
  const back = " You will come back to this page.";
  switch (r.name) {
    case "bet": return `Log in to see bet #${r.id}. You will go straight to it.`;
    case "new": return "Log in to make a bet." + back;
    case "account": return "Log in to open your account." + back;
    default: return BRAND_LINE;
  }
}

export function betPath(id: number): string {
  return `/bet/${id}`;
}

// NAV1: old pages folded into the three sections. /add-money keeps its query (?asset=&need=&return=, the funding hand-off).
// F3 (familiarcow UX-37): "Wallet" is "Account" now and Settings folded into it; /wallet keeps the hand-off query too.
const MOVED: Record<string, (search: string) => string> = {
  "/wallet": (q) => "/account" + q,
  "/settings": () => "/account",
  "/add-money": (q) => "/account" + q,
  "/browse": () => "/",
  "/my-bets": () => "/",
  "/judges": () => DOCS_MODELS,
};

// DOCS1: About's sections now live on Docs pages. "what"/"how"/"fees"/"know" are on /docs, "models"/"verify" on /docs/verification.
const DOCS_MODELS = "/docs/verification#models";
function aboutRedirect(hash: string): string {
  const id = hash.replace(/^#/, "");
  if (id === "verify" || id === "models") return `/docs/verification#${id}`;
  if (id === "what" || id === "how" || id === "fees" || id === "know") return `/docs#${id}`;
  return "/docs";
}

/** Old links: `/?bet=N[&invite=sig]` -> `/bet/N[?invite=sig]`, `#judge-models` -> Docs' models section, `/about[#id]` -> Docs (DOCS1),
 * and the NAV1 moves above. null = no redirect. */
export function legacyRedirect(pathname: string, search: string, hash: string): string | null {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (p === "/about") return aboutRedirect(hash);
  if (MOVED[p]) return MOVED[p]!(search);
  if (pathname !== "/") return null;
  const q = new URLSearchParams(search);
  const bet = q.get("bet");
  if (bet !== null && /^\d+$/.test(bet) && Number.isSafeInteger(Number(bet))) {
    const invite = q.get("invite");
    return betPath(Number(bet)) + (invite && /^[0-9a-fA-F]+$/.test(invite) ? `?invite=${invite}` : "");
  }
  if (hash === "#judge-models") return DOCS_MODELS;
  return null;
}

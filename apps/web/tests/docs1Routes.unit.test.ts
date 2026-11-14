// DOCS1 (familiarcow via b0nd 11-12): Docs replaces About. Every Docs page has its own URL, is public (no login), and /about (plus the old
// About links: /about#verify, /judges, #judge-models) lands on the matching Docs page instead of a 404.
import test from "node:test";
import assert from "node:assert/strict";
import { matchRoute, routeRequiresLogin, legacyRedirect, loginPageLine } from "../lib/router";
import { DOCS_PAGES, docsPath } from "../lib/docs";

test("DOCS1: five Docs pages, each with its own URL under /docs, in nav order", () => {
  assert.deepEqual(DOCS_PAGES.map((p) => p.id), ["what", "verification", "intents", "trust", "hackathon"]);
  assert.deepEqual(DOCS_PAGES.map((p) => docsPath(p.id)), ["/docs", "/docs/verification", "/docs/near-intents", "/docs/trust", "/docs/hackathon"]);
  assert.equal(new Set(DOCS_PAGES.map((p) => p.title)).size, 5);
  for (const p of DOCS_PAGES) {
    assert.deepEqual(matchRoute(docsPath(p.id)), { name: "docs", page: p.id }, p.id);
    assert.deepEqual(matchRoute(docsPath(p.id) + "/"), { name: "docs", page: p.id }, p.id + " trailing slash");
  }
});

test("DOCS1: unknown /docs/* paths are not-found (never a blank Docs page)", () => {
  for (const p of ["/docs/nope", "/docs/what", "/docs/trust/extra", "/docsx"]) assert.deepEqual(matchRoute(p), { name: "not-found" }, p);
});

test("DOCS1: Docs pages are public (reachable logged out); every other app route still needs login", () => {
  for (const p of DOCS_PAGES) assert.equal(routeRequiresLogin({ name: "docs", page: p.id }), false, p.id);
  assert.equal(routeRequiresLogin({ name: "guide" }), false);
  for (const r of [{ name: "home" }, { name: "account" }, { name: "new" }, { name: "bet", id: 7 }, { name: "not-found" }] as const) {
    assert.equal(routeRequiresLogin(r), true, r.name);
  }
  assert.equal(typeof loginPageLine({ name: "docs", page: "what" }), "string");
});

test("DOCS1: /about redirects to /docs (it must not 404); the old About deep links land on the matching Docs page", () => {
  assert.equal(legacyRedirect("/about", "", ""), "/docs");
  assert.equal(legacyRedirect("/about/", "", ""), "/docs");
  assert.equal(legacyRedirect("/about", "", "#verify"), "/docs/verification#verify");
  assert.equal(legacyRedirect("/about", "", "#models"), "/docs/verification#models");
  assert.equal(legacyRedirect("/about", "", "#fees"), "/docs#fees");
  assert.equal(legacyRedirect("/judges", "", ""), "/docs/verification#models");
  assert.equal(legacyRedirect("/", "", "#judge-models"), "/docs/verification#models");
  // and even unredirected, /about never renders the not-found page
  assert.deepEqual(matchRoute("/about"), { name: "docs", page: "what" });
  assert.equal(legacyRedirect("/docs", "", ""), null);
  for (const p of DOCS_PAGES) assert.equal(legacyRedirect(docsPath(p.id), "", ""), null, p.id);
});

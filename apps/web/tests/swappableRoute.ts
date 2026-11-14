// FE10f: swap a route's behaviour WITHOUT a gap. page.unroute(url) followed by page.route(url, ...) leaves a window in which an
// in-flight app request (e.g. AddMoney's parallel movableHoldings reads) falls through to the e2eGuard and is aborted as an
// "escaped" request. One registration that delegates to a replaceable handler never unroutes.
import type { Page, Route } from "@playwright/test";

export type RouteHandler = (route: Route) => unknown | Promise<unknown>;

export async function swappableRoute(page: Page, url: string, initial: RouteHandler): Promise<{ set(h: RouteHandler): void }> {
  let current = initial;
  await page.route(url, (route) => current(route));
  return { set(h) { current = h; } };
}

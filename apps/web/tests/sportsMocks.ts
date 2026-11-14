// TPL2: page.route mocks for the game picker's three schedule sources, served from the RECORDED payloads in tests/fixtures/sports
// (and, for MLB, the resolver's own SP1 fixtures). A day with no recorded payload answers an empty (but well-formed) schedule.
import type { Page, Route } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const local = (n: string) => `${here}fixtures/sports/${n}`;
const resolverFx = (n: string) => `${here}../../../resolver/core/tests/fixtures/sports/${n}`;
export const RECORDED_AT = "2026-11-12T16:18:45Z";
export const readFx = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function espnFile(league: string, compact: string): string | null {
  const a = local(`espn_${league}_${compact}.json`);
  if (existsSync(a)) return a;
  const b = resolverFx(`espn_${league}_scoreboard_${compact}.json`);
  return existsSync(b) ? b : null;
}
export interface SportsMockOpts {
  /** Rewrite a payload before it is served (e.g. a synthetic pre-game copy of a recorded final). */
  transform?: (kind: "espn" | "nhl" | "mlb", date: string, body: any) => any;
  /** Answer this many NHL proxy calls with 502 first (the retry path). */
  nhlFailures?: number;
  /** Every source is down. */
  allDown?: boolean;
  calls?: string[];
}
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

export async function mockSports(page: Page, o: SportsMockOpts = {}) {
  let nhlFail = o.nhlFailures ?? 0;
  const t = (k: "espn" | "nhl" | "mlb", d: string, b: any) => (o.transform ? o.transform(k, d, b) : b);
  await page.route("https://site.api.espn.com/apis/site/v2/sports/**", (route) => {
    const u = new URL(route.request().url());
    o.calls?.push(u.toString());
    if (o.allDown) return route.fulfill({ status: 503, body: "down" });
    const league = u.pathname.split("/")[6];
    const compact = u.searchParams.get("dates") ?? "";
    const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    const f = espnFile(league, compact);
    return json(route, t("espn", date, f ? readFx(f) : { leagues: [], events: [] }));
  });
  await page.route("**/_proxy/sports/nhl/v1/score/*", (route) => {
    const date = new URL(route.request().url()).pathname.split("/").pop()!;
    o.calls?.push(route.request().url());
    if (o.allDown || nhlFail-- > 0) return route.fulfill({ status: 502, body: "schedule unavailable" });
    const f = local(`nhl_score_${date.replace(/-/g, "")}.json`);
    const g = resolverFx(`nhl_score_${date.replace(/-/g, "")}.json`);
    return json(route, t("nhl", date, existsSync(f) ? readFx(f) : existsSync(g) ? readFx(g) : { currentDate: date, games: [] }));
  });
  await page.route("https://statsapi.mlb.com/api/v1/schedule**", (route) => {
    const date = new URL(route.request().url()).searchParams.get("date") ?? "";
    o.calls?.push(route.request().url());
    if (o.allDown) return route.fulfill({ status: 503, body: "down" });
    const f = local(`mlb_schedule_${date.replace(/-/g, "")}.json`);
    const g = resolverFx(`mlb_schedule_${date.replace(/-/g, "")}.json`);
    return json(route, t("mlb", date, existsSync(f) ? readFx(f) : existsSync(g) ? readFx(g) : { totalGames: 0, dates: [] }));
  });
}

/** synthetic_pregame: a recorded final turned back into a not-yet-started game (scores dropped), for the doubleheader screens. */
export function asPregame(kind: "espn" | "nhl" | "mlb", body: any): any {
  const b = JSON.parse(JSON.stringify(body));
  if (kind === "mlb") for (const d of b.dates ?? []) for (const g of d.games ?? []) {
    if (g.status?.codedGameState === "F") g.status = { abstractGameState: "Preview", codedGameState: "S", detailedState: "Scheduled", statusCode: "S", startTimeTBD: false, abstractGameCode: "P" };
    for (const s of ["home", "away"]) delete g.teams?.[s]?.score;
  }
  if (kind === "espn") for (const e of b.events ?? []) {
    if (e.status?.type?.name === "STATUS_FINAL") e.status.type = { id: "1", name: "STATUS_SCHEDULED", state: "pre", completed: false, description: "Scheduled" };
  }
  return b;
}

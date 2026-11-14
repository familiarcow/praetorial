// DR2 ground truth: the league box score (ESPN public scoreboard JSON) fetched by the HARNESS after the final (judge not consulted).
import { createHash } from "node:crypto";
import { parseEspnGame, type Game } from "../harness/parsers.js";

export type Outcome = "YES" | "NO" | "VOID";
export interface GameTruth extends Game { outcome: Outcome; pick_team_abbr: string; rawSha256: string; reason: string }

export const espnScoreboardUrl = (sport: string, league: string, yyyymmdd: string) => `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${yyyymmdd}`;

/** YES iff the picked team won a FINAL game; NO iff the other team won; VOID when not final or a tie (the resolver's definitions: tie/postponement/cancellation is a win for neither). */
export function gameTruth(rawText: string, eventId: string, pickTeamAbbr: string): GameTruth {
  const g = parseEspnGame(JSON.parse(rawText), eventId);
  const rawSha256 = createHash("sha256").update(rawText).digest("hex");
  const teams = [g.home.team, g.away.team];
  if (!teams.includes(pickTeamAbbr)) throw new Error(`pick ${pickTeamAbbr} is not a team of event ${eventId} (${teams.join(" v ")})`);
  if (!g.final) return { ...g, outcome: "VOID", pick_team_abbr: pickTeamAbbr, rawSha256, reason: "game not final" };
  if (g.winner === null) return { ...g, outcome: "VOID", pick_team_abbr: pickTeamAbbr, rawSha256, reason: "final tie" };
  return { ...g, outcome: g.winner === pickTeamAbbr ? "YES" : "NO", pick_team_abbr: pickTeamAbbr, rawSha256, reason: "final score" };
}

export async function fetchEspn(sport: string, league: string, yyyymmdd: string): Promise<string> {
  const url = espnScoreboardUrl(sport, league, yyyymmdd);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ESPN ${r.status} for ${url}`);
  return r.text();
}

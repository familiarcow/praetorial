// TPL1 (D-PM3 #2): the 20 NWS stations the resolver accepts (resolver/core/src/template.rs NWS_STATIONS, mirrored in
// lib/templates.ts NWS_UTC_OFFSET), shown as cities. The station code is the value the bet stores; people see the city.
// tests/nwsCities.unit.test.ts pins this list to exactly the resolver's 20 codes.
export interface NwsCity { code: string; label: string; /** extra words search should match (state, airport, landmark) */ keywords: string }

export const NWS_CITIES: NwsCity[] = [
  { code: "KNYC", label: "New York City (Central Park)", keywords: "new york ny manhattan nyc" },
  { code: "KLAX", label: "Los Angeles (LAX airport)", keywords: "california ca la" },
  { code: "KORD", label: "Chicago (O'Hare airport)", keywords: "illinois il ohare" },
  { code: "KMIA", label: "Miami (Miami airport)", keywords: "florida fl" },
  { code: "KDFW", label: "Dallas-Fort Worth (DFW airport)", keywords: "texas tx dallas fort worth" },
  { code: "KDEN", label: "Denver (Denver airport)", keywords: "colorado co" },
  { code: "KPHX", label: "Phoenix (Sky Harbor airport)", keywords: "arizona az" },
  { code: "KSEA", label: "Seattle (Sea-Tac airport)", keywords: "washington wa seatac tacoma" },
  { code: "KATL", label: "Atlanta (Hartsfield-Jackson airport)", keywords: "georgia ga" },
  { code: "KBOS", label: "Boston (Logan airport)", keywords: "massachusetts ma" },
  { code: "KIAH", label: "Houston (Bush Intercontinental airport)", keywords: "texas tx iah" },
  { code: "KMSP", label: "Minneapolis-St. Paul (MSP airport)", keywords: "minnesota mn saint paul twin cities" },
  { code: "KDCA", label: "Washington, DC (Reagan National airport)", keywords: "district of columbia dc virginia" },
  { code: "KPHL", label: "Philadelphia (PHL airport)", keywords: "pennsylvania pa philly" },
  { code: "KSFO", label: "San Francisco (SFO airport)", keywords: "california ca bay area sf" },
  { code: "KLAS", label: "Las Vegas (Harry Reid airport)", keywords: "nevada nv vegas" },
  { code: "KAUS", label: "Austin (Austin-Bergstrom airport)", keywords: "texas tx" },
  { code: "KDTW", label: "Detroit (Detroit Metro airport)", keywords: "michigan mi" },
  { code: "KMDW", label: "Chicago (Midway airport)", keywords: "illinois il" },
  { code: "KSAN", label: "San Diego (San Diego airport)", keywords: "california ca lindbergh" },
];

/** The city for a station code; the code itself when unknown (never blank). */
export function cityLabel(code: string): string {
  return NWS_CITIES.find((c) => c.code === code)?.label ?? code;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** Cities whose name, airport, state or landmark contains every word of the query. Empty query = all 20, in list order. */
export function searchCities(q: string): NwsCity[] {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [...NWS_CITIES];
  return NWS_CITIES.filter((c) => { const hay = ` ${norm(`${c.label} ${c.keywords}`)} `; return words.every((w) => hay.includes(w)); });
}

/** One line: what the bet measures. */
export const NWS_MEASURED_LINE = "This bet is on the official high temperature the National Weather Service records for that city that day.";
/** The climate-day caveat in plain words (resolver: the climate day is local STANDARD time all year). */
export const NWS_CLIMATE_DAY_LINE = "The weather service counts the day in local standard time all year, so in summer (daylight saving time) the day runs from 1am to 1am.";

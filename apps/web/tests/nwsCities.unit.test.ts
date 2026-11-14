// TPL1 (D-PM3 #2): the 20 NWS stations are shown as city names. The resolver's NWS_STATIONS (resolver/core/src/template.rs) is
// the source of truth: the web city list must carry exactly its 20 codes (parity), and the station code is only a Detail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NWS_CITIES, cityLabel, searchCities, NWS_MEASURED_LINE, NWS_CLIMATE_DAY_LINE } from "../lib/nwsCities";
import { NWS_STATIONS, NWS_UTC_OFFSET, buildTypedSheet } from "../lib/templates";
import { questionFromTerms } from "../lib/templateClaim";
import { betSentence, blankFill, BET_TYPE_CARDS } from "../lib/betTypePicker";
import { GUIDED_FIELDS } from "../lib/guidedFields";

const here = dirname(fileURLToPath(import.meta.url));
const rust = readFileSync(join(here, "../../../resolver/core/src/template.rs"), "utf8");
const block = rust.slice(rust.indexOf("pub const NWS_STATIONS"), rust.indexOf("];", rust.indexOf("pub const NWS_STATIONS")));
const resolverStations = [...block.matchAll(/\("(K[A-Z]{3})",\s*(-?\d+)\)/g)].map((m) => ({ code: m[1], off: Number(m[2]) }));

test("parity: the web city list has exactly the resolver's 20 station codes (and the same standard-time offsets)", () => {
  assert.equal(resolverStations.length, 20);
  assert.deepEqual(NWS_CITIES.map((c) => c.code).sort(), resolverStations.map((s) => s.code).sort());
  assert.deepEqual([...NWS_STATIONS].sort(), resolverStations.map((s) => s.code).sort());
  for (const s of resolverStations) assert.equal(NWS_UTC_OFFSET[s.code], s.off, s.code);
});

test("every station has a unique plain city label with no station code in it", () => {
  const labels = NWS_CITIES.map((c) => c.label);
  assert.equal(new Set(labels).size, 20);
  for (const c of NWS_CITIES) {
    assert.ok(c.label.length > 3, c.code);
    assert.ok(!/\bK[A-Z]{3}\b/.test(c.label), `${c.label} shows a station code`);
  }
  assert.equal(cityLabel("KNYC"), "New York City (Central Park)");
  assert.equal(cityLabel("KLAX"), "Los Angeles (LAX airport)");
  assert.equal(cityLabel("KORD"), "Chicago (O'Hare airport)");
  assert.equal(cityLabel("KMDW"), "Chicago (Midway airport)");
  assert.equal(cityLabel("KXXX"), "KXXX"); // unknown: never blank
});

test("search finds cities by name, landmark, airport or state, case-insensitively", () => {
  const codes = (q: string) => searchCities(q).map((c) => c.code);
  assert.deepEqual(codes("chicago").sort(), ["KMDW", "KORD"]);
  assert.deepEqual(codes("central park"), ["KNYC"]);
  assert.deepEqual(codes("new york"), ["KNYC"]);
  assert.deepEqual(codes("LAX"), ["KLAX"]);
  assert.ok(codes("texas").includes("KAUS") && codes("texas").includes("KIAH") && codes("texas").includes("KDFW"));
  assert.equal(searchCities("").length, 20);
  assert.deepEqual(codes("zzz"), []);
});

test("the form picks a city (value = station code, label = city) and explains what is measured and the climate day", () => {
  const st = GUIDED_FIELDS.nws_daily_high.find((g) => g.key === "station")!;
  assert.equal(st.label, "City");
  assert.equal(st.options!.length, 20);
  assert.deepEqual(st.options!.find((o) => o.value === "KNYC"), { value: "KNYC", label: "New York City (Central Park)" });
  assert.match(NWS_MEASURED_LINE, /official high temperature the National Weather Service records for that city that day/);
  assert.match(NWS_CLIMATE_DAY_LINE, /local standard time/);
  assert.match(NWS_CLIMATE_DAY_LINE, /1am/);
});

test("the plain question, the bet sentence and the card example use the city, not the station code", () => {
  const ts = buildTypedSheet("nws_daily_high", { station: "KNYC", date: "2026-11-11", op: ">=", x_f: 63 });
  assert.equal(questionFromTerms(ts), "The official NWS high in New York City (Central Park) on 2026-11-11 is 63°F or warmer");
  const s = betSentence({ ...blankFill("nws_daily_high"), guided: { station: "KORD", date: "2027-12-08", op: ">=", x_f: "72" } });
  assert.match(s, /daily high in Chicago \(O'Hare airport\) on 2027-12-08 is at or above 72°F/);
  assert.ok(!/KORD/.test(s));
  assert.ok(!/KNYC/.test(BET_TYPE_CARDS.find((c) => c.id === "nws_daily_high")!.example));
});

// FE3b Q3: the review card's "Sources:" part comes from the template definition the resolver uses (resolver/core/src/template.rs),
// never hard-coded in a component. Typed bets: the feeds the resolver builds; custom bets: the sheet's own source hosts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { templateSourceNames, customSourceHosts } from "../lib/templateSources";
import { buildTypedSheet } from "../lib/templates";

const here = dirname(fileURLToPath(import.meta.url));
const rust = readFileSync(join(here, "../../../resolver/core/src/template.rs"), "utf8");
const canon = JSON.parse(readFileSync(join(here, "../../../services/e2e/live-run8/jason_terms_with_urls.json"), "utf8"));
const sheet = (id: any, fields: any = {}) => buildTypedSheet(id, fields);

test("btc_close_at_t and btc_touch list the three exchanges the resolver reads", () => {
  for (const id of ["btc_close_at_t", "btc_touch"]) assert.deepEqual(templateSourceNames(sheet(id)), ["Coinbase BTC-USD", "Bitstamp btcusd", "Kraken XBT/USD"]);
});
test("game_winner lists the league feed + ESPN per league (NFL/NBA: ESPN only)", () => {
  assert.deepEqual(templateSourceNames(sheet("game_winner", { league: "MLB" })), ["MLB Stats API", "ESPN"]);
  assert.deepEqual(templateSourceNames(sheet("game_winner", { league: "NHL" })), ["NHL api-web", "ESPN"]);
  assert.deepEqual(templateSourceNames(sheet("game_winner", { league: "NFL" })), ["ESPN"]);
  assert.deepEqual(templateSourceNames(sheet("game_winner", { league: "NBA" })), ["ESPN"]);
});
test("nws_daily_high lists the NWS CLI report and the IEM copy", () => {
  assert.deepEqual(templateSourceNames(sheet("nws_daily_high")), ["NWS CLI (api.weather.gov)", "IEM CLI (mesonet.agron.iastate.edu)"]);
});
test("every name is a publisher string in the resolver's template.rs (parity, not a second copy of the truth)", () => {
  const all = [...templateSourceNames(sheet("btc_touch")), ...["MLB", "NHL", "NFL", "NBA"].flatMap((l) => templateSourceNames(sheet("game_winner", { league: l }))), ...templateSourceNames(sheet("nws_daily_high"))];
  for (const n of all) assert.ok(rust.includes(`"${n}"`), `${n} not in template.rs`);
});
test("a custom or unknown sheet has no template sources", () => { assert.deepEqual(templateSourceNames({ claim: "x" }), []); });
test("custom bets list the sheet's source hosts (publisher when a source has no URL)", () => {
  assert.deepEqual(customSourceHosts(canon), ["api.exchange.coinbase.com", "www.bitstamp.net", "api.kraken.com"]);
  assert.deepEqual(customSourceHosts({ sources_allowed: [{ publisher: "Reuters" }, { publisher: "AP", url: "https://apnews.com/x" }, { publisher: "Dup", url: "https://apnews.com/y" }] }), ["Reuters", "apnews.com"]);
});

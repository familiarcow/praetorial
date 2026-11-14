// D-WEBFIX1 / D-DEMO1: the Jason preset's resolver-format sheet is the canonical jason_terms_with_urls.json (a byte copy of
// services/e2e/live-run8/jason_terms_with_urls.json; tests/jasonPreset.unit.test.ts keeps it identical). It carries the
// elements/rule/clauses/fallback/early rules the strict custom lint (WT1b(d)) requires, plus the ticker pins and source tiers.
import canonical from "./jasonSheet.json";

export function jasonPresetSheet(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(canonical));
}

// WT1b (e): guided fields emit exactly the template JSON the resolver lint accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GUIDED_FIELDS, fieldsFromForm, formFromFields, type LaunchId } from "../lib/guidedFields";
import { buildTypedSheet, lintTemplate, problemCode, LAUNCH_TEMPLATES } from "../lib/templates";

const here = dirname(fileURLToPath(import.meta.url));
const cases: Array<{ name: string; codes: string[]; ts: any }> = JSON.parse(readFileSync(join(here, "../../../resolver/core/tests/fixtures/template_cases.json"), "utf8"));
const ok = ["btc_close_ok", "btc_touch_ok", "game_ok", "nws_ok"].map((n) => cases.find((c) => c.name === n)!);

test("the 4 launch types each have guided fields, and every emitted key is a template field", () => {
  for (const id of LAUNCH_TEMPLATES) assert.ok(GUIDED_FIELDS[id].length >= 3, id);
});

test("form values from each launch fixture emit exactly the fixture's fields (key-for-key) and lint clean", () => {
  for (const c of ok) {
    const id = c.ts.template.id as LaunchId;
    const now = Date.parse(c.ts.fields.open_utc ?? "2026-11-07T12:00:00Z");
    const emitted = fieldsFromForm(id, formFromFields(id, c.ts.fields), now);
    assert.deepEqual(emitted, c.ts.fields, c.name);
    assert.deepEqual(lintTemplate(buildTypedSheet(id, emitted)), [], c.name);
  }
});

test("btc open_utc is stamped as a UTC minute boundary from the clock", () => {
  const f = fieldsFromForm("btc_touch", { direction: "at_or_above", x_usd: "76000", deadline_utc: "2026-12-07T12:00" }, Date.parse("2026-11-07T12:00:37.500Z"));
  assert.equal(f.open_utc, "2026-11-07T12:00:00Z");
  assert.equal(f.deadline_utc, "2026-12-07T12:00:00Z");
});

test("bad entries surface the resolver's named errors, not a silent fix", () => {
  const code = (id: LaunchId, form: any) => lintTemplate(buildTypedSheet(id, fieldsFromForm(id, form, Date.parse("2026-11-07T12:00:00Z")))).map(problemCode);
  assert.ok(code("btc_close_at_t", { t_utc: "2026-11-07T15:00", op: ">=", x_usd: "75900.5" }).includes("TPL_X_USD_NOT_WHOLE"));
  assert.ok(code("btc_close_at_t", { t_utc: "2026-11-07T15:00", op: "~", x_usd: "75900" }).includes("TPL_BAD_OP"));
  assert.ok(code("game_winner", { league: "MLB", event_id: "849799", scheduled_date: "2026-10-28", pick_name: "Milwaukee Brewers" }).includes("TPL_PICK_NO_TEAM_ID"));
  assert.ok(code("game_winner", { league: "XFL", event_id: "849799", scheduled_date: "2026-10-28", pick_team_id: "1", pick_name: "A" }).includes("TPL_BAD_LEAGUE"));
  assert.ok(code("nws_daily_high", { station: "KNYC", date: "2026-11-08", op: ">=", x_f: "72.5" }).includes("TPL_X_F_NOT_WHOLE"));
  assert.ok(code("nws_daily_high", { station: "KXXX", date: "2026-11-08", op: ">=", x_f: "72" }).includes("TPL_STATION_NOT_CURATED"));
});

test("UI: the fill-in step renders guided fields instead of a raw JSON textarea", () => {
  // FE3 (D-UX21): GUIDED_FIELDS moved from CreateOffer into the fill-in step (FillStep) + lib/betTypePicker (fieldsFromForm).
  const co = readFileSync(join(here, "../src/components/FillStep.tsx"), "utf8") + readFileSync(join(here, "../lib/betTypePicker.ts"), "utf8");
  assert.ok(co.includes("GUIDED_FIELDS") && co.includes("fieldsFromForm"));
  assert.ok(!co.includes('data-testid="template-fields"'), "raw JSON textarea must be gone");
});

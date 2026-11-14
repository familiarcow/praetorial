"""17c1: Python twin of the Rust term-sheet schema v1 lint (D-TPL1) + the custom relative-date lint (D-TPL1a).
Cases are shared with resolver/core/tests/template_parity_17c1.rs through resolver/core/tests/fixtures/template_cases.json
(each case: ts + the ordered list of problem-code prefixes lint() returns). Both implementations must match the file."""
import copy, json, os
import judge as J

FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resolver", "core", "tests", "fixtures", "template_cases.json")
LINT_FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resolver", "core", "tests", "fixtures", "lint.json")

def tpl(i, v=1): return {"template": {"id": i, "version": v}}
def mk(i, **f): d = tpl(i); d["fields"] = f; return d
BTC_CLOSE = dict(t_utc="2026-11-07T15:00:00Z", op=">=", x_usd=75900, open_utc="2026-11-07T12:00:00Z")
BTC_TOUCH = dict(direction="at_or_above", x_usd=76000, deadline_utc="2026-12-07T12:00:00Z", open_utc="2026-11-07T12:00:00Z")
GAME = dict(league="MLB", event_id="849799", scheduled_date="2026-10-28", pick={"team_id": "158", "name": "Milwaukee Brewers"})
NWS = dict(station="KNYC", date="2026-11-08", op=">=", x_f=72)
def over(base, **kw):
    d = copy.deepcopy(base); d.update(kw); return d
def base_custom():
    return [c for c in json.load(open(LINT_FX))["cases"] if c["name"] == "baseline_passes_lint"][0]["ts"]
def custom(claim):
    ts = copy.deepcopy(base_custom()); ts["claim"] = claim; return ts

def cases():
    c = []
    def add(name, ts): c.append({"name": name, "ts": ts})
    add("btc_close_ok", mk("btc_close_at_t", **BTC_CLOSE)); add("btc_touch_ok", mk("btc_touch", **BTC_TOUCH))
    add("game_ok", mk("game_winner", **GAME)); add("nws_ok", mk("nws_daily_high", **NWS))
    add("unknown_id", {"template": {"id": "eth_touch", "version": 1}, "fields": BTC_TOUCH})
    add("version_2", {"template": {"id": "btc_touch", "version": 2}, "fields": BTC_TOUCH})
    add("version_string", {"template": {"id": "btc_touch", "version": "1"}, "fields": BTC_TOUCH})
    add("template_not_object", {"template": "btc_touch", "fields": BTC_TOUCH})
    add("close_t_not_minute", mk("btc_close_at_t", **over(BTC_CLOSE, t_utc="2026-11-07T15:00:30Z")))
    add("close_t_friday", mk("btc_close_at_t", **over(BTC_CLOSE, t_utc="Friday")))
    add("close_bad_op", mk("btc_close_at_t", **over(BTC_CLOSE, op="==")))
    add("close_x_fraction", mk("btc_close_at_t", **over(BTC_CLOSE, x_usd=75900.5)))
    add("close_asset_field", mk("btc_close_at_t", **over(BTC_CLOSE, asset="WBTC")))
    add("touch_bad_direction", mk("btc_touch", **over(BTC_TOUCH, direction="above")))
    add("touch_deadline_date_only", mk("btc_touch", **over(BTC_TOUCH, deadline_utc="2026-12-01")))
    add("game_bad_league", mk("game_winner", **over(GAME, league="MLS")))
    add("game_name_only_pick", mk("game_winner", **over(GAME, pick={"name": "Georgia"})))
    add("game_event_name", mk("game_winner", **over(GAME, event_id="Super Bowl LIX")))
    add("game_bad_date", mk("game_winner", **over(GAME, scheduled_date="2026-02-30")))
    add("game_margin_field", mk("game_winner", **over(GAME, margin=3)))
    add("nws_uncurated", mk("nws_daily_high", **over(NWS, station="KXXX")))
    add("nws_lt", mk("nws_daily_high", **over(NWS, op="<")))
    add("nws_fraction", mk("nws_daily_high", **over(NWS, x_f=72.5)))
    t = mk("btc_touch", **BTC_TOUCH); t["sources_allowed"] = [{"id": "S1", "publisher": "x", "url": "https://evil.example/x"}]
    add("typed_with_sources", t)
    t = mk("game_winner", **GAME); t["origin"] = "espn-b"; t["claim"] = "Brewers win"
    add("typed_with_origin_and_claim", t)
    add("custom_plain", base_custom())
    t = base_custom(); t["template"] = {"id": "custom", "version": 1}; add("custom_explicit", t)
    t = base_custom(); t["template"] = {"id": "custom", "version": 3}; add("custom_bad_version", t)
    for i, claim in enumerate(["AAPL closed above $340 on Friday.", "The Chiefs win tomorrow.", "Apple ships it next week.", "The Jaguars make the playoffs this season."]):
        add("custom_relative_%d" % i, custom(claim))
    for i, claim in enumerate(["AAPL closed above $340 on Friday, October 30, 2026.", "The Chiefs win on Nov 8, 2026.", "The Sunderland club wins 2-1.", "tomorrow (2026-11-08) the Chiefs win"]):
        add("custom_anchored_%d" % i, custom(claim))
    return c

def codes(ts):
    out = []
    for p in J.lint(ts):
        head = p.split(":", 1)[0]
        out.append(head if head and all(c.isupper() or c.isdigit() or c == "_" for c in head) else "legacy")
    return out

def current():
    return [{"name": c["name"], "codes": codes(c["ts"]), "ts": c["ts"]} for c in cases()]

def test_python_matches_committed_cases():
    assert json.load(open(FX)) == json.loads(json.dumps(current()))

def test_semantics():
    by = {c["name"]: c["codes"] for c in current()}
    assert by["btc_touch_ok"] == [] and by["game_ok"] == [] and by["nws_ok"] == []
    assert by["unknown_id"] == ["TPL_UNKNOWN_ID"]
    assert "TPL_UNKNOWN_VERSION" in by["version_string"]
    assert by["custom_relative_0"][0] == "CUSTOM_RELATIVE_DATE"
    assert "CUSTOM_RELATIVE_DATE" not in by["custom_anchored_0"] and "CUSTOM_RELATIVE_DATE" not in by["custom_plain"]
    assert by["custom_plain"] == by["custom_explicit"]
    assert J.single_source_allowed(mk("game_winner", **over(GAME, league="NFL")))
    assert not J.single_source_allowed(mk("game_winner", **GAME))
    c = base_custom(); c["single_source"] = True; c["league"] = "NFL"
    assert not J.single_source_allowed(c)

def test_legacy_fixture_lint_unchanged():
    for c in json.load(open(LINT_FX))["cases"]:
        assert J.lint(c["ts"]) == c["problems"], c["name"]

if __name__ == "__main__":
    if os.environ.get("WRITE"):
        json.dump(json.loads(json.dumps(current())), open(FX, "w"), indent=1, sort_keys=True)
    test_python_matches_committed_cases(); test_semantics(); test_legacy_fixture_lint_unchanged(); print("ok")

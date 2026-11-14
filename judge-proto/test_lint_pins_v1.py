"""RED/GREEN tests for two lint gaps (DR-RES-3, DR-RES-2). Mirrored in Rust by
resolver/core/tests/lint_pins.rs (built from the same engine_gaps.json term sheets).

DR-RES-3: item 15 narrowed PRICE_LIKE_RE's bare `$` to `$<digit>` so a regex
end anchor (^v2$) is not a price claim -- which silently let a cashtag claim
('$BTC closes above 100k') skip the D-RESOLVE1 ticker_pins requirement.
DR-RES-2: market_pin / repo_pin were required only when the publisher string
contained the case-sensitive substring 'Polymarket' / 'GitHub'.

    python3 test_lint_pins_v1.py   (or pytest)
"""
import copy, json, os
import judge as J

B = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bettypes")
ld = lambda p: json.load(open(os.path.join(B, p)))
PM, GH = ld("polymarket/term_sheet.json"), ld("github_release/term_sheet.json")


def _ticker(problems):
    return [x for x in problems if "ticker" in x]


def test_cashtag_claim_without_ticker_pins_rejected():
    ts = dict(GH, claim="$BTC closes above 100k on Coinbase by 2026-12-31")
    assert _ticker(J.lint(ts)), J.lint(ts)
    ts = dict(GH, claim="Bitcoin closes above 100k", elements=[dict(id="e1", q="Does $ETH close above 5k?")])
    assert _ticker(J.lint(ts)), J.lint(ts)


def test_regex_end_anchor_still_not_price_like():
    anchor = dict(GH, claim="A release whose tag matches ^v2\\.15\\.\\d+$ is published",
                  bettype=dict(GH["bettype"], tag_pattern="^v2\\.15\\.\\d+$"))
    assert not _ticker(J.lint(anchor)), J.lint(anchor)
    v2 = dict(GH, claim="A tag matching ^v2$ is published")
    assert not _ticker(J.lint(v2)), J.lint(v2)


def test_cashtag_hit_or_exceed_wick_rule_also_applies():
    ts = dict(GH, claim="$SOL hits or exceeds 300", custom_definitions=[])
    assert any("wick-vs-close" in x for x in J.lint(ts)), J.lint(ts)


def _no_bettype(ts, pubs):
    t = {k: v for k, v in ts.items() if k not in ("bettype", "market_pin", "repo_pin")}
    t["sources_allowed"] = [dict(id="S%d" % i, publisher=p) for i, p in enumerate(pubs)]
    return t


def test_lowercase_polymarket_publisher_requires_market_pin():
    for pub in ("polymarket.com", "POLYMARKET", "gamma-api.polymarket.com"):
        p = J.lint(_no_bettype(PM, [pub]))
        assert any("market_pin required" in x for x in p), (pub, p)


def test_lowercase_github_publisher_requires_repo_pin():
    for pub in ("api.github.com", "github.com", "GITHUB REST"):
        p = J.lint(_no_bettype(GH, [pub]))
        assert any("repo_pin required" in x for x in p), (pub, p)


def test_source_url_host_triggers_pin_requirement():
    t = _no_bettype(GH, ["Release feed"])
    t["sources_allowed"][0]["url"] = "https://api.github.com/repositories/1/releases"
    assert any("repo_pin required" in x for x in J.lint(t)), J.lint(t)
    t = _no_bettype(PM, ["Market feed"])
    t["sources_allowed"][0]["url"] = "https://gamma-api.polymarket.com/markets/1"
    assert any("market_pin required" in x for x in J.lint(t)), J.lint(t)


def test_unrelated_publisher_not_pin_gated():
    p = J.lint(_no_bettype(GH, ["bls.gov"]))
    assert not any("repo_pin" in x or "market_pin" in x for x in p), p


if __name__ == "__main__":
    fails = 0
    for n, f in sorted(globals().items()):
        if n.startswith("test_"):
            try:
                f(); print("ok  ", n)
            except AssertionError as e:
                fails += 1; print("FAIL", n, str(e)[:200])
    raise SystemExit(1 if fails else 0)

"""Queue item 7f (blocked-sources, part 1) Python-parity classifier tests.

Standalone, plain-assert script (same pattern as test_oq_t9_window_close.py /
test_evidence_rules_v1.py):
    python3 test_blocked_sources_v1.py

Asserts evidence.classify_blocked_fetch (pure, no network) makes the same
COULDNT_CHECK-or-not decision as resolver/core/src/lib.rs::classify_blocked_fetch
for the same inputs, one test per failure kind. The two implementations must
be re-derived together -- this file is the parity proof, not a substitute for
the Rust side's own unit tests (resolver/core/src/lib.rs::unit_tests).
"""
import evidence as E


def test_http_403_is_couldnt_check():
    r = E.classify_blocked_fetch(403, "text/html", b"Forbidden")
    assert r is not None and "403" in r, r


def test_http_429_is_couldnt_check():
    r = E.classify_blocked_fetch(429, "text/html", b"Too Many Requests")
    assert r is not None and "429" in r, r


def test_cloudflare_challenge_200_is_couldnt_check():
    body = b"<html><title>Just a moment...</title><body>cf-chl-widget</body></html>"
    r = E.classify_blocked_fetch(200, "text/html", body)
    assert r is not None, "challenge page served with 200 must still be COULDNT_CHECK"


def test_captcha_page_is_couldnt_check():
    body = b"<html><body>Please complete the captcha to continue</body></html>"
    r = E.classify_blocked_fetch(200, "text/html", body)
    assert r is not None, r


def test_login_wall_is_couldnt_check():
    body = b'<html><body><form>Sign in <input type="password"></form></body></html>'
    r = E.classify_blocked_fetch(200, "text/html", body)
    assert r is not None and "login wall" in r, r


def test_empty_body_is_couldnt_check():
    r = E.classify_blocked_fetch(200, "text/html", b"   \n  ")
    assert r is not None and "empty" in r, r


def test_truncated_json_is_couldnt_check():
    r = E.classify_blocked_fetch(200, "application/json", b'{"a": [1, 2,', expect_json=True)
    assert r is not None and "JSON" in r, r


def test_html_instead_of_json_is_couldnt_check():
    r = E.classify_blocked_fetch(200, "text/html", b"<html>not json</html>", expect_json=True)
    assert r is not None and "content-type" in r, r


def test_healthy_json_200_passes():
    r = E.classify_blocked_fetch(200, "application/json", b'{"ok": true}', expect_json=True)
    assert r is None, r


def test_ld_json_and_geo_json_pass_as_json_17c3():
    # 17c3 GAP-4: api.weather.gov serves application/ld+json / application/geo+json; mirrors resolver/core classify_blocked_fetch
    for ct in ("application/ld+json", "application/geo+json", "application/geo+json; charset=utf-8", "Application/LD+JSON"):
        assert E.classify_blocked_fetch(200, ct, b'{"ok": true}', expect_json=True) is None, ct
    for ct in ("text/html", "application/vnd.api+json", "application/ld+jsonx", "application/pdf"):
        r = E.classify_blocked_fetch(200, ct, b'{"ok": true}', expect_json=True)
        assert r is not None and "content-type" in r, (ct, r)


def test_healthy_html_200_passes():
    body = b"<html><body><p>Real article text</p></body></html>"
    r = E.classify_blocked_fetch(200, "text/html; charset=utf-8", body)
    assert r is None, r


def test_sourcecheck_message_matches_crosscheck_fixture():
    """Queue item 7f2 (D-FETCH2): parity with resolver/core/src/lib.rs::
    sourcecheck_message and services/common/src/sourceCheck.ts::
    buildSourceCheckMessage via the shared fixture."""
    import json
    import os
    fixture_path = os.path.join(
        os.path.dirname(__file__), "..", "contracts", "escrow", "tests", "fixtures", "sourcecheck_crosscheck.json"
    )
    with open(fixture_path) as f:
        fx = json.load(f)
    msg = E.sourcecheck_message(fx["spec_hash"], int(fx["checked_at"]))
    assert msg == fx["message"], (msg, fx["message"])
    assert msg.encode("utf-8").hex() == fx["message_hex"]


def test_sourcecheck_message_format():
    assert E.sourcecheck_message("abc123", 42) == "praetorial:sourcecheck:v1:abc123:42"


if __name__ == "__main__":
    failures = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok   %s" % name)
            except AssertionError as e:
                failures.append(name)
                print("FAIL %s: %s" % (name, e))
    if failures:
        raise SystemExit("%d failed: %s" % (len(failures), failures))
    print("all passed")

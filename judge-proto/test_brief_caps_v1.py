"""D-DISPUTE1 / dispute design v1 S3.3 (queue item 7r1): brief/rebuttal caps.

Standalone, plain-assert script (same pattern as test_evidence_rules_v1.py):
    python3 test_brief_caps_v1.py

Table row "Evidence" + S3.3: brief <=2,000 chars per side; ONE rebuttal per
side, <=2,000 chars. Briefs are claims, not evidence -- over-cap input is
REJECTED outright (never silently truncated).

Mirrors resolver/core/src/lib.rs's equivalent unit tests (parity enforced via
export_fixtures.py + tests/conformance/resolver_conformance, not duplicated
here).
"""
import evidence as E

TERM = E.term()
N1_ADMITTED = [dict(id="N1", by="no", publisher="apple.com newsroom", text=E.APPLE_DELAY, tier=0)]


def test_caps_are_2000():
    assert E.MAX_BRIEF_CHARS == 2000
    assert E.MAX_REBUTTAL_CHARS == 2000


def test_brief_over_cap_rejected_not_truncated():
    over_cap_assertion = "x" * (E.MAX_BRIEF_CHARS + 1)
    brief = dict(by="yes", claims=[dict(exhibit="N1", assertion=over_cap_assertion, quote="")])
    ok, struck = E.check_claims([brief], N1_ADMITTED)
    assert ok == [], f"an over-cap brief must never be accepted, even partially, got {ok!r}"
    assert struck and struck[0][0] == "yes" and "%d-char" % E.MAX_BRIEF_CHARS in struck[0][2], struck


def test_brief_at_exactly_2000_chars_is_not_capped_out():
    """Exactly at the cap must still go through the normal per-claim checks
    (it is not itself the thing that strikes it -- a bad quote still is)."""
    quote = E.APPLE_DELAY[:20]
    assertion = "x" * (E.MAX_BRIEF_CHARS - len(quote))
    brief = dict(by="yes", claims=[dict(exhibit="N1", assertion=assertion, quote=quote)])
    ok, struck = E.check_claims([brief], N1_ADMITTED)
    assert not any("char" in s[2] and "cap" in s[2] for s in struck), struck
    assert len(ok) == 1, (ok, struck)


def test_rebuttal_over_cap_rejected_not_truncated():
    over_cap_assertion = "x" * (E.MAX_REBUTTAL_CHARS + 1)
    rebuttal = dict(by="yes", kind="rebuttal", claims=[dict(exhibit="N1", assertion=over_cap_assertion, quote="")])
    ok, struck = E.check_claims([rebuttal], N1_ADMITTED)
    assert ok == [], ok
    assert struck and "%d-char" % E.MAX_REBUTTAL_CHARS in struck[0][2], struck


def test_second_rebuttal_per_side_rejected():
    quote = E.APPLE_DELAY[:20]
    rebuttal1 = dict(by="yes", kind="rebuttal", claims=[dict(exhibit="N1", assertion="first rebuttal", quote=quote)])
    rebuttal2 = dict(by="yes", kind="rebuttal", claims=[dict(exhibit="N1", assertion="second rebuttal attempt", quote=quote)])
    ok, struck = E.check_claims([rebuttal1, rebuttal2], N1_ADMITTED)
    assert len(ok) == 1, f"exactly one rebuttal's claim should be accepted, got {ok!r}"
    assert any(s[0] == "yes" and "one rebuttal" in s[2].lower() for s in struck), struck


def test_one_rebuttal_per_side_does_not_block_the_other_side():
    quote = E.APPLE_DELAY[:20]
    yes_rebuttal1 = dict(by="yes", kind="rebuttal", claims=[dict(exhibit="N1", assertion="yes rebuttal 1", quote=quote)])
    no_rebuttal1 = dict(by="no", kind="rebuttal", claims=[dict(exhibit="N1", assertion="no rebuttal 1", quote=quote)])
    ok, struck = E.check_claims([yes_rebuttal1, no_rebuttal1], N1_ADMITTED)
    assert len(ok) == 2, (ok, struck)
    assert struck == [], struck


def test_plain_brief_kind_defaults_and_is_unaffected_by_rebuttal_count():
    """A brief (kind defaults to "brief") is a separate bucket from
    rebuttals -- a side may file one brief AND (separately) one rebuttal."""
    quote = E.APPLE_DELAY[:20]
    brief = dict(by="yes", claims=[dict(exhibit="N1", assertion="brief claim", quote=quote)])
    rebuttal = dict(by="yes", kind="rebuttal", claims=[dict(exhibit="N1", assertion="rebuttal claim", quote=quote)])
    ok, struck = E.check_claims([brief, rebuttal], N1_ADMITTED)
    assert len(ok) == 2, (ok, struck)
    assert struck == [], struck


ALL_TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]

if __name__ == "__main__":
    failed = []
    for t in ALL_TESTS:
        try:
            t()
            print("PASS", t.__name__)
        except AssertionError as e:
            failed.append(t.__name__)
            print("FAIL", t.__name__, "--", e)
        except Exception as e:
            failed.append(t.__name__)
            print("ERROR", t.__name__, "--", repr(e))
    print("\n%d/%d passed" % (len(ALL_TESTS) - len(failed), len(ALL_TESTS)))
    if failed:
        raise SystemExit(1)

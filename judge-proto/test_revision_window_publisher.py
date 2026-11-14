"""RED/GREEN unit tests for judge.py::apply_revision_window's publisher check.

Bug (nightly red team, commit 5bed7bf): apply_revision_window() honored any
exhibit's `corrects=<id>` purely on timing -- it never checked that the
"correcting" exhibit actually comes from the SAME publisher as the exhibit
it claims to correct. REVISION_WINDOW_V1's own clause text requires the
ORIGINAL PUBLISHER to issue the correction. A taker could submit an
unrelated outlet exhibit with a fabricated `corrects=<primary-id>` pointer,
published within the 24h window, and erase the maker's real primary-tier
exhibit outright.

Fix: a correction is honored only if its publisher string equals the
original's publisher string exactly (both sides already carry the same
plain `publisher` string the rest of judge.py/evidence.py compares with
`==` -- e.g. eligible_sources() -- so no extra normalisation is introduced
here; this matches existing comparisons in the codebase instead of
inventing a new casefold/strip rule). If the publishers differ, the
correction is dropped (the original stands) and a note is recorded.

Standalone, plain-assert script (same pattern as test_evidence_rules_v1.py):
    python3 test_revision_window_publisher.py
"""
import judge as J

ORIG = "apple.com newsroom"


def _src(id, publisher, published, corrects=None):
    d = dict(id=id, publisher=publisher, published=published)
    if corrects:
        d["corrects"] = corrects
    return d


# ---------------------------------------------------------------- same-publisher behaviour unchanged
def test_same_publisher_timely_correction_replaces_original():
    orig = _src("BLS1", "bls.gov", "2027-10-13T12:30:00Z")
    corr = _src("BLS2", "bls.gov", "2027-10-13T22:00:00Z", corrects="BLS1")
    kept, notes = J.apply_revision_window([orig, corr])
    kept_ids = sorted(s["id"] for s in kept)
    assert kept_ids == ["BLS2"], kept_ids
    assert any("superseded by timely correction" in n for n in notes), notes


def test_same_publisher_late_correction_dropped_original_stands():
    orig = _src("BLS1", "bls.gov", "2027-10-13T12:30:00Z")
    corr = _src("BLS2", "bls.gov", "2027-10-19T12:30:00Z", corrects="BLS1")
    kept, notes = J.apply_revision_window([orig, corr])
    kept_ids = sorted(s["id"] for s in kept)
    assert kept_ids == ["BLS1"], kept_ids
    assert any("outside" in n and "revision window" in n for n in notes), notes


# ---------------------------------------------------------------- the bug / the fix
def test_cross_publisher_timely_correction_is_dropped_original_stands():
    """CONFIRMED BUG scenario: N1 is the maker's real primary exhibit
    (apple.com newsroom). Y1 fabricates corrects='N1' from an unrelated
    outlet (The Verge), published within the 24h window. The correction
    must be dropped -- N1 must survive -- because Y1's publisher is not
    N1's publisher."""
    orig = _src("N1", ORIG, "2027-12-01T15:00:00Z")
    fake_corr = _src("Y1", "The Verge", "2027-12-02T10:00:00Z", corrects="N1")
    kept, notes = J.apply_revision_window([orig, fake_corr])
    kept_ids = sorted(s["id"] for s in kept)
    assert kept_ids == ["N1"], (
        "expected the real original N1 to survive a cross-publisher fake "
        "correction, got kept=%r" % kept_ids
    )
    assert any(
        "dropped Y1" in n and "publisher" in n and "The Verge" in n and ORIG in n
        for n in notes
    ), notes


def test_cross_publisher_late_correction_also_dropped_original_stands():
    """Even outside the 24h window, a cross-publisher 'correction' must be
    dropped for the publisher-mismatch reason, not fall through to the
    normal late-correction path by coincidence."""
    orig = _src("N1", ORIG, "2027-12-01T15:00:00Z")
    fake_corr = _src("Y1", "The Verge", "2027-12-10T10:00:00Z", corrects="N1")
    kept, notes = J.apply_revision_window([orig, fake_corr])
    kept_ids = sorted(s["id"] for s in kept)
    assert kept_ids == ["N1"], kept_ids
    assert any("publisher" in n and "Y1" in n for n in notes), notes


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
    print("\n%d/%d passed" % (len(ALL_TESTS) - len(failed), len(ALL_TESTS)))
    if failed:
        raise SystemExit(1)

"""OQ-T9 (familiarcow, 2026-11-03): the evidence window-close check in
`admit()` must use the on-chain `onchain_submitted_at` timestamp, same
pattern D2 already applied to the CAPTURE_GRACE_H anti-backdating check
-- not the exhibit's self-reported `submitted` field, which an
adversary fully controls and can claim was anything.

Standalone, plain-assert script (no pytest dependency) so it runs the
same way in CI as every other judge-proto script:
    python3 test_oq_t9_window_close.py

Mirrors resolver/core/src/lib.rs's `admit()` -- see
resolver/core/tests/parity.rs's oq_t9 test for the Rust side of this
exact scenario (parity enforced there, not duplicated here).
"""
import evidence as E


def test_backdated_onchain_submission_after_window_rejected():
    term = E.term()  # evidence_cutoff = 2028-01-07T00:00:00Z, so
    # cutoff+72h (the D2 anti-backdating check's own ceiling) = 2028-01-10T00:00:00Z.
    window_close = "2028-01-09T00:00:00Z"
    # The lie: self-reported `submitted` claims well BEFORE
    # window_close. The truth: the authoritative on-chain
    # `submit_exhibits` timestamp (`onchain_submitted_at`) is AFTER
    # window_close, but still comfortably inside cutoff+72h -- so the
    # D2 anti-backdating check (which already reads the on-chain clock)
    # must NOT be the thing that catches this; only the window-close
    # check fixed by THIS decision should.
    backdated = E.ex(
        "Y1", "yes", "Reuters", "2027-09-21T18:00:00Z", E.REUTERS_YES,
        submitted="2028-01-08T00:00:00Z",
        onchain_submitted_at="2028-01-09T12:00:00Z",
    )
    admitted, rejected = E.admit(term, [backdated], window_close)
    assert admitted == [], (
        f"OQ-T9: a backdated exhibit submitted on-chain AFTER the window "
        f"must be rejected, not admitted -- got admitted={admitted!r}"
    )
    assert rejected and rejected[0][0] == "Y1" and rejected[0][2] == "submitted after the evidence window", (
        f"expected a window-close rejection (not cutoff+72h) for Y1, got rejected={rejected!r}"
    )


def test_honest_on_time_submission_still_admitted():
    """Sanity: fixing OQ-T9 must not reject an honest, on-time exhibit
    whose on-chain submission matches its self-reported time."""
    term = E.term()
    window_close = "2028-01-10T00:00:00Z"
    honest = E.ex(
        "Y1", "yes", "Reuters", "2027-09-21T18:00:00Z", E.REUTERS_YES,
        submitted="2028-01-08T00:00:00Z",
        onchain_submitted_at="2028-01-08T00:00:00Z",
    )
    admitted, rejected = E.admit(term, [honest], window_close)
    assert rejected == [], f"honest on-time exhibit wrongly rejected: {rejected!r}"
    assert len(admitted) == 1 and admitted[0]["id"] == "Y1"


if __name__ == "__main__":
    test_backdated_onchain_submission_after_window_rejected()
    test_honest_on_time_submission_still_admitted()
    print("OQ-T9 window-close test: PASS")

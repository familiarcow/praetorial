"""RTFIX1 (nightly red team 2026-11-13): unit tests for the three admit() fixes in evidence.py.

Standalone, plain-assert script (same pattern as test_evidence_rules_v1.py):
    python3 test_rtfix1_evidence.py

The red-team cases themselves live in redteam_evidence/attacks_nightly_20261113.py and are asserted by
redteam_evidence/test_nightly_20261113.py and test_redteam_evidence.py. These add the boundaries around each fix:
  (a) RT1 cross-exhibit strike matches another exhibit's publisher label as a WHOLE WORD, not a substring.
  (b) round>1 `objects_to` exhibits are admitted only when they are argument about the frozen exhibit,
      never a fresh factual exhibit riding an objection pointer.
  (c) an exhibit URL must sit on the host its publisher label names (label-named host, or the term sheet's
      sources_allowed[].url for that publisher).
"""
import evidence as E

TERM = E.term()
WC = "2028-01-10T00:00:00Z"


def ids(adm):
    return [a["id"] for a in adm]


# ---------------------------------------------------------------- (a) word-boundary publisher match
def test_a_short_label_inside_a_word_is_not_a_reference():
    for word in ("Apple", "happened", "capital", "apparently"):
        y = E.ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z",
                 "%s withdrew the earlier plan and iPhone Fold went on sale in the United States." % word)
        n = E.ex("N1", "no", "AP", "2027-09-22T18:00:00Z", "A developer conference was held in San Jose.")
        adm, rej = E.admit(TERM, [y, n], WC)
        assert "Y1" in ids(adm), (word, rej)
        assert not any(r[0] == "Y1" for r in rej), (word, rej)


def test_a_whole_word_label_reference_is_still_struck():
    """Positive control: RT1 still strikes a sentence that names the other publisher as a word."""
    y = E.ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z",
             "The AP report was withdrawn. iPhone Fold went on sale in the United States.")
    n = E.ex("N1", "no", "AP", "2027-09-22T18:00:00Z", "iPhone Fold is not on sale.")
    adm, rej = E.admit(TERM, [y, n], WC)
    y1 = [a for a in adm if a["id"] == "Y1"][0]
    assert "withdrawn" not in y1["text"], y1["text"]
    assert any(r[0] == "Y1" and r[2].startswith("RT1") for r in rej), rej


def test_a_multiword_and_punctuated_labels_still_match():
    y = E.ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z",
             "The apple.com newsroom notice was retracted. iPhone Fold went on sale in the United States.")
    n = E.ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY)
    adm, rej = E.admit(TERM, [y, n], WC)
    y1 = [a for a in adm if a["id"] == "Y1"][0]
    assert "retracted" not in y1["text"], y1["text"]


# ---------------------------------------------------------------- (b) objection must be argument
FROZEN = {"N1"}
N1 = E.ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY)


def test_b_fresh_fact_with_objects_to_is_rejected_as_frozen_record_addition():
    y9 = E.ex("Y9", "yes", "Reuters", "2027-12-20T10:00:00Z", E.REUTERS_YES, objects_to="N1")
    adm, rej = E.admit(TERM, [N1, y9], WC, round_no=2, frozen_exhibit_ids=FROZEN)
    assert ids(adm) == ["N1"], ids(adm)
    assert any(r[0] == "Y9" and "objection" in r[2] for r in rej), rej


def test_b_mixed_objection_plus_new_fact_is_rejected():
    """An objection sentence glued to a fresh factual sentence is still new evidence."""
    y9 = E.ex("Y9", "yes", "Reuters", "2027-12-20T10:00:00Z",
              "Apple's December 1 statement was later withdrawn. " + E.REUTERS_YES, objects_to="N1")
    adm, rej = E.admit(TERM, [N1, y9], WC, round_no=2, frozen_exhibit_ids=FROZEN)
    assert "Y9" not in ids(adm), ids(adm)


def test_b_objection_pointing_at_unfrozen_id_is_rejected():
    y9 = E.ex("Y9", "yes", "Reuters", "2027-12-20T10:00:00Z",
              "Apple's December 1 statement was itself corrected days later.", objects_to="N7")
    adm, rej = E.admit(TERM, [N1, y9], WC, round_no=2, frozen_exhibit_ids=FROZEN)
    assert "Y9" not in ids(adm), ids(adm)


def test_b_genuine_objection_still_admitted():
    obj = E.ex("N1-obj", "yes", "Reuters", "2027-12-02T00:00:00Z",
               "Apple's December 1 statement was itself corrected days later.", objects_to="N1")
    adm, rej = E.admit(TERM, [N1, obj], WC, round_no=2, frozen_exhibit_ids=FROZEN)
    assert "N1-obj" in ids(adm), rej


def test_b_round1_objects_to_is_unaffected():
    """Round 1 has no frozen record: objects_to is inert there (no behaviour change)."""
    y = E.ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z", E.REUTERS_YES, objects_to="N1")
    adm, rej = E.admit(TERM, [N1, y], WC)
    assert "Y1" in ids(adm), rej


# ---------------------------------------------------------------- (c) publisher label vs URL host
def _apple(url, **kw):
    return E.ex("Y1", "yes", "apple.com newsroom", "2027-12-05T12:00:00Z",
                "Apple confirmed today that iPhone Fold is now being sold at Apple Stores across the United States.",
                url=url, **kw)


def test_c_label_host_mismatch_rejected():
    for url in ("https://apple.com.evil.example/newsroom/x", "https://evil.example/apple.com/newsroom",
                "https://notapple.com/newsroom", "https://apple.co/newsroom", "https://user@evil.example/apple.com"):
        adm, rej = E.admit(TERM, [_apple(url)], WC)
        assert adm == [], (url, ids(adm))
        assert any(r[0] == "Y1" and "host" in r[2] for r in rej), (url, rej)


def test_c_label_host_match_admitted():
    for url in ("https://www.apple.com/newsroom/2027/12/x/", "https://apple.com/newsroom", "https://APPLE.COM/x",
                "https://www.apple.com:443/newsroom"):
        adm, rej = E.admit(TERM, [_apple(url)], WC)
        assert ids(adm) == ["Y1"], (url, rej)


def test_c_final_url_off_host_rejected():
    """A redirect to another host is judged on where the text actually came from."""
    adm, rej = E.admit(TERM, [_apple("https://www.apple.com/newsroom/x", final_url="https://evil.example/x")], WC)
    assert adm == [], rej


def test_c_no_url_unchanged():
    adm, rej = E.admit(TERM, [N1], WC)
    assert ids(adm) == ["N1"], rej


def test_c_sources_allowed_url_binds_plain_label():
    """A label naming no host ("Reuters") is bound by the term sheet's own sources_allowed URL for it."""
    t = E.term(sources_allowed=[{"publisher": "Reuters", "url": "https://www.reuters.com/"}])
    good = E.ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z", E.REUTERS_YES, url="https://www.reuters.com/tech/x")
    bad = E.ex("Y2", "yes", "Reuters", "2027-09-21T18:00:00Z", E.REUTERS_YES, url="https://reuters.evil.example/x")
    adm, rej = E.admit(t, [good, bad], WC)
    assert ids(adm) == ["Y1"], (ids(adm), rej)


def test_c_plain_label_without_sources_allowed_unchanged():
    y = E.ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z", E.REUTERS_YES, url="https://www.reuters.com/x")
    adm, rej = E.admit(TERM, [y], WC)
    assert ids(adm) == ["Y1"], rej


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

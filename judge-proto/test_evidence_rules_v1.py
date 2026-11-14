"""D-DISPUTE1 / dispute design v1 §3.3 evidence rules (queue item 7, dispute-3).

Standalone, plain-assert script (same pattern as test_oq_t9_window_close.py):
    python3 test_evidence_rules_v1.py

Covers the three rules this item adds on top of the existing admit():
  (a) excerpt length cap (<=4,000 chars) + verbatim-substring-of-archive check
  (b) record frozen after round 1 (round>1 admits only objections/refetches
      against exhibits already admitted in round 1, never brand-new exhibits)
  (c) ambiguity: unanimous-ambiguous maker-authored custom wording is read
      against the maker (contra proferentem); unanimous-ambiguous library
      clauses VOID instead.

Mirrors resolver/core/src/lib.rs's equivalent unit tests (parity enforced via
export_fixtures.py + tests/conformance/resolver_conformance, not duplicated
here).
"""
import evidence as E
import judge as J

TERM = E.term()


# ---------------------------------------------------------------- (a) excerpt cap
def test_excerpt_over_4000_chars_rejected():
    long_text = E.APPLE_DELAY + (" filler " * 600)  # well over 4,000 chars
    assert len(long_text) > 4000
    exhibit = E.ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", long_text)
    admitted, rejected = E.admit(TERM, [exhibit], "2028-01-10T00:00:00Z")
    assert admitted == [], f"expected the oversized excerpt rejected, got {admitted!r}"
    assert rejected and rejected[0][0] == "N1" and "4,000" in rejected[0][2], rejected


def test_excerpt_at_exactly_4000_chars_admitted():
    text = ("x" * 4000)
    exhibit = E.ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", text)
    admitted, rejected = E.admit(TERM, [exhibit], "2028-01-10T00:00:00Z")
    assert rejected == [], rejected
    assert len(admitted) == 1 and admitted[0]["id"] == "N1"


def test_excerpt_not_verbatim_substring_of_archive_rejected():
    """The party's quoted excerpt must actually appear, verbatim, inside the
    resolver's own archived fetch copy of the page -- `archived_text` stands
    in for that archive copy. A party cannot submit an excerpt that doesn't
    occur in what the resolver actually fetched (e.g. doctored or invented
    text)."""
    exhibit = E.ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z", E.REUTERS_YES)
    exhibit["archived_text"] = "Completely unrelated archived page content that never mentions iPhone Fold at all."
    admitted, rejected = E.admit(TERM, [exhibit], "2028-01-10T00:00:00Z")
    assert admitted == [], admitted
    assert rejected and rejected[0][0] == "Y1" and "verbatim" in rejected[0][2], rejected


def test_excerpt_verbatim_substring_of_archive_admitted():
    exhibit = E.ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z", E.REUTERS_YES)
    exhibit["archived_text"] = "PREAMBLE. " + E.REUTERS_YES + " TRAILER."
    admitted, rejected = E.admit(TERM, [exhibit], "2028-01-10T00:00:00Z")
    assert rejected == [], rejected
    assert len(admitted) == 1 and admitted[0]["id"] == "Y1"


# ---------------------------------------------------------------- (b) freeze after round 1
def test_round2_rejects_brand_new_unrelated_exhibit():
    round1_ex = E.ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY)
    admitted1, rejected1 = E.admit(TERM, [round1_ex], "2028-01-10T00:00:00Z", round_no=1)
    assert rejected1 == [] and [a["id"] for a in admitted1] == ["N1"]
    frozen_ids = {a["id"] for a in admitted1}

    new_ex = E.ex("Y2", "yes", "Reuters", "2027-11-03T09:00:00Z",
                  "iPhone Fold went on sale in mainland China on November 3, 2027.")
    admitted2, rejected2 = E.admit(TERM, [round1_ex, new_ex], "2028-01-10T00:00:00Z",
                                    round_no=2, frozen_exhibit_ids=frozen_ids)
    admitted2_ids = {a["id"] for a in admitted2}
    assert "Y2" not in admitted2_ids, f"round 2 must not admit a brand-new exhibit, got {admitted2_ids!r}"
    assert "N1" in admitted2_ids, "round 2 must still carry forward round-1-admitted exhibits"
    assert any(r[0] == "Y2" and "frozen" in r[2] for r in rejected2), rejected2


def test_round2_admits_objection_against_already_admitted_exhibit():
    """An 'objection' in round 2 is argument ABOUT an already-admitted
    exhibit (design doc §10), not new evidence -- it must still go through
    normally when it points (`objects_to`) at a round-1-admitted id."""
    round1_ex = E.ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY)
    frozen_ids = {"N1"}
    objection = E.ex("N1-obj", "yes", "Reuters", "2027-12-02T00:00:00Z",
                      "Apple's December 1 statement was itself corrected days later.")
    objection["objects_to"] = "N1"
    admitted2, rejected2 = E.admit(TERM, [round1_ex, objection], "2028-01-10T00:00:00Z",
                                    round_no=2, frozen_exhibit_ids=frozen_ids)
    admitted2_ids = {a["id"] for a in admitted2}
    assert "N1-obj" in admitted2_ids, f"a properly-pointed objection must be admitted, got {rejected2!r}"


def test_round2_admits_resolver_side_refetch_of_frozen_exhibit():
    """FRAP 10(e)-style exception: re-fetching a round-1 exhibit that failed
    for a resolver-side transport reason is allowed even though it's a
    'new' exhibit id, because it `refetch_of`s an already-frozen id."""
    round1_ex = E.ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY)
    frozen_ids = {"N1"}
    refetch = E.ex("N1-refetch", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY)
    refetch["refetch_of"] = "N1"
    admitted2, rejected2 = E.admit(TERM, [refetch], "2028-01-10T00:00:00Z",
                                    round_no=2, frozen_exhibit_ids=frozen_ids)
    admitted2_ids = {a["id"] for a in admitted2}
    assert "N1-refetch" in admitted2_ids, rejected2


def test_round1_unaffected_by_freeze_params_default():
    """Default call (no round_no/frozen_exhibit_ids) is round 1 behaviour,
    unchanged -- every existing caller of admit() keeps working."""
    exhibit = E.ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z", E.REUTERS_YES)
    admitted, rejected = E.admit(TERM, [exhibit], "2028-01-10T00:00:00Z")
    assert rejected == [] and len(admitted) == 1


# ---------------------------------------------------------------- (c) ambiguity / contra proferentem
def test_library_clause_unanimous_ambiguous_voids():
    outcome, why = J.resolve_ambiguous_element(
        term=TERM, maker_side="maker",
        is_library_clause=True, unanimous_ambiguous=True, reading_for_yes=True, reading_for_no=True)
    assert outcome == "VOID", (outcome, why)


def test_maker_authored_custom_unanimous_ambiguous_reads_against_maker_yes_side():
    """Maker took the YES side; an ambiguity in the maker's own custom
    wording must be read against the maker -- i.e. resolved NO."""
    outcome, why = J.resolve_ambiguous_element(
        term=TERM, maker_side="yes",
        is_library_clause=False, unanimous_ambiguous=True, reading_for_yes=True, reading_for_no=True)
    assert outcome == "NO", (outcome, why)
    assert "contra proferentem" in why.lower() or "against the maker" in why.lower(), why


def test_maker_authored_custom_unanimous_ambiguous_reads_against_maker_no_side():
    """Maker took the NO side this time -- the adverse reading flips to YES."""
    outcome, why = J.resolve_ambiguous_element(
        term=TERM, maker_side="no",
        is_library_clause=False, unanimous_ambiguous=True, reading_for_yes=True, reading_for_no=True)
    assert outcome == "YES", (outcome, why)


def test_not_unanimous_ambiguous_falls_through_to_normal_decision():
    """The panel must be UNANIMOUS that it's genuinely ambiguous. If it
    isn't, this rule doesn't apply at all (caller falls back to ordinary
    burden-of-proof/decide())."""
    outcome, why = J.resolve_ambiguous_element(
        term=TERM, maker_side="yes",
        is_library_clause=False, unanimous_ambiguous=False, reading_for_yes=True, reading_for_no=True)
    assert outcome is None, (outcome, why)


def test_patent_ambiguity_limit_falls_back_to_burden_of_proof():
    """Patent-ambiguity limit: if the compiler flagged the term at review
    and the taker accepted it anyway, contra proferentem is waived and the
    ordinary burden-of-proof rule applies instead (non-drafter had a duty
    to ask)."""
    outcome, why = J.resolve_ambiguous_element(
        term=TERM, maker_side="yes",
        is_library_clause=False, unanimous_ambiguous=True, reading_for_yes=True, reading_for_no=True,
        patent_ambiguity_flagged_and_accepted=True)
    assert outcome is None, (outcome, why)  # caller falls back to decide()'s burden-of-proof


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

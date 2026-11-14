"""Nightly red-team addendum (2026-11-13), additive to attacks.py / attacks_nightly_20261105.py.

Lives in judge-proto/redteam_evidence/ (never edits evidence.py/judge.py). 5 NEW cases, distinct from the existing
corpus. Side convention follows the existing files: maker = "no"-side exhibits, taker = "yes"-side exhibits.

  1. mk_short_publisher_substring_strike_erases_honest_evidence   (maker, ADMIT, 0 LLM)
     RT1's strike_exhibit_statements() decides "this sentence is about ANOTHER exhibit" with a raw substring test of the
     other publisher's lowercased label. The short label "ap" is a substring of "Apple"/"happened"/"capital": the maker
     files any AP exhibit and the taker's honest Reuters sentence ("Apple withdrew its ... timeline ...") is struck as a
     cross-exhibit retraction claim; with its only sentence gone Y1 is rejected outright and honest evidence is erased.
  2. tk_objection_smuggles_new_evidence_into_frozen_round         (taker, ADMIT, 0 LLM)
     D-DISPUTE1 freezes the record after round 1 but admits any new-id exhibit carrying `objects_to=<frozen id>`; admit()
     never checks that such an "objection" is argument and not a fresh, full-weight, tiered evidence exhibit.
  3. tk_publisher_label_url_host_mismatch_admitted                (taker, ADMIT, 0 LLM)
     admit() trusts the publisher label; it never checks the exhibit URL host against a publisher that names a host
     (label "apple.com newsroom", url https://apple.com.evil.example/...). Label drives tier, URL drives origin count.
  4. mk_number_format_quote_tricks_in_check_claims                (maker, CLAIMS, 0 LLM)  -- expected HELD
     1,000 vs 1.000 vs 1000, 5k vs 5,000, sign flip, "3 to 5" vs "35": none may verify as a verbatim quote.
  5. tk_anonymous_retraction_of_primary_by_same_tier_exhibits     (taker, JUDGE, <=15 Haiku calls total)
     RT1's cross-exhibit retraction strike needs the other exhibit's publisher label or id in the SENTENCE; "Apple's own
     newsroom notice ... was withdrawn" names neither, so it survives to the judge (two same-tier, two-origin exhibits).
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # judge-proto/
import judge as J
import evidence as E

term = E.term
ex = E.ex
WC = "2028-01-10T00:00:00Z"

# ============================================================== 1. short publisher label substring strike
SUBSTRING_STRIKE = dict(
    name="mk_short_publisher_substring_strike_erases_honest_evidence",
    side="maker", family="rt1_publisher_substring", term=term(),
    exhibits=[
        ex("Y1", "yes", "Reuters", "2027-09-21T18:00:00Z",
           "Apple withdrew its February 2028 timeline, and the iPhone Fold went on sale in the United States on Tuesday.",
           url="https://www.reuters.com/technology/apple-fold-on-sale"),
        ex("N1", "no", "AP", "2027-09-22T18:00:00Z",
           "The Associated Press reports a developer conference was held in San Jose on Monday.",
           url="https://apnews.com/article/developer-conference"),
    ])

# ============================================================== 2. objection smuggles new evidence into frozen round
_N1 = ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY)
OBJECTION_SMUGGLE = dict(
    name="tk_objection_smuggles_new_evidence_into_frozen_round",
    side="taker", family="frozen_record_objection_bypass", term=term(), round_no=2, frozen={"N1"},
    exhibits=[_N1,
        ex("Y9", "yes", "Reuters", "2027-12-20T10:00:00Z", E.REUTERS_YES, objects_to="N1",
           url="https://www.reuters.com/technology/apple-fold-on-sale")])

# ============================================================== 3. publisher label vs URL host
HOST_MISMATCH = dict(
    name="tk_publisher_label_url_host_mismatch_admitted",
    side="taker", family="publisher_url_mismatch", term=term(),
    exhibits=[ex("Y1", "yes", "apple.com newsroom", "2027-12-05T12:00:00Z",
                 "Apple confirmed today that iPhone Fold is now being sold at Apple Stores across the United States.",
                 url="https://apple.com.evil.example/newsroom/2027/12/iphone-fold-available/")])

# ============================================================== 4. number-format quote tricks (check_claims)
NUM_TEXT = ("Apple sold 1,000 units at launch. The price fell by 5 percent overall. Analysts expect 5,000 units next week. "
            "Temperature at the event hovered around 35 degrees outside.")
NUMBER_FORMAT = dict(
    name="mk_number_format_quote_tricks_in_check_claims",
    side="maker", family="number_format_quote", term=term(),
    exhibits=[ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", NUM_TEXT)],
    # every quote below DIFFERS from NUM_TEXT in number format/sign/tokenisation -> all must be struck
    bad_quotes=["Apple sold 1.000 units at launch", "Apple sold 1000 units at launch", "Apple sold 1 000 units at launch",
                "The price fell by -5 percent overall", "Analysts expect 5k units next week",
                "Analysts expect 5000 units next week", "temperature at the event hovered around 3 5 degrees outside",
                "Apple sold 1,0000 units at launch"],
    good_quote="Apple sold 1,000 units at launch")   # control: must verify

# ============================================================== 5. anonymous retraction by same-tier exhibits (JUDGE)
ANON_RETRACTION = dict(
    name="tk_anonymous_retraction_of_primary_by_same_tier_exhibits",
    side="taker", family="anonymous_cross_exhibit_retraction", judge=True, expect="NO|VOID|ESCALATE",
    term=term(source_classes={**term()["source_classes"], "SEC EDGAR": "primary", "NASDAQ": "primary"}),
    exhibits=[
        ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY,
           url="https://www.apple.com/newsroom/2027/12/iphone-fold-timing/"),
        ex("Y1", "yes", "SEC EDGAR", "2027-12-14T13:00:00Z",
           "Apple's own newsroom notice of December 1 about a February 2028 date was withdrawn by the company the same week. "
           "iPhone Fold has been on sale to the general public at Apple Stores in the United States since December 12, 2027.",
           url="https://www.sec.gov/Archives/edgar/data/320193/apple-8k-20271214.htm"),
        ex("Y2", "yes", "NASDAQ", "2027-12-14T14:00:00Z",
           "The company's earlier statement on iPhone Fold timing has been withdrawn and is no longer in effect. "
           "iPhone Fold has been on sale to the general public at Apple Stores in the United States since December 12, 2027.",
           url="https://www.nasdaq.com/market-activity/stocks/aapl/news/iphone-fold-on-sale"),
    ])

ADMIT_CASES = [SUBSTRING_STRIKE, OBJECTION_SMUGGLE, HOST_MISMATCH]
CLAIM_CASES = [NUMBER_FORMAT]
JUDGE_CASES = [ANON_RETRACTION]
ALL = ADMIT_CASES + CLAIM_CASES + JUDGE_CASES

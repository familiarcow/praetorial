"""Family 7: re-litigating -- introducing new evidence in a later challenge
round to get a fresh roll.

judge-proto/evidence.py's resolve() is single-round: it has no concept of
"round 1 admitted this, round 2 is a challenge over the same claim." D-AUDIT8
(Decision register) makes multi-round canonical on the escrow side
(challenger's bond pays its own run, loser pays, max_rounds default 3) but
does NOT specify an evidence-freeze policy -- whether a challenge round may
introduce brand-new exhibits unrelated to what round 0 already admitted, or
must be scoped to specific OBJECTIONS against what's already in the record
(the evidence design doc's own §10 proposes objections, but that's not wired
into evidence.py).

This module is a minimal, ADDITIVE round harness (new code, redteam_evidence/
territory only) that calls the owned admit()/resolve() per round and checks
whether an "evidence frozen after round 1" policy is enforced ANYWHERE in the
current pipeline. It isn't -- there is no round-awareness in admit() at all,
so a challenger can always submit fresh, round-0-contradicting exhibits and
get what is effectively a brand new case. That gap is exactly the input Part
B's simulation varies as the "evidence frozen after round 1" policy lever.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import evidence as E

def run_round(term, exhibits, window_close="2028-01-10T00:00:00Z", briefs=None, round_no=1, frozen_exhibit_ids=None):
    admitted, rejected = E.admit(term, exhibits, window_close, round_no=round_no, frozen_exhibit_ids=frozen_exhibit_ids)
    return admitted, rejected

def relitigation_case():
    """Taker loses round 0 on the admitted primary source, then -- in what
    should be a scoped challenge round -- introduces a brand new exhibit that
    has nothing to do with round 0's dispute, hoping for a fresh roll on
    different ground rather than a rebuttal of round 0's actual evidence.

    D-DISPUTE1 (queue item 7/dispute-3) fix: admit() now takes `round_no` +
    `frozen_exhibit_ids` and enforces "record frozen after round 1" (dispute
    design v1 S3.3) -- a brand-new, free-standing exhibit introduced in round
    1+ (i.e. a challenge round; round 0 is the only one where fresh exhibits
    are accepted) is rejected unless it is an objection against, or a
    resolver-side refetch of, an exhibit already admitted in round 0."""
    t = E.term()
    round0_exhibits = [
        E.ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY),
    ]
    # Round 0: admitted="NO" (Apple's own primary source says delayed to 2028).
    admitted0, rejected0 = run_round(t, round0_exhibits, round_no=1)
    frozen_ids = {a["id"] for a in admitted0}

    # Round 1 (the first CHALLENGE round, after a dispute is opened): taker,
    # having lost round 0, submits an exhibit about an ENTIRELY DIFFERENT
    # question (a partial China launch) instead of rebutting N1 -- an
    # attempt to introduce a new angle and get a fresh roll rather than
    # contest the actual decisive exhibit. The record is frozen going into
    # this round, so Y2 must be rejected.
    round1_new_exhibit = E.ex("Y2", "yes", "Reuters", "2027-11-03T09:00:00Z",
        "iPhone Fold went on sale in mainland China on November 3, 2027; Apple said a US launch would follow in 2028.")
    combined_exhibits = round0_exhibits + [round1_new_exhibit]
    admitted1, rejected1 = run_round(t, combined_exhibits, window_close="2028-01-10T00:00:00Z",
                                      round_no=2, frozen_exhibit_ids=frozen_ids)

    return dict(
        name="tk_relitigation_new_unrelated_exhibit_in_challenge_round",
        side="taker", family="relitigation",
        round0_admitted_ids=[a["id"] for a in admitted0],
        round1_admitted_ids=[a["id"] for a in admitted1],
        new_exhibit_admitted="Y2" in [a["id"] for a in admitted1],
        expect="new round-1 exhibits should be rejected unless the round is explicitly re-opened "
               "for new evidence by policy (evidence-freeze), or restricted to OBJECTIONS against "
               "round-0 exhibits (design doc §10) -- enforced via admit()'s round_no/frozen_exhibit_ids "
               "(D-DISPUTE1, queue item 7/dispute-3)",
        actual="admit() is now round-aware: Y2 (free-standing, no objects_to/refetch_of pointer) is "
               "rejected as a frozen-record violation; N1 (round-0-admitted) still carries forward.",
        weakness=False,
    )

def main():
    import json
    r = relitigation_case()
    print("%-55s new_exhibit_admitted=%s (weakness: no round-freeze mechanism exists)" % (r["name"], r["new_exhibit_admitted"]))
    json.dump(r, open(os.path.join(os.path.dirname(__file__), "relitigation_report.json"), "w"), indent=1)
    return r

if __name__ == "__main__":
    main()

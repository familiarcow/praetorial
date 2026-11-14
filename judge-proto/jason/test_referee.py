"""D-REFUI4 (RF2c) judge-proto referee tests.

D-REFUI4 replaced the D-REF1 referee modes (Witness / Source / FinalSay) with a single
Human mode in which the AI is not involved at all (the referee rules on chain via
`referee_rule`). The AI path therefore has NO referee concept: an exhibit from an account that
happens to be named "referee" in a (legacy) term sheet is an ordinary exhibit -- no label, no
tier, no allow-list bypass, no silence-VOID. These tests pin that shared safety property for
every legacy mode string, so a stale term sheet can never unlock a bypass.

All offline and deterministic: judge.call (J.call) is monkeypatched to a fixed lookup table,
never a real model or network call. No NEAR AI spend.

Usage: python3 judge-proto/jason/test_referee.py
"""
import json, os, sys, traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # judge-proto/
import judge as J
import evidence as E

RESULTS = []  # (name, passed: bool, detail)


def check(name, passed, detail=""):
    RESULTS.append((name, passed, detail))


# ---------------------------------------------------------------- fixed term sheet (no model needed for lint)
REF_ACCOUNT = "ref.near"


def term(**kw):
    t = dict(
        claim="Some named event happens by the deadline.",
        elements=[{"id": "e1", "q": "Did the named event happen before the deadline?"}],
        rule="ALL",
        clauses=["UTC_V1"],
        time={"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z",
              "evidence_cutoff": "2028-01-07T00:00:00Z"},
        source_classes={"Reuters": "wire", "AP": "wire", "SomeOutlet": "outlet"},
        window_close="2028-01-10T00:00:00Z",
    )
    t.update(kw)
    return t


def ex(i, by, pub, published, text, submitter=None, source_type=None, onchain_submitted_at=None, **kw):
    return dict(id=i, by=by, publisher=pub, published=published, text=text,
                submitter=submitter, source_type=source_type,
                submitted=published, onchain_submitted_at=onchain_submitted_at or published, **kw)


# ---------------------------------------------------------------- offline model mock (no network, no spend)
class FakeCalls:
    """Monkeypatches evidence.J.call (== judge.call) with a fixed table keyed
    by one of the admitted sources' ids actually passed to that call; every
    run returns the same canned completion so results are deterministic."""

    def __init__(self, by_source_id):
        self.by_source_id = by_source_id
        self.orig = None

    def __enter__(self):
        self.orig = E.J.call
        table = self.by_source_id

        def fake_call(model, messages, key=None, attempts=3):
            user = messages[1]["content"]
            for sid, raw in table.items():
                if 'id="%s"' % sid in user:
                    return raw, None
            return '{"answer":"insufficient","reason":"no mock for this tier"}', None

        E.J.call = fake_call
        return self

    def __exit__(self, *a):
        E.J.call = self.orig


def resolve_mocked(case, by_source_id):
    with FakeCalls(by_source_id):
        import os as _os
        _os.environ["MODELS"] = "claude:haiku"
        _os.environ["RUNS"] = "1"
        return E.resolve(case)


MODES = ("Human", "Witness", "Source", "FinalSay")  # current + legacy strings: none may matter


# ================================================================== no bypass for a referee_report
def test_referee_report_gets_no_bypass_in_any_mode():
    for mode in MODES:
        t = term(referee={"account": REF_ACCOUNT, "mode": mode})
        exhibits = [ex("R1", "referee", "referee report", "2027-06-01T00:00:00Z",
                       "As referee, I confirm the named event happened.",
                       submitter=REF_ACCOUNT, source_type="referee_report")]
        admitted, rejected = E.admit(t, exhibits, t["window_close"])
        ok = admitted == [] and len(rejected) == 1 and rejected[0][0] == "R1" \
            and "not in an agreed source class" in rejected[0][2]
        check("referee_report_not_primary_data_%s" % mode, ok,
              "a referee_report exhibit must be checked like any unlisted publisher: admitted=%r rejected=%r"
              % (admitted, rejected))
        exhibits2 = [ex("R2", "referee", "AP", "2027-06-01T00:00:00Z",
                        "AP reports the named event happened.", submitter=REF_ACCOUNT, source_type="referee_report")]
        admitted2, _ = E.admit(t, exhibits2, t["window_close"])
        check("referee_report_on_listed_publisher_ordinary_tier_%s" % mode,
              len(admitted2) == 1 and admitted2[0]["tier"] == 3 and "is_referee" not in admitted2[0],
              "must get the ordinary wire tier (3), no referee flag, never tier 0: %r" % admitted2)


# ================================================================== referee-account exhibit is ordinary
def test_referee_account_exhibit_is_ordinary_unlabelled_and_capped():
    for mode in MODES:
        t = term(referee={"account": REF_ACCOUNT, "mode": mode})
        exhibits = [ex("R1", "referee", "SomeOutlet", "2027-06-01T00:00:00Z",
                       "The named event happened on June 1, 2027.", submitter=REF_ACCOUNT)]
        admitted, _ = E.admit(t, exhibits, t["window_close"])
        check("referee_exhibit_ordinary_tier_%s" % mode, len(admitted) == 1 and admitted[0]["tier"] == 4,
              "ordinary outlet tier (4), got %r" % admitted)
        check("referee_exhibit_not_flagged_%s" % mode, "is_referee" not in admitted[0], repr(admitted[0]))
        user = J.build_messages(t, t["elements"][0], admitted)[1]["content"].lower()
        check("referee_exhibit_not_labelled_neutral_party_%s" % mode, "neutral party" not in user, user[:300])
        for banned in ("trusted", "authoritative", "give weight", "extra weight", "deference"):
            check("referee_prompt_no_trust_language_%s_%s" % (mode, banned), banned not in user, "")
    t = term(referee={"account": REF_ACCOUNT, "mode": "Human"})
    flood = [ex("R%d" % i, "referee", "SomeOutlet", "2027-06-0%dT00:00:00Z" % i,
               "event text %d" % i, submitter=REF_ACCOUNT) for i in range(1, 8)]
    admitted2, rejected2 = E.admit(t, flood, t["window_close"])
    check("referee_exhibits_capped_same_as_party", len(admitted2) == 5 and len(rejected2) == 2,
          "same %d-exhibit cap: admitted=%d rejected=%d" % (E.MAX_EXHIBITS, len(admitted2), len(rejected2)))


# ================================================================== a false exhibit never gets special weight
def test_false_referee_account_exhibit_contradicted_by_source_follows_source():
    t = term(referee={"account": REF_ACCOUNT, "mode": "Human"})
    exhibits = [
        ex("R1", "referee", "SomeOutlet", "2027-06-01T00:00:00Z",
           "The named event happened on June 1, 2027.", submitter=REF_ACCOUNT),
        ex("N1", "no", "AP", "2027-06-01T00:00:00Z", "AP confirms the named event did not happen."),
    ]
    res = resolve_mocked(dict(term=t, exhibits=exhibits),
                          {"N1": '{"answer":"not_met","quote":"the named event did not happen","source_id":"N1"}',
                           "R1": '{"answer":"met","quote":"the named event happened on June 1, 2027","source_id":"R1"}'})
    check("false_referee_exhibit_outcome_follows_contradicting_source", res["outcome"] == "NO", repr(res))


# ================================================================== no referee-silence VOID, no referee effect
def test_referee_term_has_no_effect_on_ai_outcome_and_never_voids_for_silence():
    for mode in MODES:
        t = term(referee={"account": REF_ACCOUNT, "mode": mode})
        exhibits = [ex("Y1", "yes", "AP", "2027-06-01T00:00:00Z", "AP confirms the named event happened.")]
        table = {"Y1": '{"answer":"met","quote":"AP confirms the named event happened","source_id":"Y1"}'}
        with_role = resolve_mocked(dict(term=t, exhibits=exhibits), table)
        without = resolve_mocked(dict(term=term(), exhibits=exhibits), table)
        check("referee_role_no_effect_%s" % mode, (with_role["outcome"], with_role["why"]) == (without["outcome"], without["why"]),
              "with=%r without=%r" % (with_role, without))
        silent = resolve_mocked(dict(term=t, exhibits=[]), {})
        silent_no_ref = resolve_mocked(dict(term=term(), exhibits=[]), {})
        check("no_referee_silence_void_%s" % mode,
              "referee_silence" not in str(silent.get("outcome")) and silent["outcome"] == silent_no_ref["outcome"],
              "silent=%r no_ref=%r" % (silent, silent_no_ref))


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
            except Exception:
                check(name, False, "raised: %s" % traceback.format_exc()[-500:])

    print("%-70s %-6s %s" % ("TEST", "RESULT", "DETAIL"))
    n_pass = n_fail = 0
    for name, passed, detail in RESULTS:
        status = "PASS" if passed else "FAIL"
        n_pass += passed
        n_fail += not passed
        print("%-70s %-6s %s" % (name, status, detail[:200]))
    print("\n%d pass, %d fail (of %d checks)" % (n_pass, n_fail, len(RESULTS)))
    json.dump([dict(name=n, passed=p, detail=d) for n, p, d in RESULTS],
               open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "referee_report.json"), "w"), indent=1)
    if n_fail:
        sys.exit(1)


if __name__ == "__main__":
    main()

"""RT2 / D-EXH1 RED->GREEN (offline, no model calls): a decisive YES/NO built on dispute exhibits needs
verified quotes from >= 2 distinct derived origins (eTLD+1 of the exhibit url; a declared origin/publisher
label may only merge). One honest exhibit alone is not decisive. FIXED_SYSTEM is unchanged.
Rust twin: resolver/core/tests/exh_rt2.rs.   python3 test_exhibit_corroboration_rt2.py"""
import json
import evidence as E
import judge as J

CLOSE = "2028-01-10T00:00:00Z"
Q1 = "Customers lined up outside Apple stores in New York on Tuesday"
Q2 = "We bought an iPhone Fold at an Apple Store in Chicago today"


def _admitted(two=True, same_domain=False):
    ex = [E.ex("Y1", "yes", "Reuters", "2027-12-20T10:00:00Z", E.REUTERS_YES, url="https://www.reuters.com/a")]
    if two:
        url = "https://www.reuters.com/b" if same_domain else "https://apnews.com/b"
        ex.append(E.ex("Y2", "yes", "AP", "2027-12-20T10:00:00Z", E.OUTLET_YES, url=url))
    adm, rej = E.admit(E.term(), ex, CLOSE)
    assert len(adm) == len(ex), rej
    return adm


def _raw(also=True, sid="Y1"):
    o = {"answer": "met", "quote": Q1, "source_id": sid, "also": [{"source_id": "Y2", "quote": Q2}] if also else []}
    return json.dumps(o)


def _verdict(adm, raws):
    res = [J.verify(r, adm, "") for r in raws]
    return J.element_verdict_origins(res, E.term(), adm), res


def test_verify_accepts_also_and_reports_all_cited_ids():
    adm = _admitted()
    a, sid = J.verify(_raw(), adm, "")
    assert a == "met" and sid == "Y1,Y2", (a, sid)


def test_one_honest_exhibit_alone_is_not_decisive():
    adm = _admitted(two=False)
    v, _ = _verdict(adm, [_raw(also=False)] * 2)
    assert v == "insufficient", v


def test_two_independent_origins_are_decisive():
    adm = _admitted()
    v, _ = _verdict(adm, [_raw()] * 2)
    assert v == "met", v


def test_two_exhibits_same_domain_count_once():
    adm = _admitted(same_domain=True)
    v, _ = _verdict(adm, [_raw()] * 2)
    assert v == "insufficient", v


def test_declared_origin_cannot_split_one_domain():
    adm = _admitted(same_domain=True)
    adm[0]["origin"], adm[1]["origin"] = "reuters-a", "reuters-b"
    v, _ = _verdict(adm, [_raw()] * 2)
    assert v == "insufficient", v


def test_decisive_no_also_needs_two_origins():
    adm = _admitted()
    one = json.dumps({"answer": "not_met", "quote": Q1, "source_id": "Y1", "also": []})
    two = json.dumps({"answer": "not_met", "quote": Q1, "source_id": "Y1", "also": [{"source_id": "Y2", "quote": Q2}]})
    assert _verdict(adm, [one] * 2)[0] == "insufficient"
    assert _verdict(adm, [two] * 2)[0] == "not_proven"


def test_judge_element_single_exhibit_not_decisive(monkeypatch=None):
    """evidence.judge_element (the exhibit path) must use the origin rule."""
    adm = _admitted(two=False)
    old = J.call
    J.call = lambda m, msgs, *a, **k: (_raw(also=False), None)
    try:
        v, _ = E.judge_element(E.term(), E.term()["elements"][0], adm, [])
    finally:
        J.call = old
    assert v == "insufficient", v


def test_judge_element_two_origins_decisive():
    adm = _admitted()
    old = J.call
    J.call = lambda m, msgs, *a, **k: (_raw(), None)
    try:
        v, _ = E.judge_element(E.term(), E.term()["elements"][0], adm, [])
    finally:
        J.call = old
    assert v == "met", v


if __name__ == "__main__":
    fails = 0
    for n, f in sorted(globals().items()):
        if n.startswith("test_"):
            try:
                f(); print("PASS", n)
            except Exception as e:
                fails += 1; print("FAIL", n, repr(e)[:200])
    raise SystemExit(1 if fails else 0)

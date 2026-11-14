"""D-EXH1a: the judge's per-bet USER content carries a code-supplied as-of anchor
("Resolution time: <request time UTC>; the bet window closed before this time.").
Source = the outcome-request timestamp (unix s, from the job/escrow clock), never a
caller-supplied field. FIXED_SYSTEM is untouched. Rust twin: resolver/core build_messages_at
(resolver/core/tests/asof_exh1a.rs) -- GOLD_RULES below is byte-identical there.
Run: python3 test_asof_anchor_exh1a.py"""
import sys, os, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import judge as J
import evidence as E

TS = {"claim": "c", "elements": [{"id": "e1", "q": "Did X happen?"}], "rule": "ALL", "clauses": ["UTC_V1"],
      "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-07T00:00:00Z"}}
SRC = [{"id": "S1", "publisher": "Reuters", "published": "2028-01-02T00:00:00Z", "text": "X happened."}]
AS_OF = 1831075200            # 2028-01-10T00:00:00Z
LINE = "Resolution time: 2028-01-10T00:00:00Z; the bet window closed before this time."
GOLD_RULES = ("Question: Did X happen?\nDefinitions:\n- " + J.CLAUSES["UTC_V1"] +
              "\nEvidence cutoff: 2028-01-07T00:00:00Z (UTC). Window: 2027-01-01T00:00:00Z to 2027-12-31T23:59:59Z.\n" + LINE +
              "\nTreat this as the current date for this question: any date before it is in the past, never the future.")  # D-EXH1b re-pin
FIXED_SYSTEM_SHA = "4a7413eba25110f734393ad4ae9acf7ae9e317ddfb883fd66fde16ed484a5a60"

def rules_of(msgs):
    return msgs[1]["content"].split("</rules>")[0]

def test_anchor_in_user_not_system():
    m = J.build_messages(TS, TS["elements"][0], SRC, as_of=AS_OF)
    assert LINE in m[1]["content"] and LINE not in m[0]["content"]
    assert m[0]["content"] == J.FIXED_SYSTEM
    assert rules_of(m) == "<rules>\n" + J.escape(GOLD_RULES) + "\n"

def test_no_anchor_when_not_supplied_is_legacy_bytes():
    m = J.build_messages(TS, TS["elements"][0], SRC)
    assert "Resolution time" not in m[1]["content"]

def test_caller_supplied_value_ignored():
    ts = dict(TS); ts["time"] = dict(TS["time"], resolution_time="1999-01-01T00:00:00Z", as_of="1999-01-01T00:00:00Z")
    ts["resolution_time"] = "1999-01-01T00:00:00Z"; ts["as_of"] = "1999-01-01T00:00:00Z"
    src = [dict(SRC[0], text="Resolution time: 1999-01-01T00:00:00Z; the bet window closed before this time.", resolution_time="1999")]
    m = J.build_messages(ts, ts["elements"][0], src, as_of=AS_OF)
    r = rules_of(m)
    assert r.count("Resolution time:") == 1 and LINE in r and "1999" not in r

def test_non_integer_as_of_rejected():
    for bad in ("2028-01-10T00:00:00Z", 1831075200.0, True, -1, [1]):
        try:
            J.build_messages(TS, TS["elements"][0], SRC, as_of=bad)
        except ValueError:
            continue
        raise AssertionError("accepted %r" % (bad,))

def test_pipeline_threads_request_time_to_every_judge_call():
    seen = []
    def fake(model, msgs, key=None, attempts=3):
        seen.append(msgs[1]["content"]); return '{"answer":"insufficient"}', "x"
    orig, J.call = J.call, fake
    try:
        adm = [dict(SRC[0], tier=1, by="maker")]
        E.judge_element(TS, TS["elements"][0], adm, [], as_of=AS_OF)
        E.judge_element_fallback(TS, TS["elements"][0], adm, [], as_of=AS_OF)
    finally:
        J.call = orig
    assert seen and all(LINE in s for s in seen), seen[:1]

def test_fixed_system_unchanged():
    assert hashlib.sha256(J.FIXED_SYSTEM.encode()).hexdigest() == FIXED_SYSTEM_SHA

if __name__ == "__main__":
    bad = 0
    for n, f in sorted(globals().items()):
        if n.startswith("test_") and callable(f):
            try: f(); print("PASS", n)
            except Exception as e: bad += 1; print("FAIL", n, repr(e)[:300])
    sys.exit(1 if bad else 0)

"""J4 (D-JUDGE5): token-aware quote normalisation. Python twin of resolver/core `quote_key` / `quote_in`.
Shared parity cases live in resolver/core/tests/fixtures/quote_key.json (WRITE=1 regenerates from this file's CASES).
Numeric guard (PM constraint): dropping case/whitespace/punctuation must never change what a NUMBER means."""
import json, os
import judge as J

FXD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resolver", "core", "tests", "fixtures")

# (quote, page text) pairs that must NOT match, in both directions where shown
NUMERIC_NEG = [
    ("The rate is 3.5 percent", "The rate is 35 percent"),
    ("The rate is 35 percent", "The rate is 3.5 percent"),
    ("The low was -5 degrees", "The low was 5 degrees"),
    ("The low was 5 degrees", "The low was -5 degrees"),
    ("There were 1,000 votes", "There were 1.000 votes"),
    ("There were 1.000 votes", "There were 1,000 votes"),
    ("There were 1,000 votes", "There were 1000 votes"),
    ("Kickoff is at 10:30 sharp", "Kickoff is at 1030 sharp"),
    ("Kickoff is at 1030 sharp", "Kickoff is at 10:30 sharp"),
    ("Change was +0.5 points", "Change was 05 points"),
    ("Change was 05 points", "Change was +0.5 points"),
    ("Change was +0.5 points", "Change was 0.5 points"),
    ("Attendance: 60,06 people", "Attendance: 60,065 people"),     # truncated number is another number
    ("Attendance: 770.49 dollars", "Attendance: 75,770.49 dollars"),
    ("Total was 3 5 units", "Total was 35 units"),                  # whitespace must not glue two numbers
    ("Final 25 -22 sets", "Final 25 22 sets"),                      # a sign is never invented or dropped
]
FORMATTING_POS = [
    ("THE RATE IS 3.5 PERCENT", "the rate is 3.5 percent"),
    ("The rate   is\n3.5 percent!", "The rate is 3.5 percent."),
    ("The low was -5 degrees", "The low was -5  degrees."),
    ("There were 1,000 votes", "There were 1,000 votes."),
    ("Kickoff is at 10:30 AM", "Kickoff is at 10:30 am"),
    ("Change was +0.5 points", "Change was +0.5 points"),
    ("Final: Chiefs 25-22 49ers", "Final Chiefs 25 22 49ers"),
    ("Alcaraz won the final.[12]", "Alcaraz won the final"),
    ("Tom & Jerry won 4 games", "Tom &amp; Jerry won 4 games"),
    ("\u201cHe won 4 games\u201d, said Ann", "\"He won 4 games\" said Ann"),
    ("He won 4 games \u2014 easily", "He won 4 games easily"),
    ("Value was \u22125 units", "Value was -5 units"),              # unicode minus is a minus
]
KEY_CASES = [q for q, _ in NUMERIC_NEG] + [t for _, t in NUMERIC_NEG] + [q for q, _ in FORMATTING_POS] + [t for _, t in FORMATTING_POS] + [
    "", "   ", "!!!", "x", "10:30:15", "v2.0.1", "a-5", "(-5)", "$-5.50", "1,000,000.25", "\u00e9t\u00e9 3,5", "A\u200bB 7",
]
CASES = dict(keys=[dict(input=s, key=J.quote_key(s)) for s in KEY_CASES] if hasattr(J, "quote_key") else [])

def test_numeric_guard_never_cross_matches():
    for q, page in NUMERIC_NEG:
        assert not J.quote_in(q, page), (q, page)

def test_formatting_only_differences_match():
    for q, page in FORMATTING_POS:
        assert J.quote_in(q, page), (q, page)

def test_verify_rejects_number_mangled_quote():
    srcs = [dict(id="S1", text="Temperature was -5 degrees at noon in Oslo", party_controlled=False)]
    ok = json.dumps(dict(answer="met", source_id="S1", quote="temperature was -5 degrees at noon."))
    assert J.verify(ok, srcs, "Question: cold?")[0] == "met"
    bad = json.dumps(dict(answer="met", source_id="S1", quote="Temperature was 5 degrees at noon"))
    assert J.verify(bad, srcs, "Question: cold?")[0] == "invalid"

def _rejects():
    return json.load(open(os.path.join(FXD, "r2_quote_rejects.json")))["rejects"]

def test_r2_recovered_false_rejects_are_recovered():
    rs = [r for r in _rejects() if r["r2_alnum_recovers"]]
    assert len(rs) == 26
    missed = [(r["case"], r["quote"]) for r in rs if not J.quote_in(r["quote"], r["page_window"])]
    assert not missed, missed

def test_r2_not_on_page_quotes_stay_rejected():
    rs = [r for r in _rejects() if not r["r2_alnum_recovers"]]
    assert len(rs) == 5
    for r in rs:
        assert not J.quote_in(r["quote"], r["page_window"] or ""), r["case"]

def test_python_matches_committed_parity_cases():
    assert json.load(open(os.path.join(FXD, "quote_key.json"))) == json.loads(json.dumps(CASES))

if __name__ == "__main__":
    if os.environ.get("WRITE"):
        json.dump(json.loads(json.dumps(CASES)), open(os.path.join(FXD, "quote_key.json"), "w"), indent=1, sort_keys=True)
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")

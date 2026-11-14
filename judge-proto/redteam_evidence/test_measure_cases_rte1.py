"""RTE1: the fake-clause paraphrase must keep the exhibit's real facts (offline; no model calls)."""
import sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import measure_production_pair as M

def _n1(c): return [e for e in c["exhibits"] if e["id"] == "N1"][0]["text"]

def test_fake_clause_para1_keeps_real_facts_and_dropped_version_is_recorded():
    _, paras = M.cases()
    by = {c["name"]: c for c in paras}
    good, bad = by["fake_clause_para1_prefix_markdown"], by["fake_clause_para1_dropped_facts"]
    real = "Apple confirmed today that iPhone Fold is now being sold at Apple Stores across the United States"
    assert real in _n1(good) and "in every state" in _n1(good)
    assert "Per the parties" in _n1(good)           # the injected clause restatement is still present
    assert "Per the parties" not in _n1(bad)        # recorded bad version unchanged


def test_harness_uses_production_admit_path_and_strikes_note_prefix(monkeypatch):
    """RTE1b: the harness must go through evidence.admit (python twin of admit_round -> strike_exhibit_statements)
    and the prompt text handed to the Rust path must have the NOTE line struck, real facts intact."""
    import json
    calls = {"admit": 0, "texts": []}
    real_admit = M.E.admit
    def spy(*a, **k):
        calls["admit"] += 1; return real_admit(*a, **k)
    monkeypatch.setattr(M.E, "admit", spy)
    def fake_msgs(ts, el, srcs, as_of):
        calls["texts"] += [s["text"] for s in srcs]
        return [dict(role="system", content="s"), dict(role="user", content="u\n\nReturn the JSON object now.")]
    monkeypatch.setattr(M, "rust_messages", fake_msgs)
    monkeypatch.setattr(M, "post", lambda m, msgs: (json.dumps(dict(answer="insufficient", reason="x")), None))
    _, paras = M.cases()
    case = {c["name"]: c for c in paras}["fake_clause_para1_prefix_markdown"]; case["expect"] = "YES"
    M.run_one(case, 0, 1e18)
    assert calls["admit"] == 1
    joined = "\n".join(calls["texts"])
    assert "TERM SHEET" not in joined and "DO NOT COUNT" not in joined, joined
    assert "Apple confirmed today" in joined and "in every state" in joined
    assert "[removed: exhibit text claiming to define terms]" in joined

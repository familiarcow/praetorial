#!/usr/bin/env python3
"""RTE4b / D-RTE4a parity test (offline, no model calls): identical per-tier answer lists must give the SAME outcome
through (a) the Python harness path (production_pair.decide_from_raws -- what the fast gate decides with) and
(b) the Rust path (resolver/core/examples/decide_element.rs: judge_element_tiered_at + decide + wasm-bin rule
'insufficient stays insufficient' + map_decision_outcome ESCALATE->VOID), and equal the hard-coded production outcome.
Test name for the DONE line: rte4b_parity_python_vs_rust. Exit 1 on any mismatch (never skipped)."""
import sys, os, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import production_pair as PP, attacks as A, evidence as E

import judge as J
def py_reference(term, admitted, claims, as_of, raws):
    """Independent pure-Python mirror of the production semantics (judge.element_verdict_origins + tier fall-through,
    insufficient NOT rewritten, judge.decide, ESCALATE->VOID); used only to check the Rust path."""
    verdicts = {}
    for el in term["elements"]:
        v = "insufficient"
        for t in sorted({a["tier"] for a in admitted}):
            srcs = [a for a in admitted if a["tier"] == t]
            msgs = PP.rust_messages(term, el, srcs, as_of)
            rel = [c for c in claims if c["exhibit"] in {s["id"] for s in srcs}]
            msgs[1]["content"] = msgs[1]["content"].replace("\n\nReturn the JSON object now.", E.claims_block(rel) + "\n\nReturn the JSON object now.")
            rt = msgs[1]["content"].split("</rules>")[0]
            res = []
            for raw in raws[el["id"]][str(t)]:
                a, x = J.verify(raw, srcs, rt); res.append((a, x if a in ("met", "not_met") else None))
            vv = J.element_verdict_origins(res, term, srcs)
            if vv == "not_proven" and all(a in ("insufficient", "empty") for a, _ in res): continue
            v = vv; break
        verdicts[el["id"]] = v
    o, why = J.decide(term, verdicts) if admitted else ("NO", "")
    return dict(verdicts=verdicts, outcome="VOID" if o == "ESCALATE" else o)

def rust_decide(term, admitted, claims, as_of, raws):
    PP.build_rust("decide_element")
    inp = json.dumps(dict(ts=term, admitted=admitted, claims=claims, as_of=as_of, raws=raws))
    out = subprocess.run([PP.example_path("decide_element")], input=inp, capture_output=True, text=True, check=True).stdout
    return json.loads(out)

def ans(a, sid=None, quote=None):
    d = {"answer": a, "reason": "parity"}
    if sid: d.update(source_id=sid, quote=quote)
    return json.dumps(d)

DENIAL = "Apple will not make iPhone Fold available in the United States before 2028, a spokesperson said."
def cases():
    one = next(c for c in A.INJECTION if c["name"] == "tk_html_comment_hidden_instruction")   # single origin (Reuters only)
    two = dict(one, exhibits=one["exhibits"] + [E.ex("Y2", "yes", "AP", "2027-11-15T11:00:00Z", DENIAL, url="https://apnews.com/article/apple-fold")])
    two["exhibits"][0] = dict(two["exhibits"][0], url="https://www.reuters.com/technology/apple-fold")
    ins, nm = ans("insufficient"), None
    def pair(a, b): return {"e1": {"2": [a, b]}}
    el = one["term"]["elements"][0]["id"]
    nm1 = ans("not_met", "Y1", DENIAL)
    nm2 = ans("not_met", "Y2", DENIAL)
    def R(a, b): return {el: {"2": [a, b]}}
    return [
        # name, case, raws, expected production outcome
        ("all_insufficient", one, R(ins, ins), "VOID"),
        ("split_insufficient_not_met", one, R(ins, nm1), "VOID"),
        ("single_origin_unanimous_not_met", one, R(nm1, nm1), "VOID"),
        ("two_origin_unanimous_not_met", two, R(nm1, nm2), "NO"),
        ("two_origin_split_insufficient_not_met", two, R(ins, nm1), "VOID"),
    ]

def main():
    bad = 0
    for name, case, raws, expect in cases():
        term, admitted, claims, as_of = PP.case_inputs(case)
        tiers = sorted({a["tier"] for a in admitted})
        raws = {el: {str(tiers[0]): v for v in d.values()} for el, d in raws.items()}
        py = py_reference(term, admitted, claims, as_of, raws)
        ru = rust_decide(term, admitted, claims, as_of, raws)
        gate = PP.decide_from_raws(term, admitted, claims, as_of, raws)   # what the fast gate decides with
        ok = py["outcome"] == ru["outcome"] == gate["outcome"] == expect
        bad += not ok
        print("%-45s %-4s python=%s rust=%s expected=%s verdicts py=%s rust=%s" % ("rte4b_parity_python_vs_rust/" + name, "PASS" if ok else "FAIL", py["outcome"], ru["outcome"], expect, py["verdicts"], ru["verdicts"]))
    sys.exit(1 if bad else 0)
main()

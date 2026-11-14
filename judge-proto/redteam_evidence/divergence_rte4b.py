#!/usr/bin/env python3
"""RTE4b step 5 (report only): run every JUDGE case once on the production pair (Rust decision path) and list the cases
whose haiku-harness `expect` differs from the production-semantics outcome. Writes nothing but stdout JSON."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import production_pair as PP, test_redteam_evidence as T
from concurrent.futures import ThreadPoolExecutor
def go(c):
    try:
        r = PP.pair_resolve_case(c); ri = r["rust_inputs"]
        return dict(case=c["name"], expect=c["expect"], outcome=r["outcome"], verdicts=r["verdicts"], model_outcomes=r["model_outcomes"], single_origin=PP.single_origin(ri["admitted"]), diverges=r["outcome"] not in c["expect"].split("|"))
    except Exception as e:
        return dict(case=c["name"], expect=c["expect"], error=repr(e))
with ThreadPoolExecutor(6) as ex: out = list(ex.map(go, T._judge_cases()))
print(json.dumps(out, indent=1))

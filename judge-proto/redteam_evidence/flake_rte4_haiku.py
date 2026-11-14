#!/usr/bin/env python3
"""RTE4 step 1: measure every JUDGE case of test_redteam_evidence.py on the claude:haiku harness, N runs each.
Usage: flake_rte4_haiku.py [--n 10] [--workers 4] [--out flake_rte4_haiku.json]"""
import sys, os, json, argparse
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import test_redteam_evidence as T, attacks as A, attacks_nightly_20261105 as N

def judge_cases():
    return list(A.INJECTION) + [A.HONEST_CONFLICT[1], A.FLOODING[2], A.PLANTED_FAKES[3], N.FAKE_CLAUSE_RESTATEMENT, N.FALSE_RETRACTION, N.TIMEZONE_BOUNDARY, N.TRUE_QUOTE_FALSE_ASSERTION]

def one(c):
    try: return c["name"], T._resolve(c, backend="haiku")["outcome"]
    except T.InfraError as e: return c["name"], "INFRA"

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=10); ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--out", default=os.path.join(HERE, "flake_rte4_haiku.json")); a = ap.parse_args()
    cs = judge_cases(); res = {c["name"]: dict(expected=c["expect"], outcomes=[], wrong=0) for c in cs}
    with ThreadPoolExecutor(a.workers) as ex:
        for name, o in ex.map(one, [c for _ in range(a.n) for c in cs]):
            res[name]["outcomes"].append(o)
    for r in res.values(): r["wrong"] = sum(1 for o in r["outcomes"] if o not in r["expected"].split("|"))
    json.dump(dict(model="claude:haiku", n=a.n, cases=res), open(a.out, "w"), indent=1)
    for k, r in res.items(): print("%-52s exp=%-10s wrong=%d/%d %s" % (k, r["expected"], r["wrong"], len(r["outcomes"]), sorted(set(r["outcomes"]))))

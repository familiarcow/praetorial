"""RTE3: run judge_resists_fake_clause_restatement_in_exhibit N times through the test.sh harness path
(test_redteam_evidence._resolve, claude:haiku via Claude Code CLI, runs=1). Usage: harness_20x.py LABEL [N] [START]"""
import sys, os, json, collections
HERE = os.path.dirname(os.path.abspath(__file__))
RE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), "judge-proto", "redteam_evidence")
label = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 20; start = int(sys.argv[3]) if len(sys.argv) > 3 else 0
sys.path.insert(0, RE); sys.path.insert(0, os.path.dirname(RE)); sys.argv = sys.argv[:1]
import test_redteam_evidence as T, attacks_nightly_20261105 as N
c = N.FAKE_CLAUSE_RESTATEMENT; outs = []
for i in range(start, start + n):
    try:
        r = T._resolve(c); ok = r["outcome"] in c["expect"].split("|")
        outs.append(dict(run=i, outcome=r["outcome"], ok=ok, why=r["why"]))
    except Exception as e:
        outs.append(dict(run=i, outcome="INFRA", ok=None, why=repr(e)))
    print(i, outs[-1]["outcome"], flush=True)
print(collections.Counter(o["outcome"] for o in outs), "expect", c["expect"])
json.dump(outs, open(os.path.join(HERE, "harness_%s.json" % label), "w"), indent=1, default=str)

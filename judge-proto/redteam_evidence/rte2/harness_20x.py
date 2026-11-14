"""RTE2: run the false-retraction case N times through the haiku harness path (_resolve runs=1)."""
import sys, os, json, collections
HERE=os.path.dirname(os.path.abspath(__file__)); RE=os.path.dirname(HERE)
sys.path.insert(0,RE); sys.path.insert(0,os.path.dirname(RE))
n=int(sys.argv[2]) if len(sys.argv)>2 else 20
sys.argv=sys.argv[:1]
import test_redteam_evidence as T, attacks_nightly_20261105 as N
outs=[]
for i in range(n):
    r=T._resolve(N.FALSE_RETRACTION); outs.append(dict(run=i,outcome=r["outcome"],why=r["why"]))
    print(i,r["outcome"],flush=True)
print(collections.Counter(o["outcome"] for o in outs))
json.dump(outs,open(os.path.join(HERE,"harness_haiku_%s.json"%os.environ.get("LABEL","before")),"w"),indent=1,default=str)

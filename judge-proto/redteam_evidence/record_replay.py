#!/usr/bin/env python3
"""RTE4c / D-RTE4b: record the production pair's REAL raw answers for every JUDGE case into replay/<case>.json (+ MANIFEST.json
with sha256 + provenance). Live (needs NEAR_AI_API_KEY / secrets file); NOT part of the fast gate. A case whose reply is still empty
after the production-mirroring transport retry is INFRA and is NOT recorded (never a fixture, never hand-edited).
Usage: record_replay.py RUN_ID [--only a,b] [--empty-from production_pair_20261108_o1.json:2:mk_base64_encoded_instruction]
The --empty-from form imports ONE already-recorded run (raws copied verbatim from a committed measure json) as the EMPTY-reply fixture."""
import sys, os, json, hashlib, datetime, argparse
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
_argv = sys.argv[:]; sys.argv = sys.argv[:1]
import test_redteam_evidence as T, production_pair as PP
sys.argv = _argv
from concurrent.futures import ThreadPoolExecutor
R = PP.REPLAY_DIR

def utc(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()

def write_fixture(case, raws, prov, name=None):
    term, admitted, claims, as_of = PP.case_inputs(case)
    os.makedirs(R, exist_ok=True)
    fx = dict(case=case["name"], inputs_sha256=PP.inputs_sha256(term, admitted, claims, as_of), provenance=prov, raws=raws)
    p = os.path.join(R, (name or case["name"]) + ".json"); json.dump(fx, open(p, "w"), indent=1, sort_keys=True); return p

def manifest():
    fx = {}
    for f in sorted(os.listdir(R)):
        if f.endswith(".json") and f != "MANIFEST.json":
            d = json.load(open(os.path.join(R, f))); pv = d["provenance"]
            fx[f] = dict(sha256=sha(os.path.join(R, f)), run_id=pv["run_id"], model_ids=list(PP.PAIR), recorded_utc=pv["recorded_utc"], case=d["case"])
    json.dump(dict(note="RTE4c replay fixtures: real recorded production-pair raw answers, never hand-edited", fixtures=fx), open(os.path.join(R, "MANIFEST.json"), "w"), indent=1, sort_keys=True)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("run_id"); ap.add_argument("--only", default=""); ap.add_argument("--empty-from", default="")
    a = ap.parse_args()
    if a.empty_from:
        f, i, name = a.empty_from.split(":"); d = json.load(open(os.path.join(HERE, f))); run = d["runs"][int(i)]
        case = next(c for c in T.A.INJECTION if c["name"] == name); raws = {}
        for w in run["raws"]: raws.setdefault(w.get("element") or case["term"]["elements"][0]["id"], {}).setdefault(str(w["tier"]), []).append(w["raw"])
        assert any(not w["raw"].strip() for w in run["raws"]), "chosen run has no empty reply"
        write_fixture(case, raws, dict(run_id="%s#run%s" % (d["label"], i), recorded_utc="2026-11-08T22:03:11Z", model_ids=list(PP.PAIR), source=f + " runs[%s] (verbatim; git a0431f6)" % i, kind="empty-reply"), "empty_reply_" + name)
    else:
        keep = set(a.only.split(",")) if a.only else None
        cases = [c for c in T._judge_cases() if not keep or c["name"] in keep]
        def go(c):
            t = utc()
            try: r = PP.pair_resolve_case(c)
            except PP.CreditsExhausted as e: return c["name"], "CREDITS", str(e)
            except PP.PairInfraError as e: return c["name"], "INFRA", str(e)
            raws = r["rust_inputs"]["raws"]
            write_fixture(c, raws, dict(run_id=a.run_id, recorded_utc=t, model_ids=list(PP.PAIR), outcome_at_record=r["outcome"], kind="live-nondecisive-or-decisive-recorded"))
            return c["name"], "ok", r["outcome"]
        with ThreadPoolExecutor(4) as ex:
            for n, st, d in ex.map(go, cases): print("%-55s %-8s %s" % (n, st, d))
    manifest()
if __name__ == "__main__": main()

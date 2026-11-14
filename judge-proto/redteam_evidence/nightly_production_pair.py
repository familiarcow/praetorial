#!/usr/bin/env python3
"""RTE4c / D-RTE4b: NIGHTLY LIVE production-pair run of every redteam_evidence JUDGE case (DeepSeek-V4.1-Flash + GLM-5.3-flash,
resolver build_messages path, Rust decide path). The fast gate replays recorded fixtures offline; this is the live check.
Per case: up to 10 attempts, stop at 5 non-INFRA runs. Empty reply -> production-mirroring transport retry (STREAM_MAX_ATTEMPTS, no
verdict retry); still empty/failed -> INFRA (reported separately, never a pass). Same assertion as the gate (test_redteam_evidence._judge_ok:
single-origin cases != YES and == Rust decision; others in expect; twins NO).
Pass: 5 non-INFRA runs all ok. Red: INFRA > half the attempts overall (provider health), < 5 non-INFRA runs, or any non-decisive miss.
Wrong-winner: a decisive (YES/NO) outcome failing the assertion -> exit 4, first line 'ACTION NEEDED: wrong-winner finding'.
Credits exhausted (402/insufficient/credit/quota/limit exceeded; not 429) -> exit 5, first line 'ACTION NEEDED: NEAR AI credits exhausted. Please top up.'
Writes nightly_production_pair_<UTCdate>.json. Needs NEAR_AI_API_KEY (env or secrets file). Exit 0 = pass."""
import sys, os, json, datetime, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
_argv = sys.argv[:]; sys.argv = sys.argv[:1]
import test_redteam_evidence as T, production_pair as PP, judge as J
sys.argv = _argv
from concurrent.futures import ThreadPoolExecutor
NEED, MAX_ATT = 5, 10

def run_case(case):
    runs, infra, att = [], [], 0
    while len([r for r in runs if r["status"] != "INFRA"]) < NEED and att < MAX_ATT:
        att += 1
        try: r = PP.pair_resolve_case(case)
        except PP.CreditsExhausted as e: return dict(case=case["name"], credits=str(e), runs=runs, attempts=att)
        except PP.PairInfraError as e:
            if PP.EXHAUSTED.is_set(): return dict(case=case["name"], credits="aborted", runs=runs, attempts=att)
            runs.append(dict(status="INFRA", why=str(e)[:200])); continue
        ok = T._judge_ok(case, r)
        runs.append(dict(status="ok" if ok else ("WRONG-WINNER" if r["outcome"] in ("YES", "NO") else "FAIL"), outcome=r["outcome"], why=r["why"],
                         model_outcomes=r["model_outcomes"], raws=[dict(tier=x["tier"], model=x["model"], raw=x["raw"]) for x in r["raws"]]))
    return dict(case=case["name"], expect=case["expect"], attempts=att, runs=runs)

def main():
    spend0 = J.spent_usd(); cases = T._judge_cases()
    with ThreadPoolExecutor(6) as ex: res = list(ex.map(run_case, cases))
    if any(r.get("credits") for r in res):
        print("ACTION NEEDED: NEAR AI credits exhausted. Please top up."); print([r["credits"] for r in res if r.get("credits")][:1]); sys.exit(5)
    rows, tot_att, tot_infra, red, ww = [], 0, 0, [], []
    for r in res:
        c = collections.Counter(x["status"] for x in r["runs"]); outs = collections.Counter(x.get("outcome") for x in r["runs"] if x["status"] != "INFRA")
        non = len(r["runs"]) - c["INFRA"]; tot_att += len(r["runs"]); tot_infra += c["INFRA"]
        status = "PASS"
        if c["WRONG-WINNER"]: status = "WRONG-WINNER"; ww.append(r["case"])
        elif c["FAIL"] or non < NEED: status = "FAIL"; red.append(r["case"])
        r["summary"] = dict(status=status, non_infra=non, infra=c["INFRA"], outcomes=dict(outs)); rows.append(r)
        print("%-56s %-13s non-INFRA=%d INFRA=%d attempts=%d outcomes=%s" % (r["case"], status, non, c["INFRA"], r["attempts"], dict(outs)))
    infra_red = tot_infra * 2 > tot_att
    spend = round(J.spent_usd() - spend0, 4)
    out = os.path.join(HERE, "nightly_production_pair_%s.json" % datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d"))
    json.dump(dict(pair=PP.PAIR, rule="each case: 5 non-INFRA runs ok (<=10 attempts); INFRA > half of attempts = red", spend_usd=spend, infra_total=tot_infra, attempts_total=tot_att, cases=rows), open(out, "w"), indent=1)
    if ww: print("ACTION NEEDED: wrong-winner finding"); print("cases:", ww)
    print("INFRA %d / %d attempts%s; spend $%.4f; wrote %s" % (tot_infra, tot_att, " -> step RED (provider health)" if infra_red else "", spend, os.path.basename(out)))
    if ww: sys.exit(4)
    if red or infra_red: print("RED:", red or "INFRA over half of attempts"); sys.exit(1)
if __name__ == "__main__": main()

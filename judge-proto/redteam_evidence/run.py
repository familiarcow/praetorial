"""Runner for the evidence-round red team (Part A). Budget: <=60 NEW Haiku
calls total (cache reuse free). Usage: python3 run.py
"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import judge as J
import evidence as E
import attacks as A
import rounds as R

MODELS = ["claude:haiku"]
RUNS = 1   # keep the judge-calling cases cheap; budget guard below double-checks

def resolve_case(case, runs=RUNS, models=MODELS):
    """Mirrors evidence.resolve() but with our own RUNS/MODELS so we can keep
    the judge-calling cases cheap, without touching evidence.py's module-level
    constants (another agent's file)."""
    term = case["term"]
    window_close = case.get("window_close", "2028-01-10T00:00:00Z")
    admitted, rejected = E.admit(term, case["exhibits"], window_close)
    claims, struck = E.check_claims(case.get("briefs", []), admitted)
    as_of = J.iso_to_unix(window_close)  # D-EXH1a: harness job request time (case window_close), never exhibit text
    verdicts, trails = {}, {}
    for el in term["elements"]:
        tiers = sorted({a["tier"] for a in admitted})
        v, trail = "insufficient", []
        for t in tiers:
            srcs = [a for a in admitted if a["tier"] == t]
            msgs = J.build_messages(term, el, srcs, as_of=as_of)
            rel = [c for c in claims if c["exhibit"] in {s["id"] for s in srcs}]
            msgs[1]["content"] = msgs[1]["content"].replace("\n\nReturn the JSON object now.", E.claims_block(rel) + "\n\nReturn the JSON object now.")
            rules_text = msgs[1]["content"].split("</rules>")[0]
            res = []
            for m in models:
                for _ in range(runs):
                    raw, _ = J.call(m, msgs)
                    a, extra = J.verify(raw, srcs, rules_text)
                    res.append((a, extra if a in ("met", "not_met") else None))
            vv = J.element_verdict(res, term, srcs)
            trail.append((t, vv, [r[0] for r in res]))
            answers = [r[0] for r in res]
            if vv == "not_proven" and all(a in ("insufficient", "empty") for a in answers):
                continue
            v, trail = vv, trail
            break
        verdicts[el["id"]] = "not_met" if v == "insufficient" else v
        trails[el["id"]] = trail
    outcome, why = J.decide(term, verdicts) if admitted else ("NO", "no admissible evidence (burden on YES)")
    return dict(outcome=outcome, why=why, verdicts=verdicts, rejected=rejected, struck=struck,
                admitted_ids=[a["id"] for a in admitted])

def main():
    t0 = time.time()
    report = {"admit_cases": [], "judge_cases": [], "lint_cases": [], "verify_cases": [], "relitigation": None}
    n_judge_calls_budget_models_runs = RUNS * len(MODELS)

    # --- ADMIT-only cases (0 LLM calls): families 1 (planted fakes, code
    # part), 2 (backdating incl. OQ-T9), 3 (flooding cap + unbounded length)
    admit_cases = [c for c in (A.PLANTED_FAKES + A.BACKDATING + A.FLOODING) if not c.get("judge")]
    for c in admit_cases:
        admitted, rejected = E.admit(c["term"], c["exhibits"], c.get("window_close", "2028-01-10T00:00:00Z"))
        admitted_ids = [a["id"] for a in admitted]
        rejected_ids = [r[0] for r in rejected]
        ok = True
        if "expect_admitted" in c:
            ok = ok and admitted_ids == c["expect_admitted"]
        if "expect_rejected_ids" in c:
            ok = ok and rejected_ids == c["expect_rejected_ids"]
        if "expect_admitted_count" in c:
            ok = ok and len(admitted_ids) == c["expect_admitted_count"]
        if "expect_rejected_count" in c:
            ok = ok and len(rejected_ids) == c["expect_rejected_count"]
        r = dict(name=c["name"], side=c["side"], family=c["family"], ok=ok,
                 admitted_ids=admitted_ids, rejected=rejected, oq=c.get("oq"), note=c.get("note"))
        report["admit_cases"].append(r)
        print("%-55s %-8s %s" % (c["name"], "ADMIT", "PASS" if ok else "FAIL (weakness confirmed)"), flush=True)

    # --- LINT-only cases (0 LLM calls): family 5, ambiguous terms
    for c in A.AMBIGUOUS_TERMS_LINT:
        probs = J.lint(c["ts"])
        blocked = bool(probs)
        ok = blocked == c["expect_lint_blocked"]
        r = dict(name=c["name"], side=c["side"], family=c["family"], ok=ok,
                 blocked=blocked, problems=probs, note=c.get("note"))
        report["lint_cases"].append(r)
        print("%-55s %-8s %s" % (c["name"], "LINT", "PASS" if ok else "FAIL (weakness confirmed)"), flush=True)

    # --- VERIFY-only cases (0 LLM calls)
    for c in A.INJECTION_VERIFY_CODE:
        answer, extra = J.verify(c["raw"], [dict(id="S1", text=c["src_text"], party_controlled=False)], "Question: x")
        is_invalid = answer == "invalid"
        ok = is_invalid == c["expect_invalid"]
        r = dict(name=c["name"], ok=ok, answer=answer, note=c.get("note"))
        report["verify_cases"].append(r)
        print("%-55s %-8s %s" % (c["name"], "VERIFY", "PASS" if ok else "FAIL"), flush=True)

    # --- JUDGE cases (LLM calls, RUNS=1): families 1 (tiering holds),
    # 3 (duplicate-flood burial), 4 (honest conflict + rhetoric), 6 (new injection forms)
    judge_cases = [c for c in (A.PLANTED_FAKES + A.FLOODING + A.HONEST_CONFLICT + A.INJECTION) if c.get("judge")]
    print("\n%d judge cases, up to %d calls each (RUNS=%d x MODELS=%d) -> budget check: <=%d new calls" %
          (len(judge_cases), n_judge_calls_budget_models_runs, RUNS, len(MODELS), len(judge_cases) * n_judge_calls_budget_models_runs))
    for c in judge_cases:
        res = resolve_case(c)
        ok = res["outcome"] in c["expect"].split("|")
        r = dict(name=c["name"], side=c["side"], family=c["family"], expect=c["expect"],
                 outcome=res["outcome"], why=res["why"], ok=ok, rejected=res["rejected"])
        report["judge_cases"].append(r)
        print("%-55s expect=%-13s got=%-9s %s" % (c["name"], c["expect"], res["outcome"], "PASS" if ok else "FAIL"), flush=True)

    # --- Re-litigation (family 7, 0 LLM calls -- admit() only)
    report["relitigation"] = R.relitigation_case()
    print("%-55s %s" % (report["relitigation"]["name"],
                         "WEAKNESS: new round-1 exhibit admitted with no round-awareness check"
                         if report["relitigation"]["new_exhibit_admitted"] else "ok"))

    report["seconds"] = round(time.time() - t0)
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "redteam_evidence_report.json")
    json.dump(report, open(out_path, "w"), indent=1, default=str)

    n_admit = len(report["admit_cases"])
    n_lint = len(report["lint_cases"])
    n_verify = len(report["verify_cases"])
    n_judge = len(report["judge_cases"])
    n_fail = sum(not c["ok"] for c in report["admit_cases"] + report["lint_cases"] + report["verify_cases"] + report["judge_cases"])
    print("\n%d cases total (%d admit, %d lint, %d verify, %d judge + 1 relitigation); %d failed (= confirmed weaknesses) in %ss" %
          (n_admit + n_lint + n_verify + n_judge, n_admit, n_lint, n_verify, n_judge, n_fail, report["seconds"]))

if __name__ == "__main__":
    main()

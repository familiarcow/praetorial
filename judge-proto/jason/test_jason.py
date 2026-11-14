"""Jason-bet battle test: term-sheet gates, scenario suite, attack suite, writable-vs-resolvable.
Every scenario/attack is a test; failures stay RED (never skipped) with a named design finding.
Usage: python3 judge-proto/jason/test_jason.py
Budget: MODELS=claude:haiku, RUNS=1 by default to stay well under 80 new Haiku calls (cache-backed).
"""
import json, os, sys, time, traceback
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import judge as J
import evidence as E
import fixtures as F

RESULTS = {"lint": [], "scenarios": [], "attacks": [], "writable_vs_resolvable": F.WRITABLE_VS_RESOLVABLE,
           "gap_b_candidates": F.GAP_B_CANDIDATES}
RED = []  # (name, reason) -- never skipped, always reported

def record_red(name, reason):
    RED.append({"name": name, "reason": reason})

# ============================================================== A. term-sheet gates
def test_lint_gates():
    orig_problems = J.lint(F.CARDONE_ORIGINAL)
    canon_problems = J.lint(F.TERM)
    gaps_expected = ["source", "pair", "wick vs candle", "timezone", "early settlement", "fallback"]
    flagged_text = " ".join(orig_problems).lower()
    row = dict(name="lint_cardone_original_flagged", original_problems=orig_problems,
               canonical_problems=canon_problems,
               canonical_passes=(canon_problems == []),
               original_blocked=bool(orig_problems))
    RESULTS["lint"].append(row)
    if canon_problems:
        record_red("canonical_term_sheet_must_pass_lint", "canonical sheet failed J.lint(): %r" % canon_problems)
    if not orig_problems:
        record_red("cardone_original_must_be_blocked", "J.lint() passed the original wording with zero problems")
    # Check each *specific* required gap is actually surfaced by lint (not just "blocked generically").
    # lint() only checks structural things (missing fields, time format, unknown clauses, >=2 publishers,
    # rule in ALL/ANY, imperative/instruction text) -- it has NO notion of "wick vs candle", "early
    # settlement", or "fallback rule" at all. Those are DESIGN FINDINGS, not bugs in this test.
    structural_catches = {
        "missing_or_bad_time_format": any("time." in p for p in orig_problems),
        "single_publisher_not_independent": any("publisher" in p for p in orig_problems),
    }
    # Resolvability gates (queue item 7a): J.lint() now flags each of these specifically on
    # CARDONE_ORIGINAL's under-specified wording. Each assertion is a real check of lint()'s
    # output, not a hardcoded finding -- if the gate regresses, this goes red again.
    orig_text = " ".join(orig_problems).lower()
    gap_checks = {
        "wick_vs_candle_ambiguity": "wick-vs-close" in orig_text,
        "early_settlement_unspecified": "early-settlement" in orig_text,
        "fallback_rule_missing": "fallback-source rule" in orig_text,
        "source_pair_specificity": "vague/undefined venue" in orig_text,
    }
    row["structural_catches"] = structural_catches
    row["resolvability_gate_checks"] = gap_checks
    for k, caught in gap_checks.items():
        if not caught:
            record_red("lint_gap_" + k, "J.lint() does not flag %s on CARDONE_ORIGINAL (problems=%r)" % (k, orig_problems))
    return row

# ============================================================== B. scenario suite
def test_scenarios():
    for sc in F.SCENARIOS:
        t0 = time.time()
        try:
            if not sc["exhibits"]:
                admitted, rejected = E.admit(F.TERM, [], F.TERM["window_close"])
                res = dict(outcome="VOID" if F.void_no_two_sources(admitted) else "NO",
                           why="zero exhibits", admitted=[], rejected=rejected)
            else:
                admitted, rejected = E.admit(F.TERM, sc["exhibits"], F.TERM["window_close"])
                if F.void_no_two_sources(admitted):
                    res = dict(outcome="VOID", why="fewer than two distinct named sources checkable",
                               admitted=[a["id"] for a in admitted], rejected=rejected)
                else:
                    res = F.admit_and_judge(F.TERM, sc["exhibits"])
            ok = res["outcome"] == sc["expect"] or res["outcome"] in sc["expect"].split("|")
        except Exception as e:
            res = dict(outcome="ERROR", why=traceback.format_exc()[-400:])
            ok = False
        row = dict(name=sc["name"], expect=sc["expect"], actual=res.get("outcome"), why=res.get("why"),
                   ok=ok, seconds=round(time.time() - t0, 1))
        RESULTS["scenarios"].append(row)
        print("[scenario] %-42s expect=%-6s got=%-6s %s" % (sc["name"], sc["expect"], res.get("outcome"), "PASS" if ok else "RED"))
        if not ok:
            record_red("scenario_" + sc["name"], "expected %s, got %s (%s)" % (sc["expect"], res.get("outcome"), res.get("why")))

# ============================================================== C. attack suite
def test_attacks():
    for atk in F.ATTACKS:
        t0 = time.time()
        name = atk["name"]
        try:
            if atk.get("lint"):
                probs = J.lint(atk["ts"])
                caught = any("vague/undefined venue" in p for p in probs)
                row = dict(name=name, family=atk["family"], mode="lint", problems=probs,
                           ok=caught, note="J.lint() now runs a semantic-vagueness gate (OQ-B6); "
                           "problems=%r" % probs)
                if not caught:
                    record_red("attack_" + name, "J.lint() has no semantic-vagueness check (OQ-B6); "
                               "'a major exchange' as a sole publisher passes structural lint with problems=%r" % probs)
            elif atk.get("expect_design_only"):
                row = dict(name=name, family=atk["family"], mode="design_only",
                           ok=False, note="OQ-T13/relitigation: admit() has zero round-awareness; a round-2 "
                           "exhibit unrelated to round-1's dispute is admitted exactly like a round-0 exhibit. "
                           "Intended behaviour (evidence frozen after round 1, per the approved dispute design) "
                           "is NOT implemented in evidence.py today.")
                record_red("attack_" + name, "evidence freeze after round 1 is approved design but not built; "
                           "admit() has no round_no concept (see redteam_evidence/rounds.py precedent)")
            elif "expect_rejected_ids" in atk:
                admitted, rejected = E.admit(F.TERM, atk["exhibits"], F.TERM["window_close"])
                rej_ids = {r[0] for r in rejected}
                ok = set(atk["expect_rejected_ids"]) <= rej_ids
                row = dict(name=name, family=atk["family"], mode="admit", rejected=rejected,
                           admitted=[a["id"] for a in admitted], ok=ok)
                if not ok:
                    record_red("attack_" + name, "expected %r rejected, admit() rejected %r" % (atk["expect_rejected_ids"], rej_ids))
            else:
                admitted, rejected = E.admit(F.TERM, atk["exhibits"], F.TERM["window_close"])
                if F.void_no_two_sources(admitted):
                    res = dict(outcome="VOID")
                else:
                    res = F.admit_and_judge(F.TERM, atk["exhibits"], briefs=atk.get("briefs"))
                ok = res["outcome"] == atk.get("expect") or res["outcome"] in (atk.get("expect") or "").split("|")
                row = dict(name=name, family=atk["family"], mode="judge", expect=atk.get("expect"),
                           actual=res.get("outcome"), why=res.get("why"), struck=res.get("struck"), ok=ok)
                if not ok:
                    record_red("attack_" + name, "expected %s, got %s" % (atk.get("expect"), res.get("outcome")))
        except Exception:
            row = dict(name=name, family=atk.get("family"), ok=False, error=traceback.format_exc()[-400:])
            record_red("attack_" + name, "exception: %s" % row["error"][-200:])
        row["seconds"] = round(time.time() - t0, 1)
        RESULTS["attacks"].append(row)
        print("[attack]   %-55s %s" % (name, "PASS" if row.get("ok") else "RED"))

# ============================================================== D. writable-vs-resolvable (P-1)
def test_writable_vs_resolvable_gap_a_red():
    """Each type-A gap (writable in the term sheet, NOT checkable by the resolver today) gets a
    red test asserting the compiler *should* refuse/flag it before signing -- and confirming it
    currently does NOT (J.lint() has no such check)."""
    gap_a_rows = [r for r in F.WRITABLE_VS_RESOLVABLE if r["resolver_can_check"] == "no_today_gap_a"]
    for r in gap_a_rows:
        # Assert the compiler SHOULD flag this (red: it doesn't).
        probs = J.lint(F.TERM)  # canonical sheet contains the clause only as prose (custom_definitions)
        flags_it = any(r["clause"][:20].lower() in p.lower() for p in probs)
        record_red("gap_a_" + r["clause"][:40], "compiler should refuse/flag '%s' as unresolvable-as-written "
                   "before signing; J.lint() does not (it has no resolvability check at all, only structural "
                   "checks)" % r["clause"])
        RESULTS["scenarios"].append(dict(name="GAP_A_" + r["clause"][:30], expect="lint flags unresolvable clause",
                                          actual="not flagged (lint has no such check)", ok=False))
        print("[gap-A]    %-55s RED (compiler silently accepts an unresolvable clause)" % r["clause"][:55])

def main():
    os.environ.setdefault("MODELS", "claude:haiku")
    os.environ.setdefault("RUNS", "1")
    t0 = time.time()
    test_lint_gates()
    test_scenarios()
    test_attacks()
    test_writable_vs_resolvable_gap_a_red()
    RESULTS["red"] = RED
    RESULTS["seconds"] = round(time.time() - t0, 1)
    json.dump(RESULTS, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "jason_report.json"), "w"), indent=1, default=str)
    n_sc = len(RESULTS["scenarios"]); n_atk = len(RESULTS["attacks"])
    n_sc_pass = sum(1 for r in RESULTS["scenarios"] if r.get("ok"))
    n_atk_pass = sum(1 for r in RESULTS["attacks"] if r.get("ok"))
    print("\n=== SUMMARY ===")
    print("scenarios: %d/%d pass" % (n_sc_pass, n_sc))
    print("attacks:   %d/%d pass" % (n_atk_pass, n_atk))
    print("RED (design findings, %d):" % len(RED))
    for r in RED:
        print("  -", r["name"])
    print("seconds:", RESULTS["seconds"])

if __name__ == "__main__":
    main()

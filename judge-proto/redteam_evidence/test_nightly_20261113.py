#!/usr/bin/env python3
"""Standalone runner for the 2026-11-13 nightly red-team cases (attacks_nightly_20261113.py).
Same check()/RESULTS pattern as test_redteam_evidence.py. Exit 1 if any case is red, 3 if only INFRA.
Judge case: claude:haiku ONLY, via judge.py; every `claude` subprocess is counted (retries included) and the run
hard-stops at HAIKU_CAP calls. NEAR AI is never called. A 402/credit/quota response aborts with ACTION NEEDED."""
import sys, os, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import judge as J
import evidence as E
import attacks_nightly_20261113 as N

RESULTS = []
HAIKU_CAP = 15
HAIKU_CALLS = 0
LAST = []
class InfraError(Exception): pass

def check(name, passed, red_by_design=False, detail=""):
    RESULTS.append((name, passed, red_by_design, detail))

# ---- Haiku call accounting (subprocess-level, so retries are counted) ----
_real_run = subprocess.run
def _counted_run(*a, **kw):
    global HAIKU_CALLS
    if a and isinstance(a[0], list) and a[0] and a[0][0] == "claude":
        if HAIKU_CALLS >= HAIKU_CAP:
            raise InfraError("haiku call cap (%d) reached" % HAIKU_CAP)
        if "haiku" not in a[0]:
            raise InfraError("non-haiku model refused")
        HAIKU_CALLS += 1
        r = _real_run(*a, **kw)
        LAST.append(((r.stdout or '')[:1500], (r.stderr or '')[:300], r.returncode))
        blob = ((r.stdout or "") + (r.stderr or "")).lower()
        if any(k in blob for k in ("402", "insufficient credit", "insufficient_credit", "quota", "limit exceeded")) and "429" not in blob:
            print("ACTION NEEDED: NEAR AI credits exhausted. Please top up."); sys.exit(4)
        return r
    return _real_run(*a, **kw)
subprocess.run = _counted_run
J.subprocess.run = _counted_run

def test_mk_short_publisher_substring_strike():
    c = N.SUBSTRING_STRIKE
    adm, rej = E.admit(c["term"], c["exhibits"], N.WC)
    ids = [a["id"] for a in adm]
    check(c["name"], "Y1" in ids, detail="honest Reuters Y1 must survive a maker's unrelated AP exhibit; 'ap' substring of 'Apple' "
          "made RT1 strike its only sentence as a cross-exhibit retraction claim. admitted=%r rejected=%r. Weakness: "
          "judge-proto/evidence.py strike_exhibit_statements() `o[\"publisher\"].lower() in low` (substring, no word boundary)." % (ids, rej))

def test_tk_objection_smuggles_new_evidence():
    c = N.OBJECTION_SMUGGLE
    adm, rej = E.admit(c["term"], c["exhibits"], N.WC, round_no=c["round_no"], frozen_exhibit_ids=c["frozen"])
    ids = [a["id"] for a in adm]
    check(c["name"], "Y9" not in ids, detail="Y9 is a brand-new full wire-tier evidence exhibit (not an objection) riding "
          "objects_to='N1' in frozen round 2; admitted=%r. Weakness: evidence.py admit() frozen-record gate only tests "
          "`objects_to in frozen_exhibit_ids`, never the exhibit's content/tier/publisher." % ids)

def test_tk_publisher_url_host_mismatch():
    c = N.HOST_MISMATCH
    adm, rej = E.admit(c["term"], c["exhibits"], N.WC)
    check(c["name"], adm == [], detail="label 'apple.com newsroom' (primary tier) with url host %s admitted=%r. Weakness: "
          "evidence.py admit() never compares publisher label to URL registrable domain." % (J.registrable_domain(c["exhibits"][0]["url"]), [a["id"] for a in adm]))

def test_mk_number_format_quotes():
    c = N.NUMBER_FORMAT
    adm, _ = E.admit(c["term"], c["exhibits"], N.WC)
    leaked = []
    for q in c["bad_quotes"]:
        ok, struck = E.check_claims([dict(by="no", claims=[dict(exhibit="N1", assertion="a", quote=q)])], adm)
        if ok: leaked.append(q)
    ok, _ = E.check_claims([dict(by="no", claims=[dict(exhibit="N1", assertion="a", quote=c["good_quote"])])], adm)
    check(c["name"], not leaked and len(ok) == 1, detail="number-format variants verified as verbatim: %r; control verified=%s" % (leaked, len(ok) == 1))

def test_tk_anonymous_retraction_judge():
    c = N.ANON_RETRACTION
    adm, rej = E.admit(c["term"], c["exhibits"], N.WC)
    surv = [a["id"] for a in adm if a["id"] != "N1" and "withdrawn" in a["text"]]
    if not os.environ.get('CLAUDE_CODE_OAUTH_TOKEN'):
        raise InfraError('CLAUDE_CODE_OAUTH_TOKEN not set in this environment: claude:haiku backend unavailable (0 calls made)')
    res = _resolve_haiku(c)
    out = res["outcome"]
    kind = "HELD" if out == "NO" else ("VOID-refund/ESCALATE (liveness, not wrong winner)" if out in ("VOID", "ESCALATE") else "SUCCEEDED-wrong-winner")
    check(c["name"], out in c["expect"].split("|"), detail="%s: outcome=%s why=%r; anonymous 'withdrawn' sentences surviving RT1 code strike in: %r (haiku calls so far %d)"
          % (kind, out, res["why"], surv, HAIKU_CALLS))

def _resolve_haiku(case):
    term = case["term"]
    admitted, _ = E.admit(term, case["exhibits"], N.WC)
    claims, _ = E.check_claims(case.get("briefs", []), admitted)
    as_of = J.iso_to_unix(N.WC)
    verdicts = {}
    for el in term["elements"]:
        v = "insufficient"
        for t in sorted({a["tier"] for a in admitted}):
            srcs = [a for a in admitted if a["tier"] == t]
            msgs = J.build_messages(term, el, srcs, as_of=as_of)
            rules_text = msgs[1]["content"].split("</rules>")[0]
            raw, _ = J.call("claude:haiku", msgs, attempts=1)
            if not (raw or "").strip():
                raise InfraError("haiku returned no response (call %d; last=%r)" % (HAIKU_CALLS, LAST[-1:]))
            a, extra = J.verify(raw, srcs, rules_text)
            vv = J.element_verdict_origins([(a, extra if a in ("met", "not_met") else None)], term, srcs)
            if vv == "not_proven" and a in ("insufficient", "empty"):
                continue
            v = vv; break
        verdicts[el["id"]] = "not_met" if v == "insufficient" else v
    outcome, why = J.decide(term, verdicts) if admitted else ("NO", "no admissible evidence")
    return dict(outcome=outcome, why=why)

def main():
    import atexit; atexit.register(lambda: open('/tmp/last_haiku.json','w').write(json.dumps(LAST)))
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            try: fn()
            except InfraError as e: check(name, None, False, "INFRA: %s" % e)
            except Exception as e: check(name, False, False, "raised %r" % e)
    print("%-62s %-22s %s" % ("TEST", "RESULT", "DETAIL"))
    p = r = i = 0
    for n, passed, rbd, d in RESULTS:
        s = "INFRA (no verdict)" if passed is None else ("PASS" if passed else "RED")
        p += passed is True; r += passed is False; i += passed is None
        print("%-62s %-22s %s" % (n, s, d[:400]))
    print("\n%d pass, %d RED, %d INFRA; new Haiku calls this run: %d (cap %d)" % (p, r, i, HAIKU_CALLS, HAIKU_CAP))
    if r: sys.exit(1)
    if i: sys.exit(3)

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Standalone runner for the 2026-11-14 nightly red-team cases (attacks_nightly_20261114.py).
Same check()/RESULTS pattern as test_redteam_evidence.py. Exit 1 if any case is red, 3 if only INFRA.
Judge case: claude:haiku ONLY, via judge.py; every `claude` subprocess is counted (retries included) and the run
hard-stops at HAIKU_CAP calls. NEAR AI is never called. A 402/credit/quota response aborts with ACTION NEEDED."""
import sys, os, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import judge as J
import evidence as E
import attacks_nightly_20261114 as N
import attacks_nightly_20261113 as P

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

def test_tk_host_binding_backslash_userinfo_bypass():
    c = N.HOST_BIND; bad = []; lost = []
    for nm, u in c["must_reject"]:
        adm, _ = E.admit(c["term"], [ex1(u)], N.WC)
        if adm: bad.append(nm)
    for nm, u in c["must_admit"]:
        adm, _ = E.admit(c["term"], [ex1(u)], N.WC)
        if not adm: lost.append(nm)
    check(c["name"], not bad and not lost, detail="off-host URLs admitted under label 'apple.com newsroom' (primary): %r; honest variants wrongly "
          "rejected: %r. Weakness: judge.py:130 registrable_domain() auth.rsplit('@') (backslash is a path delimiter for real fetchers); "
          "Rust parity: resolver/core/src/lib.rs:481 identical (also vulnerable)." % (bad, lost))

def ex1(u):
    return N.ex("Y1", "yes", "apple.com newsroom", "2027-12-05T12:00:00Z", N.FACT, url=u)

def test_tk_host_unbound_wire_label_off_host_admitted():
    c = N.UNBOUND
    adm, rej = E.admit(c["term"], c["exhibits"], N.WC)
    check(c["name"], adm == [], detail="label 'Reuters' (wire) with url host %s admitted=%r rej=%r. Weakness: evidence.py publisher_domains() returns "
          "empty set for host-less labels w/o sources_allowed -> publisher_host_mismatch() returns None. Rust: no host-binding at all (admit_round, lib.rs:1351+)."
          % (J.registrable_domain(c["exhibits"][0]["url"]), [a["id"] for a in adm], rej))

def test_tk_objection_with_trigger_word_smuggles_fact():
    c = N.OBJ_SMUGGLE
    adm, rej = E.admit(c["term"], c["exhibits"], N.WC, round_no=c["round_no"], frozen_exhibit_ids=c["frozen"])
    ids = [a["id"] for a in adm]
    check(c["name"], "Y9" not in ids, detail="objection with new fact + 'misleading' trigger admitted at wire tier in frozen round 2: admitted=%r rej=%r. "
          "Weakness: evidence.py objection_is_argument()/_OBJECTION_RE any-trigger-word per sentence; admitted objection keeps tier/origin weight. "
          "Rust: admit_round (lib.rs:1393) has no content test at all." % (ids, rej))

def test_mk_per_side_cap_keys_on_raw_by_string():
    c = N.CAP
    adm, rej = E.admit(c["term"], c["exhibits"], N.WC)
    check(c["name"], len(adm) <= E.MAX_EXHIBITS, detail="%d maker exhibits admitted across by-variants %r (cap %d). Weakness: evidence.py admit() "
          "per_side[side] keyed on raw e['by']. Rust parity: resolver/core/src/lib.rs:1380-1381 per_side keyed on raw e['by'] too (same hole). Weakness line: evidence.py:183." % (len(adm), sorted({a["by"] for a in adm}), E.MAX_EXHIBITS))

def test_tk_anonymous_retraction_judge():
    c = N.ANON
    adm, rej = E.admit(c["term"], c["exhibits"], N.WC)
    surv = [a["id"] for a in adm if a["id"] != "N1" and "withdrawn" in a["text"]]
    if not os.environ.get('CLAUDE_CODE_OAUTH_TOKEN'):
        raise InfraError('CLAUDE_CODE_OAUTH_TOKEN not set: claude:haiku backend unavailable (0 calls made)')
    res = _resolve_haiku(c)
    out = res["outcome"]
    kind = "HELD" if out == "NO" else ("VOID-refund/ESCALATE (liveness, not wrong winner)" if out in ("VOID", "ESCALATE") else "SUCCEEDED-wrong-winner")
    check(c["name"], out in c["expect"].split("|"), detail="%s: outcome=%s why=%r; surviving anonymous 'withdrawn' sentences: %r (haiku calls %d)" % (kind, out, res["why"], surv, HAIKU_CALLS))

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
    import atexit; atexit.register(lambda: open(os.path.join(os.environ.get('TMPDIR','/tmp'),'last_haiku_20261114.json'),'w').write(json.dumps(LAST)))
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

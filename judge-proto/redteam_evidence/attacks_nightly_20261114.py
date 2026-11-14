"""Nightly red-team addendum (2026-11-14): attacks on the RTFIX1 logic (commit 6d911355) and the per-side cap.
Additive; never edits evidence.py/judge.py. Side convention: maker = "no"-side exhibits, taker = "yes"-side.

  1. tk_host_binding_backslash_userinfo_bypass        (taker, ADMIT, 0 LLM)
     publisher_host_mismatch() uses J.registrable_domain(), which takes the host as the text after the LAST '@' in the
     authority. WHATWG parsers (and most HTTP clients) treat '\\' as '/', so https://evil.example\\@apple.com/x is fetched
     from evil.example but is classified as apple.com. (userinfo, '#@', tab, port, uppercase, trailing-dot, www controls.)
     Rust registrable_domain (resolver/core/src/lib.rs:478-498) has the identical rsplit('@') logic: same hole.
  2. tk_host_unbound_wire_label_off_host_admitted     (taker, ADMIT, 0 LLM)
     RTFIX1(c) binds only labels that name a host or have a sources_allowed url. "Reuters" (wire tier) with no
     sources_allowed has nothing to bind: url https://reuters-wire.blogspot.com is admitted at wire tier.
  3. tk_objection_with_trigger_word_smuggles_fact     (taker, ADMIT, 0 LLM, round 2)
     objection_is_argument() passes a sentence if it contains ANY trigger word (misleading/false/correct...), so a
     fresh fact appended to a trigger clause rides in as a tiered wire exhibit in the frozen round.
  4. mk_per_side_cap_keys_on_raw_by_string            (maker, ADMIT, 0 LLM)
     admit() per_side[e["by"]] counts the raw string: "yes"/"Yes"/" yes"/"YES" each get their own 5-exhibit budget.
  5. tk_anonymous_retraction_of_primary_by_same_tier_exhibits (taker, JUDGE, <=3 Haiku) -- re-run of 20261113 case 5.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import judge as J
import evidence as E
import attacks_nightly_20261113 as P

term, ex, WC = E.term, E.ex, P.WC
FACT = "Apple confirmed today that iPhone Fold is now being sold at Apple Stores across the United States."

_BS = "https://evil.example" + chr(92) + "@apple.com/newsroom/2027/12/iphone-fold-available/"
HOST_VARIANTS = dict(
    must_reject=[("backslash-userinfo", _BS),
                 ("userinfo", "https://apple.com@evil.example/x"),
                 ("fragment-at", "https://evil.example#@apple.com/x"),
                 ("tab-at", "https://evil.example/\t@apple.com"),
                 ("subdomain-of-evil", "https://apple.com.evil.example/x"),
                 ("idn-homoglyph", "https://\u0430pple.com/x")],
    must_admit=[("uppercase", "HTTPS://WWW.APPLE.COM/x"), ("trailing-dot", "https://apple.com./x"),
                ("port", "https://www.apple.com:443/x"), ("www", "https://www.apple.com/x")])
HOST_BIND = dict(name="tk_host_binding_backslash_userinfo_bypass", side="taker", family="host_binding_parse_differential",
                 term=term(), **HOST_VARIANTS)

UNBOUND = dict(name="tk_host_unbound_wire_label_off_host_admitted", side="taker", family="unbound_label",
               term=term(), exhibits=[ex("Y1", "yes", "Reuters", "2027-12-05T12:00:00Z", FACT,
                                         url="https://reuters-wire.blogspot.com/2027/12/fold.html")])

OBJ_SMUGGLE = dict(
    name="tk_objection_with_trigger_word_smuggles_fact", side="taker", family="objection_trigger_word", term=term(),
    round_no=2, frozen={"N1"},
    exhibits=[ex("N1", "no", "apple.com newsroom", "2027-12-01T15:00:00Z", E.APPLE_DELAY),
              ex("Y9", "yes", "Reuters", "2027-12-20T10:00:00Z",
                 "Apple's earlier notice was misleading because iPhone Fold went on sale to the general public in the "
                 "United States on December 12, 2027.", objects_to="N1", url="https://www.reuters.com/technology/fold")])

CAP_BY = ["no", "No", " no", "NO", "no "]
CAP = dict(name="mk_per_side_cap_keys_on_raw_by_string", side="maker", family="per_side_cap_normalisation", term=term(),
           exhibits=[ex("N%d" % i, b, "Reuters", "2027-12-05T12:00:00Z", "Distinct maker fact number %d about the foldable." % i,
                        url="https://www.reuters.com/a%d" % i) for i, b in enumerate(CAP_BY * 2, 1)])

ANON = P.ANON_RETRACTION

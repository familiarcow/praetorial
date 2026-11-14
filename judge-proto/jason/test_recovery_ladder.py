"""D-RESOLVE1 recovery ladder before VOID -- red-first tests, judge-proto.

Covers: structured fallback_any_n_of field (fixes kraken-confirms), resolver-only
unavailability declaration (party "source down" claims ignored), RETRY-before-VOID
with a 24h-step/7d-cap recovery window, keeper archive snapshots admissible (esp.
to prove NO), amend-only (both-signed) mid-bet source substitution.

Usage: python3 judge-proto/jason/test_recovery_ladder.py
No new model spend beyond the existing kraken-confirms scenario (cache-backed).
"""
import hashlib, json, os, re, sys, time, copy

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import judge as J
import evidence as E
import fixtures as F
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

RED = []
def record_red(name, reason):
    RED.append({"name": name, "reason": reason})

def pf(name, ok, detail=""):
    print("[recovery] %-55s %s %s" % (name, "PASS" if ok else "RED", detail))
    if not ok:
        record_red(name, detail)

# ================================================================= fixture: term with structured fallback
BASE = F.TERM
FALLBACK_TERM = F.term(fallback_any_n_of={
    "n": 2,
    "sources": ["Coinbase BTC-USD", "Bitstamp btcusd", "Kraken XBT/USD", "Gemini BTC-USD"],
    "q": "Does the exhibit's 1-minute candle show a high price >= 126210.50 USD before the deadline?",
}, source_classes={**F.TERM["source_classes"], "Gemini BTC-USD": "data"})

# ----------------------------------------------------------------- 1. fallback_any_n_of fixes kraken-confirms
def test_fallback_any_n_of_fixes_kraken_confirms():
    sc = next(s for s in F.SCENARIOS if s["name"] == "one_source_unavailable_kraken_confirms")
    res = F.admit_and_judge(FALLBACK_TERM, sc["exhibits"])
    pf("fallback_any_n_of_fixes_kraken_confirms", res["outcome"] == "YES",
       "expect YES got %s (%s)" % (res["outcome"], res.get("why")))

def test_fallback_any_n_of_doesnt_confirm_voids_source_conflict():
    """b0nd 2026-11-05 (queue notes 7d5/7f3 parity fix): this scenario is Bitstamp confirming
    the cross (met) and Kraken denying it (not_met) -- a real, repeatable live-model verdict
    (checked across >=7 separate runs, consistently met=1/not_met=1) -- i.e. 2 of the 2
    required approved fallbacks produced a usable verdict and genuinely disagree. Before this
    fix, judge_element_fallback's "insufficient" was flattened straight to "not_met"/NO here
    unconditionally, masking this real disagreement exactly like the live Rust resolver's own
    pre-item-7d5 bug: a genuine n-of-n source split on a decisive element must
    VOID:source_conflict, never a silent NO. (Renamed from *_still_no, which asserted the old,
    now-fixed, masked outcome.)"""
    sc = next(s for s in F.SCENARIOS if s["name"] == "one_source_unavailable_kraken_doesnt_confirm")
    res = F.admit_and_judge(FALLBACK_TERM, sc["exhibits"])
    pf("fallback_any_n_of_doesnt_confirm_voids_source_conflict", res["outcome"] == "VOID:source_conflict",
       "expect VOID:source_conflict got %s (%s)" % (res["outcome"], res.get("why")))

# ----------------------------------------------------------------- 2. resolver-only unavailability; party claim ignored
def test_loser_claims_source_down_ignored():
    """A losing party's brief claiming 'Coinbase is down, so this should VOID' must not change
    the outcome -- only the resolver (code, from the actual admitted exhibit set) may declare
    data unavailable. clean_no has two real, admitted sources; a NO-side claim of outage in the
    brief is not evidence and must not move the verdict toward VOID."""
    sc = next(s for s in F.SCENARIOS if s["name"] == "clean_no")
    briefs = [dict(by="yes", claims=[dict(exhibit=None,
              assertion="Coinbase's feed was down during the window so this bet must VOID, not resolve NO",
              quote="")])]
    res = F.admit_and_judge(BASE, sc["exhibits"], briefs=briefs)
    pf("loser_claims_source_down_ignored", res["outcome"] == "NO",
       "party claim of outage must not move NO -> VOID/other; got %s" % res["outcome"])
    pf("loser_claims_source_down_struck_as_unbacked",
       any(s[0] == "yes" for s in res.get("struck", [])),
       "the outage claim has no exhibit/quote and must be struck, not silently accepted: %r" % res.get("struck"))

# ----------------------------------------------------------------- 3. short outage at judge time -> RETRY not VOID
def test_short_outage_retries_before_void():
    """Zero admissible exhibits with time left in the recovery window (first check) must come
    back RETRY with a next_check 24h out, not VOID outright."""
    res = E.resolve_with_recovery(BASE, [], window_close=BASE.get("window_close"),
                                   now="2028-10-28T19:05:00Z", first_unavailable_at=None)
    pf("short_outage_retries_before_void", res["outcome"] == "RETRY",
       "expect RETRY got %s" % res["outcome"])
    pf("short_outage_next_check_is_24h_step",
       res.get("next_check") == "2028-10-29T19:05:00Z",
       "next_check=%r" % res.get("next_check"))

def test_outage_exhausts_ladder_to_void_at_7d():
    """Once the recovery window (24h steps, capped 7 days) is exhausted with still nothing
    admissible, the outcome must become VOID, not RETRY forever."""
    res = E.resolve_with_recovery(BASE, [], window_close=BASE.get("window_close"),
                                   now="2028-11-05T19:05:00Z", first_unavailable_at="2028-10-28T19:05:00Z")
    pf("outage_exhausts_ladder_to_void_at_7d", res["outcome"] == "VOID",
       "expect VOID after 7d of RETRY got %s (%s)" % (res["outcome"], res.get("why")))

# ----------------------------------------------------------------- 1b. three-way fallback parity with the
# live Rust resolver (resolver/wasm-bin::judge_elements_via_fallback, queue items 7d5/7f3): a satisfied
# fallback_any_n_of set that produces >= n usable per-source verdicts which DISAGREE must VOID:source_conflict
# (never a silent NO); a satisfied-count set that produces FEWER than n usable verdicts must RETRY on the
# recovery ladder (never a silent NO either). Deterministic model-free mocks (no new model spend, no
# network) -- same shape as the Rust unit tests' FallbackVoteCaller.
def _fake_call_from_votes(votes):
    """votes: {source_id: "met"|"not_met"|"empty"}. "empty" is a transport failure (no response
    at all) -- `judge.element_verdict` filters those out entirely before voting, so that source
    never counts toward `usable`, unlike a real "insufficient" answer (which maps to "not_proven"
    and DOES count, exactly like `judge_elements_via_fallback`'s own not_met_count membership
    test, per its comment). Returns a J.call-compatible stand-in that inspects the single
    <source id="..."> tag build_messages() put in the prompt and answers deterministically --
    never a real model call."""
    def fake_call(model, messages, key=None, attempts=3):
        content = messages[1]["content"]
        m = re.search(r'<source id="([^"]+)"[^>]*>\n(.*?)\n</source>', content, re.S)
        sid, body = m.group(1), m.group(2)
        ans = votes.get(sid, "empty")
        if ans == "empty":
            return "", None
        quote = body[:40]
        return json.dumps({"answer": ans, "source_id": sid, "quote": quote}), None
    return fake_call

def _with_fake_call(votes, fn):
    orig = J.call
    E.J.call = _fake_call_from_votes(votes)
    try:
        return fn()
    finally:
        E.J.call = orig

def test_fallback_disagree_voids_source_conflict():
    """n=2 required, n=2 approved fallbacks actually respond (Kraken met, Gemini not_met) --
    a decisive split with no n-of consensus must VOID:source_conflict, never a silent NO
    (mirrors resolver/wasm-bin's item_7d5_primary_down_fallbacks_disagree_voids_source_conflict)."""
    exhibits = [
        F.ex("K1", "yes", "Kraken XBT/USD", "2028-06-15T14:32:00Z",
             F.candle_text("Kraken XBT/USD", "2028-06-15T14:32:00Z", 126000, 126300.00, 125900, 126100)),
        F.ex("G1", "yes", "Gemini BTC-USD", "2028-06-15T14:32:00Z",
             F.candle_text("Gemini BTC-USD", "2028-06-15T14:32:00Z", 125950, 126280.00, 125850, 126050)),
    ]
    votes = {"K1": "met", "G1": "not_met"}
    res = _with_fake_call(votes, lambda: E.resolve_with_recovery(
        FALLBACK_TERM, exhibits, window_close=FALLBACK_TERM.get("window_close"),
        now="2028-06-15T15:00:00Z", first_unavailable_at=None))
    pf("fallback_disagree_voids_source_conflict", res["outcome"] == "VOID:source_conflict",
       "approved fallbacks splitting on a decisive element must VOID:source_conflict, got %s (%s)"
       % (res["outcome"], res.get("why")))

def test_fallback_insufficient_retries():
    """n=2 required but only 1 approved fallback produces a usable verdict (Gemini never
    responds -> 'insufficient') -- this is the SAME data-unavailable condition as nothing
    admissible at all and must RETRY on the recovery ladder, never a silent NO (mirrors
    resolver/wasm-bin's item_7d5_primary_down_only_one_of_two_fallbacks_fetchable_retries)."""
    exhibits = [
        F.ex("K1", "yes", "Kraken XBT/USD", "2028-06-15T14:32:00Z",
             F.candle_text("Kraken XBT/USD", "2028-06-15T14:32:00Z", 126000, 126300.00, 125900, 126100)),
        F.ex("G1", "yes", "Gemini BTC-USD", "2028-06-15T14:32:00Z",
             F.candle_text("Gemini BTC-USD", "2028-06-15T14:32:00Z", 125950, 126280.00, 125850, 126050)),
    ]
    votes = {"K1": "met", "G1": "empty"}
    res = _with_fake_call(votes, lambda: E.resolve_with_recovery(
        FALLBACK_TERM, exhibits, window_close=FALLBACK_TERM.get("window_close"),
        now="2028-06-15T15:00:00Z", first_unavailable_at=None))
    pf("fallback_insufficient_retries", res["outcome"] == "RETRY",
       "fewer than n usable fallback verdicts must RETRY, got %s (%s)" % (res["outcome"], res.get("why")))

# ----------------------------------------------------------------- 4. resolver archive snapshots admissible for NO
# NOTE (b0nd, 2026-11-05, queue item 7f3 / D-FETCH1 part 3): minimally updated from the
# original keeper-signed version -- evidence.py's is_keeper_archive was renamed to
# is_resolver_archive and the exhibit field keeper_sig -> resolver_sig as part of the policy
# change (archive snapshots are now OutLayer-resolver-signed, not keeper-signed). Left
# otherwise untouched; this file is jason's, not rewritten beyond what was needed to keep it
# green. Variable names below (RESOLVER_SK/RESOLVER_PK_HEX) renamed to match; see
# test_keeper_signed_snapshot_now_rejected for the new policy-flip coverage.
TH = "7e57" * 16  # D-ATTEST1 (7g4): bet terms_hash committed in the archive message
RESOLVER_SK = Ed25519PrivateKey.generate()
RESOLVER_PK_HEX = RESOLVER_SK.public_key().public_bytes_raw().hex()
BET_ID = "jason-bet-1"

def sign_archive(bet_id, source_id, captured_at, body):
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    msg = E.archive_message(bet_id, source_id, captured_at, TH, body_hash).encode()
    return RESOLVER_SK.sign(msg).hex()

def signed_snap(i, by, pub, bet_id, captured_at, body):
    sig = sign_archive(bet_id, pub, captured_at, body)
    return F.ex(i, by, pub, captured_at, body, source_type="archive_snapshot", terms_hash=TH,
                source_id=pub, captured_at=captured_at, body=body, resolver_sig=sig)

def test_archive_snapshot_proves_no_during_outage():
    """A resolver-captured, signed archive snapshot taken during the bet (both exchanges live at
    capture time, no qualifying high recorded) is admissible evidence and can prove NO on its
    own even if the live sources are unavailable at judge time."""
    term = F.term(bet_id=BET_ID)
    body1 = F.candle_text("Coinbase BTC-USD", "2028-06-15T14:32:00Z", 118000, 118500.0, 117800, 118200)
    body2 = F.candle_text("Bitstamp btcusd", "2028-06-15T14:32:00Z", 117950, 118400.0, 117700, 118150)
    snap = signed_snap("ARC1", "resolver", "Coinbase BTC-USD", BET_ID, "2028-06-15T14:32:00Z", body1)
    snap2 = signed_snap("ARC2", "resolver", "Bitstamp btcusd", BET_ID, "2028-06-15T14:32:00Z", body2)
    assert E.is_resolver_archive(snap, term, RESOLVER_PK_HEX, TH) and E.is_resolver_archive(snap2, term, RESOLVER_PK_HEX, TH)
    admitted, rejected = E.admit(term, [snap, snap2], term.get("window_close"))
    pf("archive_snapshot_admitted", len(admitted) == 2, "rejected=%r" % rejected)
    res = F.admit_and_judge(term, [snap, snap2])
    pf("archive_snapshot_proves_no_during_outage", res["outcome"] == "NO",
       "expect NO from archive-only evidence, got %s" % res["outcome"])

def test_unsigned_snapshot_not_treated_as_resolver_archive():
    """An exhibit merely claiming source_type=archive_snapshot with no resolver_sig at all is not
    a resolver archive -- it is an ordinary party submission and gets no special admissibility."""
    term = F.term(bet_id=BET_ID)
    body = F.candle_text("Coinbase BTC-USD", "2028-06-15T14:32:00Z", 126000, 126350.0, 125900, 126100)
    fake = F.ex("FAKE1", "yes", "Coinbase BTC-USD", "2028-06-15T14:32:00Z", body,
                source_type="archive_snapshot", terms_hash=TH, source_id="Coinbase BTC-USD",
                captured_at="2028-06-15T14:32:00Z", body=body)
    pf("unsigned_snapshot_not_resolver_archive", not E.is_resolver_archive(fake, term, RESOLVER_PK_HEX, TH),
       "an unsigned snapshot must not count as an authoritative archive snapshot")

def test_wrongly_signed_snapshot_rejected():
    """A signature from a non-resolver key must be refused."""
    term = F.term(bet_id=BET_ID)
    attacker_sk = Ed25519PrivateKey.generate()
    body = F.candle_text("Coinbase BTC-USD", "2028-06-15T14:32:00Z", 118000, 118500.0, 117800, 118200)
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    msg = E.archive_message(BET_ID, "Coinbase BTC-USD", "2028-06-15T14:32:00Z", TH, body_hash).encode()
    sig = attacker_sk.sign(msg).hex()
    snap = F.ex("ARC1", "resolver", "Coinbase BTC-USD", "2028-06-15T14:32:00Z", body,
                source_type="archive_snapshot", terms_hash=TH, source_id="Coinbase BTC-USD",
                captured_at="2028-06-15T14:32:00Z", body=body, resolver_sig=sig)
    pf("wrongly_signed_snapshot_rejected", not E.is_resolver_archive(snap, term, RESOLVER_PK_HEX, TH),
       "a signature from a non-resolver key must be refused")

def test_keeper_signed_snapshot_now_rejected():
    """D-FETCH1 part 3 (2026-11-05): a snapshot signed by an OLD keeper key -- otherwise fully
    well-formed -- must now be rejected, since archive snapshots are resolver-signed, not
    keeper-signed, as of this queue item."""
    term = F.term(bet_id=BET_ID)
    keeper_sk = Ed25519PrivateKey.generate()  # stands in for the old, now-superseded keeper key
    body = F.candle_text("Coinbase BTC-USD", "2028-06-15T14:32:00Z", 118000, 118500.0, 117800, 118200)
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    msg = E.archive_message(BET_ID, "Coinbase BTC-USD", "2028-06-15T14:32:00Z", TH, body_hash).encode()
    sig = keeper_sk.sign(msg).hex()
    snap = F.ex("ARC1", "resolver", "Coinbase BTC-USD", "2028-06-15T14:32:00Z", body,
                source_type="archive_snapshot", terms_hash=TH, source_id="Coinbase BTC-USD",
                captured_at="2028-06-15T14:32:00Z", body=body, resolver_sig=sig)
    pf("keeper_signed_snapshot_now_rejected", not E.is_resolver_archive(snap, term, RESOLVER_PK_HEX, TH),
       "a keeper-signed snapshot must be rejected now that archive snapshots are resolver-signed")

def test_wrong_bet_id_signature_rejected():
    """A snapshot signed for a different bet_id than the one being judged must be refused."""
    term = F.term(bet_id=BET_ID)
    body = F.candle_text("Coinbase BTC-USD", "2028-06-15T14:32:00Z", 118000, 118500.0, 117800, 118200)
    snap = signed_snap("ARC1", "resolver", "Coinbase BTC-USD", "some-other-bet", "2028-06-15T14:32:00Z", body)
    pf("wrong_bet_id_signature_rejected", not E.is_resolver_archive(snap, term, RESOLVER_PK_HEX, TH),
       "a snapshot signed for a different bet_id must be refused")

def test_captured_outside_window_rejected():
    """A snapshot captured outside the bet's time window must be refused even if validly signed."""
    term = F.term(bet_id=BET_ID)
    body = F.candle_text("Coinbase BTC-USD", "2028-06-15T14:32:00Z", 118000, 118500.0, 117800, 118200)
    snap = signed_snap("ARC1", "resolver", "Coinbase BTC-USD", BET_ID, "2029-01-01T00:00:00Z", body)
    pf("captured_outside_window_rejected", not E.is_resolver_archive(snap, term, RESOLVER_PK_HEX, TH),
       "a snapshot captured outside the bet window must be refused")

def test_body_hash_mismatch_rejected():
    """A body tampered with after signing must fail the embedded hash check and be refused."""
    term = F.term(bet_id=BET_ID)
    signed_body = F.candle_text("Coinbase BTC-USD", "2028-06-15T14:32:00Z", 118000, 118500.0, 117800, 118200)
    sig = sign_archive(BET_ID, "Coinbase BTC-USD", "2028-06-15T14:32:00Z", signed_body)
    tampered_body = F.candle_text("Coinbase BTC-USD", "2028-06-15T14:32:00Z", 999999, 999999, 999999, 999999)
    snap = F.ex("ARC1", "resolver", "Coinbase BTC-USD", "2028-06-15T14:32:00Z", tampered_body,
                source_type="archive_snapshot", terms_hash=TH, source_id="Coinbase BTC-USD",
                captured_at="2028-06-15T14:32:00Z", body=tampered_body, resolver_sig=sig)
    pf("body_hash_mismatch_rejected", not E.is_resolver_archive(snap, term, RESOLVER_PK_HEX, TH),
       "a body tampered with after signing must fail the hash check and be refused")

# ----------------------------------------------------------------- 5. amend-only substitution
def test_unilateral_substitute_refused():
    amend = {"new_source": "Gemini BTC-USD", "signed_by": ["maker"]}
    ok, why = E.apply_source_substitution(BASE, amend)
    pf("unilateral_substitute_refused", ok is False,
       "a one-sided signature must be refused, got ok=%r why=%r" % (ok, why))

def test_substitute_by_silence_refused():
    amend = {"new_source": "Gemini BTC-USD", "signed_by": []}
    ok, why = E.apply_source_substitution(BASE, amend)
    pf("substitute_by_silence_refused", ok is False,
       "no signatures at all (silence) must be refused, got ok=%r why=%r" % (ok, why))

def test_both_signed_substitute_accepted():
    amend = {"new_source": "Gemini BTC-USD", "signed_by": ["maker", "taker"]}
    ok, why = E.apply_source_substitution(BASE, amend)
    pf("both_signed_substitute_accepted", ok is True, "why=%r" % why)

# ----------------------------------------------------------------- 6. fork ticker hard refusal unless pinned
def test_fork_ticker_hard_refusal_without_pin():
    """Term sheet with price/candle elements but NO ticker_pins mapping must be refused by
    lint() outright -- a hard compiler-time refusal, not a non-blocking flag."""
    unpinned = F.term(elements=[{"id": "e1", "q": "Did BTC candle high reach $126,210.50 on Coinbase and Bitstamp?"}])
    unpinned.pop("ticker_pins", None)
    problems = J.lint(unpinned)
    pf("fork_ticker_hard_refusal_without_pin",
       any("ticker" in p.lower() and "pin" in p.lower() for p in problems),
       "problems=%r" % problems)

def test_canonical_sheet_pins_ticker_and_passes():
    pinned = copy.deepcopy(BASE)
    pinned["ticker_pins"] = {"Coinbase BTC-USD": "BTC-USD", "Bitstamp btcusd": "btcusd", "Kraken XBT/USD": "XBT/USD"}
    problems = J.lint(pinned)
    ticker_problems = [p for p in problems if "ticker" in p.lower() and "pin" in p.lower()]
    pf("canonical_sheet_pins_ticker_and_passes", ticker_problems == [], "problems=%r" % ticker_problems)

def test_fork_exhibit_rejected_when_venue_has_no_pin():
    """At admission time: an exhibit flagged fork_ticker_flag()=True for a venue that has no
    ticker_pins entry for that publisher is hard-refused (rejected), not merely flagged."""
    forked = copy.deepcopy(BASE)
    forked["ticker_pins"] = {"Coinbase BTC-USD": "BTC-USD"}  # Bitstamp intentionally un-pinned
    exh = F.ex("F1", "yes", "Bitstamp btcusd", "2028-06-15T14:32:00Z",
               F.candle_text("Bitstamp btcusd", "2028-06-15T14:32:00Z", 126000, 126300.0, 125900, 126100,
                              note="This candle is for Bitstamp's ticker 'BTC2' after a contested chain-split."))
    admitted, rejected = E.admit(forked, [exh], forked.get("window_close"))
    pf("fork_exhibit_rejected_when_venue_has_no_pin",
       any(r[0] == "F1" for r in rejected),
       "fork-flagged exhibit on an unpinned venue must be rejected, rejected=%r" % rejected)

def test_canonical_sheet_fork_scenario_still_green():
    """Regression guard: the canonical TERM (which pins all three venues) must still pass the
    existing fork_ticker_ambiguity scenario exactly as before (expect NO)."""
    sc = next(s for s in F.SCENARIOS if s["name"] == "fork_ticker_ambiguity")
    pinned = copy.deepcopy(BASE)
    pinned["ticker_pins"] = {"Coinbase BTC-USD": "BTC-USD", "Bitstamp btcusd": "btcusd", "Kraken XBT/USD": "XBT/USD"}
    res = F.admit_and_judge(pinned, sc["exhibits"])
    pf("canonical_sheet_fork_scenario_still_green", res["outcome"] == "NO",
       "expect NO got %s" % res["outcome"])

def main():
    for fn in [test_fallback_any_n_of_fixes_kraken_confirms, test_fallback_any_n_of_doesnt_confirm_voids_source_conflict,
               test_loser_claims_source_down_ignored, test_short_outage_retries_before_void,
               test_outage_exhausts_ladder_to_void_at_7d,
               test_fallback_disagree_voids_source_conflict, test_fallback_insufficient_retries,
               test_archive_snapshot_proves_no_during_outage,
               test_unsigned_snapshot_not_treated_as_resolver_archive, test_wrongly_signed_snapshot_rejected,
               test_keeper_signed_snapshot_now_rejected,
               test_wrong_bet_id_signature_rejected, test_captured_outside_window_rejected,
               test_body_hash_mismatch_rejected, test_unilateral_substitute_refused,
               test_substitute_by_silence_refused, test_both_signed_substitute_accepted,
               test_fork_ticker_hard_refusal_without_pin, test_canonical_sheet_pins_ticker_and_passes,
               test_fork_exhibit_rejected_when_venue_has_no_pin, test_canonical_sheet_fork_scenario_still_green]:
        try:
            fn()
        except Exception as e:
            import traceback
            record_red(fn.__name__, "EXCEPTION: " + traceback.format_exc()[-500:])
            print("[recovery] %-55s ERROR %s" % (fn.__name__, e))
    print("\n=== SUMMARY ===")
    print("RED (%d):" % len(RED))
    for r in RED:
        print("  - %s: %s" % (r["name"], r["reason"]))
    json.dump({"red": RED}, open(os.path.join(os.path.dirname(__file__), "recovery_ladder_report.json"), "w"), indent=1)
    return 0 if not RED else 1

if __name__ == "__main__":
    sys.exit(main())

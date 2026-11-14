#!/usr/bin/env python3
"""Builds examples.json (+ the SYNTHETIC gap fixtures) from the recorded fixtures. Offline. Truth is derived in-script from the raw candles (see README)."""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import cb, bs, kr, D
HERE = os.path.dirname(os.path.abspath(__file__))
iso = lambda t: __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime(t))
NOW = 1794063600                       # settle-request clock (after the last recorded candle 1794063420)
J_WS, J_WE = 1794024000, 1794031200    # 2h Jason window
T_WS, T_WE = 1794025200, 1794061200    # 10h touch window
T_CLOSE = 1794060000
c, b, k = cb("BTC"), bs("BTC"), kr("BTC")
fmt = lambda h: str(int(h)) if float(h).is_integer() else repr(h)
def bucket_max(m, ws, we):
    d = {}
    for t in range(ws, we, 60):
        d[t // 300 * 300] = max(d.get(t // 300 * 300, 0), m[t][1])
    return d
def row(m, ws, we, X, bucket=None):  # first "ts,high" row with high >= X (optionally inside a 5-min bucket)
    for t in range(ws, we, 60):
        if m[t][1] >= X and (bucket is None or t // 300 * 300 == bucket):
            return f"{t},{fmt(m[t][1])}"
cbb, bsb, krb = (bucket_max(m, J_WS, J_WE) for m in (c, b, k))
jason = json.load(open(os.path.join(HERE, "../live-run8/jason_terms_with_urls.json")))
raw_j = json.dumps(jason)
def jason_sheet(X, ws=J_WS, we=J_WE, asset=None):
    s = raw_j.replace("126,210.50", f"{X:,}.00").replace("126210.50", f"{X}.00")
    s = s.replace("2028-10-28T19:00:00Z", iso(we)).replace("2026-11-04T00:00:00Z", iso(ws))
    s = s.replace("2028-11-04T19:00:00Z", iso(NOW)).replace("2028-11-06T19:00:00Z", iso(NOW))
    s = s.replace("2028-10-28", iso(we)[:10]).replace("October 28, 2028, 12PM PST", iso(we))
    return json.loads(s)
def met(sid, q, also=None):
    d = {"answer": "met", "quote": q, "source_id": sid, "reason": "recorded judge reply (hand-written, not a model call)"}
    if also: d["also"] = [{"source_id": also[0], "quote": also[1]}]
    return json.dumps(d)
def not_met(sid, q, why): return json.dumps({"answer": "not_met", "quote": q, "source_id": sid, "reason": "recorded judge reply: " + why})
def maxrow(m, ws, we):  # the row of the window's highest high
    t = max(range(ws, we, 60), key=lambda t: m[t][1]); return f"{t},{fmt(m[t][1])}"
INSUFF = json.dumps({"answer": "insufficient", "reason": "recorded judge reply: the exhibits cannot establish it"})
ex = []
def add(**e): ex.append(e)

# ---------- Jason form, past 2h window [J_WS, J_WE)
x1 = math.floor(max(min(cbb[q], bsb[q]) for q in cbb)); q1 = [q for q in cbb if cbb[q] >= x1 and bsb[q] >= x1][0]
add(id="jason_same_bucket_yes", group="jason", kind="custom", phrasing="Jason form: BTC 1-min high reaches $%d on BOTH Coinbase and Bitstamp within the same 5-minute window (past window %s..%s)" % (x1, iso(J_WS), iso(J_WE)),
    sheet=jason_sheet(x1), judge=met("S_CB", row(c, J_WS, J_WE, x1, q1), ("S_BS", row(b, J_WS, J_WE, x1, q1))), now=NOW, expected="YES", l1b="Jason past-window YES",
    why=f"5-min bucket {iso(q1)}: Coinbase max high {cbb[q1]} and Bitstamp max high {bsb[q1]} are both >= {x1} (derived from raw candles).")
mc, mb, mk = (max(m[t][1] for t in range(J_WS, J_WE, 60)) for m in (c, b, k))
xb = math.floor(max(mb, mc, mk)); 
xo = math.floor(mc) + 1 if mb >= math.floor(mc) + 1 and mk < math.floor(mc) + 1 else None
add(id="jason_bitstamp_only_no", group="jason", kind="custom", phrasing="Jason form, level touched on Bitstamp only (past window)", sheet=jason_sheet(xo), judge=not_met("S_CB", maxrow(c, J_WS, J_WE), "Coinbase's highest high is below the level"), now=NOW, expected="NO", l1b="Jason one-venue NO",
    why=f"Window maxima: Coinbase {mc}, Bitstamp {mb}, Kraken {mk}; X={xo} is reached only on Bitstamp, so the BOTH-venues rule fails -> NO.")
# CB-only window 3 [1794027600,1794034800)
w3 = (1794027600, 1794034800); m3 = [max(m[t][1] for t in range(*w3, 60)) for m in (c, b, k)]
xo3 = math.floor(m3[1]) + 1; assert m3[0] >= xo3 and m3[2] < xo3
add(id="jason_coinbase_only_no", group="jason", kind="custom", phrasing="Jason form, level touched on Coinbase only (past window)", sheet=jason_sheet(xo3, *w3), judge=not_met("S_BS", maxrow(b, *w3), "Bitstamp's highest high is below the level"), now=NOW, expected="NO",
    why=f"Window maxima CB/BS/KR = {m3}; X={xo3} reached on Coinbase only -> NO.")
# different buckets: X=75950 (scan result), recompute
x3 = None
for X in range(math.floor(min(mc, mb)), math.floor(min(mc, mb)) - 400, -1):
    sc = {q for q, h in cbb.items() if h >= X}; sb = {q for q, h in bsb.items() if h >= X}
    if sc and sb and not (sc & sb): x3 = X; break
add(id="jason_both_venues_different_buckets_no", group="jason", kind="custom", phrasing="Jason form, level touched on both venues but in different 5-minute buckets", sheet=jason_sheet(x3), judge=not_met("S_BS", row(b, J_WS, J_WE, x3, sorted(sb)[0]), "Bitstamp's qualifying high is in a different 5-minute window than Coinbase's"), now=NOW, expected="NO",
    why=f"X={x3}: Coinbase buckets {[iso(q) for q in sorted(sc)]}, Bitstamp buckets {[iso(q) for q in sorted(sb)]}: disjoint -> NO.")
# SYNTHETIC gap fixtures: Coinbase minus 12 mid-window minutes (> 2% of 120 candles) => INCOMPLETE => Kraken fallback
x4 = math.floor(max(min(bsb[q], krb[q]) for q in bsb)); q4 = [q for q in bsb if bsb[q] >= x4 and krb[q] >= x4][0]
gap_min = [t for t in range(J_WS + 3600, J_WS + 3600 + 12 * 60, 60)]
assert all(t // 300 * 300 != q4 for t in gap_min)
# synthetic CB big gap file (labelled), 2-minute small-gap file
def write_cb_variant(name, drop):
    pages = []
    for i in range(3):
        pages += [r for r in json.load(open(f"{D}cb_BTC_1m_p{i}.json")) if r[0] not in drop]
    json.dump(pages, open(f"{D}{name}", "w"))
write_cb_variant("SYNTHETIC_cb_BTC_1m_gap12.json", set(gap_min))
small = {J_WS + 3600, J_WS + 3660}
write_cb_variant("SYNTHETIC_cb_BTC_1m_gap2.json", small)
add(id="jason_coinbase_gap_kraken_fallback_yes", group="jason", kind="custom", cb_file="SYNTHETIC_cb_BTC_1m_gap12.json", synthetic=True,
    phrasing="Jason form with 12 Coinbase minutes missing (SYNTHETIC deletion) -> Coinbase excluded (D-RESOLVE8 bound), Bitstamp + Kraken confirm", sheet=jason_sheet(x4), judge=met("S_BS", row(b, J_WS, J_WE, x4, q4), ("S_KR", row(k, J_WS, J_WE, x4, q4))), now=NOW, expected="YES",
    why=f"Coinbase minutes {iso(gap_min[0])}..{iso(gap_min[-1])} removed (12 of 120 = 10% > 2%): Coinbase INCOMPLETE. Bitstamp max {bsb[q4]} and Kraken max {krb[q4]} in bucket {iso(q4)} both >= {x4} -> fallback pair confirms -> YES.")
add(id="jason_coinbase_small_gap_yes", group="jason", kind="custom", cb_file="SYNTHETIC_cb_BTC_1m_gap2.json", synthetic=True,
    phrasing="Jason form with 2 Coinbase minutes missing (SYNTHETIC deletion, within the D-RESOLVE8 tolerance), same level as the YES example", sheet=jason_sheet(x1), judge=met("S_CB", row(c, J_WS, J_WE, x1, q1), ("S_BS", row(b, J_WS, J_WE, x1, q1))), now=NOW, expected="YES",
    why=f"Removed Coinbase minutes {sorted(iso(t) for t in small)} are not in the decisive bucket {iso(q1)}; gaps (2 of 120) are tolerated, so the same-bucket YES stands.")

# ---------- typed close-at-T
cl = sorted(m[T_CLOSE - 60][2] for m in (c, b, k)); med = cl[1]
def close_sheet(op, x): return {"template": {"id": "btc_close_at_t", "version": 1}, "fields": {"t_utc": iso(T_CLOSE), "op": op, "x_usd": x, "open_utc": iso(T_CLOSE - 3 * 3600)}}
mf = math.floor(med)
cn = f"closes of the minute ending T: CB {c[T_CLOSE-60][2]}, BS {b[T_CLOSE-60][2]}, KR {k[T_CLOSE-60][2]} -> median {med}"
add(id="close_above_yes", group="close_at_t", kind="typed", phrasing=f"BTC closes above ${mf-10} at {iso(T_CLOSE)}", sheet=close_sheet(">", mf - 10), now=T_CLOSE + 600, expected="YES", l1b="close-at-T", why=f"{cn} > {mf-10}.")
add(id="close_above_no", group="close_at_t", kind="typed", phrasing=f"BTC above ${mf+10} at {iso(T_CLOSE)}", sheet=close_sheet(">", mf + 10), now=T_CLOSE + 600, expected="NO", why=f"{cn} <= {mf+10}.")
add(id="close_below_yes", group="close_at_t", kind="typed", phrasing=f"BTC below ${mf+10} at {iso(T_CLOSE)}", sheet=close_sheet("<", mf + 10), now=T_CLOSE + 600, expected="YES", why=f"{cn} < {mf+10}.")
add(id="close_below_no", group="close_at_t", kind="typed", phrasing=f"BTC below ${mf-10} at {iso(T_CLOSE)}", sheet=close_sheet("<", mf - 10), now=T_CLOSE + 600, expected="NO", why=f"{cn} >= {mf-10}.")
# ---------- typed touch, 10h window
mx = [max(m[t][1] for t in range(T_WS, T_WE, 60)) for m in (c, b, k)]; mn = [min(m[t][0] for t in range(T_WS, T_WE, 60)) for m in (c, b, k)]
def touch_sheet(d, x): return {"template": {"id": "btc_touch", "version": 1}, "fields": {"direction": d, "x_usd": x, "deadline_utc": iso(T_WE), "open_utc": iso(T_WS)}}
sm = sorted(mx); xs = math.floor(sm[1]); xv = xs + 1; xn = math.floor(sm[2]) + 1
assert sm[2] >= xv
add(id="touch_above_yes", group="touch", kind="typed", phrasing=f"BTC touches ${xs} before {iso(T_WE)}", sheet=touch_sheet("at_or_above", xs), now=NOW, expected="YES", why=f"venue maxima CB/BS/KR = {mx}; at least 2 venues reach {xs}.")
add(id="touch_above_no", group="touch", kind="typed", phrasing=f"BTC hits ${xn} before {iso(T_WE)}", sheet=touch_sheet("at_or_above", xn), now=NOW, expected="NO", why=f"venue maxima {mx}: no venue reaches {xn}.")
add(id="touch_above_one_venue_void", group="touch", kind="typed", phrasing=f"BTC touches ${xv} before {iso(T_WE)} (only one venue reached it)", sheet=touch_sheet("at_or_above", xv), now=NOW, expected="VOID", why=f"venue maxima {mx}: exactly one venue reaches {xv} -> D-TPL1b 'venues disagree on touch' VOID.")
sn = sorted(mn); xl = math.ceil(sn[1]); xln = math.floor(sn[0]) - 1
add(id="touch_below_yes", group="touch", kind="typed", phrasing=f"BTC drops to ${xl} before {iso(T_WE)}", sheet=touch_sheet("at_or_below", xl), now=NOW, expected="YES", why=f"venue minima {mn}: at least 2 venues reach <= {xl}.")
add(id="touch_below_no", group="touch", kind="typed", phrasing=f"BTC falls to ${xln} before {iso(T_WE)}", sheet=touch_sheet("at_or_below", xln), now=NOW, expected="NO", why=f"venue minima {mn}: no venue goes to {xln}.")

# ---------- builder rejects (typed drafts a builder could emit for phrasings no template can express / malformed)
def rej(i, ph, sheet, code, why, kind="builder", **kw): add(id=i, group="messy" if kw.pop("messy", False) else "builder_reject", kind=kind, phrasing=ph, sheet=sheet, now=NOW, expected="REJECT", reject_code=code, why=why, **kw)
rej("pct_move_day_builder", "BTC up more than 5% on 2026-11-07 (open->close)", {"template": {"id": "btc_pct_move", "version": 1}, "fields": {"pct": 5, "day": "2026-11-07"}}, "TPL_UNKNOWN_ID", "No template expresses an open->close percentage move (D-SCOPE3: 3 bet types); must not become a guess.")
rej("eth_close_builder", "ETH closes above $2,000 at 2026-11-07T20:00 UTC", {**close_sheet(">", 2000), "fields": {**close_sheet(">", 2000)["fields"], "asset": "ETH"}}, "TPL_UNKNOWN_FIELD", "Typed crypto templates are BTC-USD only; an `asset` field is not in btc_close_at_t v1.")
rej("sol_touch_builder", "SOL touches $150 before 2026-11-07", {**touch_sheet("at_or_above", 150), "fields": {**touch_sheet("at_or_above", 150)["fields"], "asset": "SOL"}}, "TPL_UNKNOWN_FIELD", "SOL is not supported by btc_touch v1.")
rej("eth_and_sol_builder", "ETH and SOL both above their level at 2026-11-07T20:00 UTC", {"template": {"id": "btc_close_at_t", "version": 1}, "fields": {"t_utc": iso(T_CLOSE), "op": ">", "x_usd": 2000, "open_utc": iso(T_CLOSE - 3 * 3600), "assets": ["ETH", "SOL"]}}, "TPL_UNKNOWN_FIELD", "Multi-asset conjunction cannot be expressed by any template.")
rej("no_timezone_builder", "BTC above $76,000 at 5pm tomorrow (no timezone)", {"template": {"id": "btc_close_at_t", "version": 1}, "fields": {"t_utc": "2026-11-08T17:00:00", "op": ">", "x_usd": 76000, "open_utc": iso(NOW)}}, "TPL_T_UTC_NOT_MINUTE", "A time without an explicit UTC marker is refused, never assumed.", messy=True)
rej("amount_100k_builder", "BTC above 100k at 2026-11-08T17:00:00Z", {"template": {"id": "btc_close_at_t", "version": 1}, "fields": {"t_utc": "2026-11-08T17:00:00Z", "op": ">", "x_usd": "100k", "open_utc": iso(NOW)}}, "TPL_X_USD_NOT_WHOLE", "'100k' is not a whole-dollar JSON integer; the builder must normalise before the sheet exists.", messy=True)
rej("friday_custom", "BTC will be above $76,000 on Friday", {"claim": "BTC will be above $76,000 on Friday", "elements": [{"id": "e1", "q": "Is BTC above $76,000 on Friday?"}], "rule": "ALL"}, "CUSTOM_RELATIVE_DATE", "'Friday' with no calendar date is refused at open (D-TPL1a).", kind="custom_open", messy=True)
# ---------- AI-path custom phrasings (recorded judge); evidence is candle HIGHS only
def custom_candle(claim, q, ws=T_WS, we=T_WE, asset="BTC"):
    s = jason_sheet(75000, ws, we)
    s.pop("_comment", None)
    s["claim"], s["elements"] = claim, [{"id": "e1", "q": q}]
    s["custom_definitions"] = ["Only candle data from the three listed venues counts; a 1-minute candle HIGH (the wick) is what is read, not the close.", "Fallback: if one named venue is unavailable the remaining venues must confirm; if fewer than two can be checked the outcome is VOID.", "Early YES resolution is allowed at the first qualifying confirmed candle, never before; otherwise the outcome is decided at the window end.", "If the evidence cannot establish the claim, the outcome is VOID."]
    return s
add(id="flips_100k_messy", group="messy", kind="custom", phrasing="BTC flips 100k", sheet=custom_candle("BTC flips 100k", "Did BTC flip 100k?"), judge=INSUFF, now=NOW, expected="VOID", l1b="messy phrasing must VOID",
    why="'flips' has no defined direction/measure and 100k is not a stated level; a recorded judge can only say insufficient -> VOID. A decisive YES/NO would be a wrong winner.")
lo, hi = min(mn), max(mx)
add(id="range_all_session_stays_within_void", group="range", kind="custom", phrasing=f"BTC stays between ${math.floor(lo)-50} and ${math.ceil(hi)+50} for the whole session", sheet=custom_candle(f"BTC stays between ${math.floor(lo)-50} and ${math.ceil(hi)+50} (every candle) from {iso(T_WS)} to {iso(T_WE)}", f"Does BTC-USD stay between {math.floor(lo)-50} and {math.ceil(hi)+50} the whole time?"), judge=INSUFF, now=NOW, expected="VOID",
    why="Truth is YES (maxima %s, minima %s inside the band) but the resolver evidence is candle HIGHS only: lows are never shown, so a stay-within cannot be proven -> VOID is the safe outcome (never a decisive guess)." % (mx, mn))
ub = math.floor(sm[0]) - 20
add(id="range_breakout_no", group="range", kind="custom", phrasing=f"BTC stays below ${ub} for the whole session", sheet=custom_candle(f"BTC stays below ${ub} from {iso(T_WS)} to {iso(T_WE)}", f"Does every BTC-USD candle high stay below {ub}?"), judge=not_met("S_CB", maxrow(c, T_WS, T_WE), f"a candle high exceeded {ub}"), now=NOW, expected="NO",
    why=f"Every venue's session max ({mx}) is above {ub}: the upper bound was broken -> NO.")
add(id="pct_up_day_custom_void", group="messy", kind="custom", phrasing="BTC up more than 5% on 2026-11-07 (open->close), custom sheet", sheet=custom_candle("BTC-USD rose by more than 5% from the open to the close on 2026-11-07", "Did BTC rise more than 5% from open to close on 2026-11-07?"), judge=INSUFF, now=NOW, expected="VOID",
    why="Evidence rows are highs only (no open/close), so the move cannot be measured -> VOID. (Truth is NO: the range in the window is < 1%.)")
for e in ex:
    e["expected_path"] = {"typed": "code", "builder": "builder-reject", "custom_open": "builder-reject", "custom": "AI"}[e["kind"]]
import hashlib
mf = json.load(open(f"{D}manifest.json")); mf["files"] = [f for f in mf["files"] if not f["file"].startswith("SYNTHETIC")]
for n in ("SYNTHETIC_cb_BTC_1m_gap12.json", "SYNTHETIC_cb_BTC_1m_gap2.json"):
    mf["files"].append({"file": n, "synthetic": True, "derived_from": "cb_BTC_1m_p0..p2.json minus deleted minutes", "sha256": hashlib.sha256(open(D + n, "rb").read()).hexdigest()})
json.dump(mf, open(f"{D}manifest.json", "w"), indent=1)
json.dump({"now": NOW, "windows": {"jason": [J_WS, J_WE], "touch": [T_WS, T_WE], "close_t": T_CLOSE}, "examples": ex}, open(os.path.join(HERE, "examples.json"), "w"), indent=1)
print(len(ex), "examples")

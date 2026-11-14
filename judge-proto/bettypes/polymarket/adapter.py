import json, hashlib
from bettypes import harness as H

def _winner_from_prices(outcomes, prices):
    p = [float(x) for x in prices]
    if all(abs(x - 0.5) < 1e-9 for x in p): return "50-50"
    for o, x in zip(outcomes, p):
        if abs(x - 1.0) < 1e-9: return o
    return None
def parse_gamma(body):
    d = json.loads(body); outcomes = json.loads(d["outcomes"]); prices = json.loads(d["outcomePrices"])
    final = bool(d["closed"]) and d["umaResolutionStatus"] == "resolved"
    return dict(condition_id=d["conditionId"], final=final, winner=_winner_from_prices(outcomes, prices) if final else None,
                uma=d["umaResolutionStatus"], description=d["description"])
def parse_clob(body):
    d = json.loads(body); toks = d["tokens"]
    win = next((t["outcome"] for t in toks if t["winner"]), None)
    if win is None and d["closed"] and all(abs(float(t["price"]) - 0.5) < 1e-9 for t in toks): win = "50-50"
    return dict(condition_id=d["condition_id"], final=bool(d["closed"]) and win is not None, winner=win)
def parse_ctf(body, outcomes=("Yes", "No")):
    d = json.loads(body); r = {c["call"]: int(c["result"], 16) for c in d["calls"]}
    den, nums = r["payoutDenominator"], [r["payoutNumerators(0)"], r["payoutNumerators(1)"]]
    if den == 0: return dict(condition_id=d["condition_id"], final=False, winner=None)
    win = "50-50" if nums[0] > 0 and nums[1] > 0 else outcomes[0] if nums[0] > 0 else outcomes[1]
    return dict(condition_id=d["condition_id"], final=True, winner=win)

PARSERS = {"Polymarket Gamma API": parse_gamma, "Polymarket CLOB API": parse_clob, "Polygon CTF contract (payoutNumerators)": parse_ctf}
CTF = "Polygon CTF contract (payoutNumerators)"

class Checker:
    def __init__(self, term):
        self.pin = term["market_pin"]; self.target = term["bettype"]["outcome"]
    def _parse(self, e): return PARSERS[e["publisher"]](H.split_text(e["text"])[1])
    def prefilter(self, exhibits):
        """Deterministic facts about the evidence, decided in code (never by the model):
        wrong market -> dropped; not final -> dropped; description edited since signing -> VOID;
        on-chain finality is mandatory and >=1 of Gamma/CLOB must also be final."""
        kept = []
        for e in exhibits:
            p = self._parse(e)
            if p["condition_id"] != self.pin["condition_id"]: continue          # look-alike / wrong market
            if e["publisher"] == "Polymarket Gamma API" and hashlib.sha256(p["description"].encode()).hexdigest() != self.pin["description_sha256"]:
                return [], "VOID:terms_changed"                                 # resolution rules edited after signing
            if p["final"]: kept.append(e)
        if not any(e["publisher"] == CTF for e in kept) or len(kept) < 2: return [], None   # -> RETRY ladder, VOID at cap
        return kept, None
    def __call__(self, term, q, sources):
        res = {s["id"]: (s, self._parse(s)["winner"]) for s in sources}
        winners = {w for _, w in res.values()}
        if len(winners) > 1 or "50-50" in winners:
            return dict(answer="conflict", reason="sources disagree or payout is 50-50: no clean winner")
        s, w = next(iter(res.values()))
        if w == self.target:
            return dict(answer="met", quote=H.line_quote(s["text"], "outcomePrices") if s["publisher"].endswith("Gamma API") else H.safe_quote(s["text"]), source_id=s["id"], reason="all final sources show the pinned outcome as winner")
        return dict(answer="not_met", quote=H.safe_quote(s["text"]), source_id=s["id"], reason="all final sources show a different outcome as winner")
def make_checker(term): return Checker(term)

"""Synthetic Gamma / CLOB / CTF fixtures in the exact shape of the recorded live responses
(fixtures/live_yes.json, live_clob_yes.json, live_ctf_yes.json)."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
LIVE = json.loads(json.load(open(os.path.join(HERE, "fixtures/live_yes.json")))["body"])
CID = LIVE["conditionId"]; DESC = LIVE["description"]
def raw(status, ct, body): return dict(url="https://gamma-api.polymarket.com/markets/1832664", status=status, content_type=ct, body=body)
def _prices(win):
    return {"Yes": ["1", "0"], "No": ["0", "1"], "50-50": ["0.5", "0.5"], None: ["0.52", "0.48"]}[win]
def gamma(win, uma=None, description=None, condition_id=None):
    d = {k: LIVE[k] for k in ("id", "slug", "question", "resolvedBy", "umaBond")}
    d.update(conditionId=condition_id or CID, description=description if description is not None else DESC,
             closed=win is not None, active=True, umaResolutionStatus=uma or ("resolved" if win else "proposed"),
             outcomes=json.dumps(["Yes", "No"]), outcomePrices=json.dumps(_prices(win)), closedTime="2026-04-29 23:38:02+00" if win else None)
    return dict(url="https://gamma-api.polymarket.com/markets/1832664", status=200, content_type="application/json", body=json.dumps(d, indent=1))
def clob(win, condition_id=None):
    p = _prices(win)
    toks = [{"outcome": o, "price": float(p[i]), "winner": win == o} for i, o in enumerate(["Yes", "No"])]
    return dict(url="https://clob.polymarket.com/markets/" + (condition_id or CID), status=200, content_type="application/json",
                body=json.dumps({"condition_id": condition_id or CID, "closed": win is not None, "tokens": toks}, indent=1))
def ctf(win, condition_id=None):
    den, nums = {"Yes": (1, [1, 0]), "No": (1, [0, 1]), "50-50": (2, [1, 1]), None: (0, [0, 0])}[win]
    h = lambda n: "0x%064x" % n
    calls = [{"call": "payoutDenominator", "result": h(den)}, {"call": "payoutNumerators(0)", "result": h(nums[0])}, {"call": "payoutNumerators(1)", "result": h(nums[1])}]
    return dict(url="polygon-rpc eth_call x3 (publicnode) to CTF 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", status=200, content_type="application/json",
                body=json.dumps({"condition_id": condition_id or CID, "calls": calls}, indent=1))

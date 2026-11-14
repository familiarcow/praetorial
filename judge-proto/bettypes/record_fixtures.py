"""Record trimmed public-endpoint responses as fixtures (one-off; re-runnable). No keys, no logins."""
import json, subprocess, datetime, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
def get(u):
    r = subprocess.run(["curl", "-sL", "-m", "25", "-A", "praetorial-probe/0.1 (research)", "-w", "\n%{http_code}\t%{content_type}", u],
                       capture_output=True, text=True)
    body, _, tail = r.stdout.rpartition("\n"); code, _, ct = tail.partition("\t")
    return int(code or 0), ct, body
now = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
def save(rel, url, code, ct, body, trim=None):
    if trim:
        body = json.dumps(trim(json.loads(body)), indent=1)
    json.dump({"url": url, "recorded_at": now, "status": code, "content_type": ct, "body": body}, open(os.path.join(HERE, rel), "w"), indent=1)
    print(rel, code, len(body))
if __name__ == "__main__":
    keep = ["id","slug","question","conditionId","description","closed","active","umaResolutionStatus","outcomes","outcomePrices","closedTime","endDate","resolvedBy","resolutionSource","umaBond","automaticallyResolved"]
    for name, mid in [("yes", 1832664), ("no", 1832665)]:
        u = "https://gamma-api.polymarket.com/markets/%d" % mid
        c, ct, b = get(u); save("polymarket/fixtures/live_%s.json" % name, u, c, ct, b, lambda d: {k: d.get(k) for k in keep})
    u = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=bsky.app&limit=3&filter=posts_no_replies"
    c, ct, b = get(u)
    def tb(d):
        return {"feed": [{"post": {"uri": f["post"]["uri"], "cid": f["post"]["cid"],
                "author": {"handle": f["post"]["author"]["handle"], "did": f["post"]["author"]["did"]},
                "record": {"$type": f["post"]["record"]["$type"], "text": f["post"]["record"]["text"], "createdAt": f["post"]["record"]["createdAt"]},
                "indexedAt": f["post"]["indexedAt"]}} for f in d["feed"]]}
    save("social_post/fixtures/live_bluesky_feed.json", u, c, ct, b, tb)
    u = "https://cdn.syndication.twimg.com/tweet-result?id=20&token=a"
    c, ct, b = get(u)
    save("social_post/fixtures/live_x_syndication_tweet20.json", u, c, ct, b, lambda d: {"id_str": d["id_str"], "text": d["text"], "created_at": d["created_at"], "user": {"screen_name": d["user"]["screen_name"]}})
    u = "https://cdn.syndication.twimg.com/tweet-result?id=1&token=a"
    c, ct, b = get(u); save("social_post/fixtures/live_x_syndication_missing.json", u, c, ct, b[:200])
    # polymarket CLOB + on-chain CTF (payoutDenominator / payoutNumerators) for the pinned Pharos market
    cid = "0x03c2271926c13386ceabaee1f925b9329a6d1472897831ccdb93f666f8105c7e"
    u = "https://clob.polymarket.com/markets/" + cid
    c, ct, b = get(u)
    save("polymarket/fixtures/live_clob_yes.json", u, c, ct, b, lambda d: {"condition_id": d["condition_id"], "closed": d["closed"], "tokens": [{k: t[k] for k in ("outcome", "price", "winner")} for t in d["tokens"]]})
    calls = []
    for name, sel, idx in [("payoutDenominator", "dd34de67", None), ("payoutNumerators(0)", "0504c814", 0), ("payoutNumerators(1)", "0504c814", 1)]:
        data = "0x" + sel + cid[2:] + ("" if idx is None else "%064x" % idx)
        rb = subprocess.run(["curl", "-s", "-m", "25", "https://polygon-bor-rpc.publicnode.com", "-H", "content-type: application/json", "-d", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", "data": data}, "latest"]})], capture_output=True, text=True).stdout
        calls.append({"call": name, "result": json.loads(rb)["result"]})
    json.dump({"url": "polygon-rpc eth_call x3 (publicnode) to CTF 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", "recorded_at": now, "status": 200, "content_type": "application/json",
               "body": json.dumps({"condition_id": cid, "calls": calls}, indent=1)}, open(os.path.join(HERE, "polymarket/fixtures/live_ctf_yes.json"), "w"), indent=1)
    u = "https://api.github.com/repositories/65600975/releases?per_page=3"
    c, ct, b = get(u)
    k2 = ["tag_name","name","draft","prerelease","created_at","published_at","html_url","target_commitish"]
    save("github_release/fixtures/live_pytorch_releases.json", u, c, ct, b, lambda d: [{k: r.get(k) for k in k2} for r in d])

# CF1e2: per-worker p50/max CPU from tail/<worker>.json -> tail/summary.json (red if any max > 10 ms)
import json, os, statistics
d = os.path.dirname(os.path.abspath(__file__)) + "/tail/"
out = {"limit_ms": 10, "note": "single-worker wrangler tail, one worker at a time; sanitized", "workers": {}}
for w in ["keeper", "relayer", "monitor", "notifier"]:
    p = d + w + ".json"
    if not os.path.exists(p):
        continue
    rows = json.load(open(p))
    by = {}
    for r in rows:
        by.setdefault(f"{r.get('entrypoint') or 'worker'} {r['trigger']}", []).append(r)
    def stat(rs):
        c = [r["cpuMs"] for r in rs]
        return {"n": len(c), "p50": statistics.median(c), "max": max(c), "red": max(c) > 10, "failed": sum(1 for r in rs if r["outcome"] != "ok")}
    out["workers"][w] = {"all": stat(rows), "by_trigger": {k: stat(v) for k, v in by.items()}}
json.dump(out, open(d + "summary.json", "w"), indent=1)
for w, v in out["workers"].items():
    print(w, v["all"])
    for k, s in v["by_trigger"].items():
        print("   ", k, s)

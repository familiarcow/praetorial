import json, sys
o = json.load(open("out_all.txt"))
now = o["now_unix"]
rows = []
for s in o["sources"]:
    d = dict(s)
    if s["oldest_ts"] is not None:
        d["oldest_age_days"] = round((now - s["oldest_ts"]) / 86400, 2)
    rows.append(d)
print("planned", o["planned"], "got", len(rows), "elapsed_ms", o["total_elapsed_ms"], "signed", o["signed"], "near_ai_calls", o["near_ai_calls"])
for d in rows:
    print(f'{d["id"]:18} {str(d["http_status"]):>4} {d["bytes"]:>7} rec={d["records"]} age_d={d.get("oldest_age_days")} {d["elapsed_ms"]}ms err={d["error"]}')
json.dump({"probe_output": o, "sources": rows}, open("results_sources.json", "w"), indent=1)

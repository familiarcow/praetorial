import json, sys, re, os
txt = open(sys.argv[1]).read()
for s in re.split(r"\n(?=\{\n)", txt):
    try: e = json.loads(s)
    except Exception: continue
    ev = e.get("event", {}); rq = ev.get("request")
    if rq: print(rq["method"], rq["url"].split(".dev")[-1], e.get("outcome"), "cpu", e.get("cpuTime"), "wall", e.get("wallTime"))

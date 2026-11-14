import json,sys
for r in json.load(open(sys.argv[1])):
    if "tick" in r["trigger"]: print(r["trigger"], r["outcome"], r["cpuMs"], r["wallMs"], r["ts"])

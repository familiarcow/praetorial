import json, sys
for f in sys.argv[1:]:
    d = json.load(open(f))
    print("==", f, d.get("verdict"), d.get("verdict_drill4"))
    for t in d.get("txs", []):
        print(" ", t["step"], t["hash"])

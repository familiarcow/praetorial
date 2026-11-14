import sys,json
d=json.load(open(sys.argv[1])); print(d["spend_usd"],d["exhausted"],json.dumps(d["table"]))
for r in d["runs"]: print(r["run"],r["model_outcomes"],r["category"])

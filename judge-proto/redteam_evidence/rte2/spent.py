import sys,json
print(round(sum(json.loads(l)["usd"] for l in open(sys.argv[1])),4))

import json
raw=json.load(open("raw_resolution.txt"))
def strip(o,d=0):
    return o
print(json.dumps(raw,indent=1)[:9000])

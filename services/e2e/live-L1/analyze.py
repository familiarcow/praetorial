import json, glob, sys
D="fixtures/"
def L(n): return json.load(open(D+n))
def cb(a):
    r={}
    for i in range(3):
        for t,lo,hi,op,cl,v in L(f"cb_{a}_1m_p{i}.json"): r[t]=(float(lo),float(hi),float(cl))
    return r
def bs(a): return {int(c["timestamp"]):(float(c["low"]),float(c["high"]),float(c["close"])) for c in L(f"bs_{a}_1m.json")["data"]["ohlc"]}
def kr(a):
    res=L(f"kr_{a}_1m.json")["result"]; k=[x for x in res if x!="last"][0]
    return {int(c[0]):(float(c[3]),float(c[2]),float(c[4])) for c in res[k]}
if __name__=="__main__":
    c,b,k=cb("BTC"),bs("BTC"),kr("BTC")
    for n,x in (("cb",c),("bs",b),("kr",k)): print(n,len(x),min(x),max(x))
    common=sorted(set(c)&set(b)&set(k)); print(len(common),common[0],common[-1])
    print("cb missing in range", [t for t in range(min(c),max(c)+1,60) if t not in c][:10])
    print("price sample", c[common[0]], c[common[-1]])

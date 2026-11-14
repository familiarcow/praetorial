#!/usr/bin/env python3
"""ONE-TIME fetch of public past candles (not used by tests; tests are offline). Writes fixtures/*.json + manifest.json (url, fetch time, sha256)."""
import json, hashlib, time, urllib.request, os, datetime, sys
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(D, exist_ok=True)
man = []
def get(name, url):
    req = urllib.request.Request(url, headers={"User-Agent": "praetorial-l1a-fixture-fetch/0.1"})
    body = urllib.request.urlopen(req, timeout=30).read()
    open(os.path.join(D, name), "wb").write(body)
    man.append({"file": name, "url": url, "fetched_utc": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)})
    time.sleep(0.5)
now = int(time.time()) // 60 * 60
iso = lambda t: datetime.datetime.utcfromtimestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ")
start = now - 11 * 3600
for asset in ("BTC", "ETH", "SOL"):
    for i in range(3):  # 3 pages x 220 min
        s, e = start + i * 220 * 60, start + (i + 1) * 220 * 60 - 1
        get(f"cb_{asset}_1m_p{i}.json", f"https://api.exchange.coinbase.com/products/{asset}-USD/candles?granularity=60&start={iso(s)}&end={iso(e)}")
    get(f"bs_{asset}_1m.json", f"https://www.bitstamp.net/api/v2/ohlc/{asset.lower()}usd/?step=60&limit=720")
    get(f"kr_{asset}_1m.json", f"https://api.kraken.com/0/public/OHLC?pair={'XBT' if asset=='BTC' else asset}USD&interval=1")
# 1h, BTC only (multi-day touch)
get("cb_BTC_1h.json", f"https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start={iso(now-290*3600)}&end={iso(now)}")
get("bs_BTC_1h.json", "https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=3600&limit=300")
get("kr_BTC_1h.json", "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60")
json.dump({"fetched_at_unix": now, "fetched_at_utc": iso(now), "files": man}, open(os.path.join(D, "manifest.json"), "w"), indent=1)
print(iso(now), len(man))

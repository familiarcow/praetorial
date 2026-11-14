"""J4: export R2 spike results as small offline regression fixtures (NO model calls).

Usage: python3 export_r2_fixtures.py <path-to-spikes/r2-corpus checkout>
Writes resolver/core/tests/fixtures/r2_quote_rejects.json and r2_regress.json.
The spike's pages (130MB) are NOT copied: each fixture carries only a window of page text around the quote.
"""
import glob, json, os, re, sys

SPIKE = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resolver", "core", "tests", "fixtures")
os.makedirs(OUT, exist_ok=True)

def rows(f):
    p = os.path.join(SPIKE, "results", f)
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []

cases = {}
for p in sorted(glob.glob(os.path.join(SPIKE, "cases", "*.jsonl"))):
    for l in open(p):
        if l.strip():
            c = json.loads(l); cases[c["id"]] = c

_pages = {}
def page(s):
    p = s["text_file"]
    if p not in _pages:
        _pages[p] = open(os.path.join(SPIKE, p), encoding="utf-8", errors="replace").read()
    return _pages[p]

def alnum_map(t):
    tl = t.lower()
    skip = set()
    for m in re.finditer(r"\[\d+\]|\[[a-z]\]|(?<=&)amp;", tl):
        skip.update(range(m.start(), m.end()))
    chars, idx = [], []
    for i, ch in enumerate(tl):
        if i not in skip and ch.isalnum():
            chars.append(ch); idx.append(i)
    return "".join(chars), idx

def window(text, quote, pad=300):
    """slice of `text` around where `quote` (alphanumerics-only) occurs; None if not on the page at all."""
    q, _ = alnum_map(quote)
    a, idx = alnum_map(text)
    k = a.find(q) if q else -1
    if k < 0:
        # longest alnum prefix of the quote that is on the page (for the must-stay-rejected cases)
        n = len(q)
        while n > 6 and a.find(q[:n]) < 0:
            n -= 1
        k = a.find(q[:n]) if n > 6 else -1
        if k < 0:
            return None, False
        s, e = idx[k], idx[min(k + n, len(idx)) - 1] + 1
        return text[max(0, s - pad): e + pad], False
    s, e = idx[k], idx[k + len(q) - 1] + 1
    return text[max(0, s - pad): e + pad], True

# ------------------------------------------------------------------ the 31 exact-rule quote rejects
rejects = []
for f in ("C", "C_v2", "C_v3"):
    for x in rows(f + ".jsonl"):
        if x["lane"] == "C" and x["res"] == "quote_reject":
            c = cases[x["case"]]
            src = next((s for s in c["sources"] if s["id"] == x.get("source_id")), c["sources"][0])
            w, full = window(page(src), x.get("quote") or "")
            rejects.append(dict(run=f, case=x["case"], model=x["model"], rep=x["rep"], answer=x["answer"], quote=x["quote"],
                                source_id=x.get("source_id"), page_window=w, r2_alnum_recovers=bool(full)))
json.dump(dict(rejects=rejects), open(os.path.join(OUT, "r2_quote_rejects.json"), "w"), indent=1, sort_keys=True)
print("rejects", len(rejects), "r2 alnum recovers", sum(r["r2_alnum_recovers"] for r in rejects))

# ------------------------------------------------------------------ lane A/B planted bugs (thinking-ON audit answers)
think = {}
for f in ("AB_think.jsonl", "A_think.jsonl", "B_think.jsonl", "final_overlay.jsonl"):
    for x in rows(f):
        if x["lane"] in "AB" and "__bug" in x["case"] and x["status"] == 200 and x["res"] in ("agree", "flag"):
            think[(x["case"], x["model"], x["rep"])] = x
planted = []
for cid, c in sorted(cases.items()):
    if "__bug" not in cid:
        continue
    audits = {m: [think[(cid, m, r)]["res"] for r in (0, 1, 2) if (cid, m, r) in think] for m in ("D", "G")}
    planted.append(dict(id=cid, lane=c["lane"], proposal=c["proposal"]["answer"], comparison=c["proposal"].get("comparison", ""),
                        question=c["question"], thinking_on_audits=audits))
print("planted", len(planted), "with both models", sum(1 for p in planted if p["thinking_on_audits"]["D"] and p["thinking_on_audits"]["G"]))

# ------------------------------------------------------------------ lane C adversarial + wording: scripted pair answers (final settings)
ov = {x["case"] for x in rows("final_overlay.jsonl") if x["lane"] == "C"}
byk = {}
for f in ("C_v3.jsonl", "final_overlay.jsonl"):
    for x in rows(f):
        if x["lane"] == "C" and x["status"] == 200 and (f == "final_overlay.jsonl" or x["case"] not in ov):
            byk[(x["case"], x["model"], x["rep"])] = x
fixes = json.load(open(os.path.join(SPIKE, "truth", "label_fixes.json")))  # R2 label corrections (README line 34)
final = {d["case"]: d for d in json.load(open(os.path.join(SPIKE, "results", "final_detail.json")))}

def scripted(x, c):
    raw = json.dumps({"answer": x["answer"], "quote": x.get("quote") or "", "source_id": x.get("source_id") or "", "reason": x.get("reason") or ""})
    return raw

lane_c = []
for cid, c in sorted(cases.items()):
    if c["lane"] != "C" or c.get("scope") != "judge" and not cid.startswith("w_"):
        continue
    kind = "adversarial" if c.get("adversarial") in (True, "True") else ("wording" if c.get("wording") else None)
    if kind is None or "liveonly" in cid:
        continue
    if (cid, "D", 0) not in byk or (cid, "G", 0) not in byk:
        continue
    rounds = []
    for r in (0, 1):
        if (cid, "D", r) in byk and (cid, "G", r) in byk:
            rounds.append({m: scripted(byk[(cid, m, r)], c) for m in ("D", "G")})
    wins = {}
    for r in (0, 1):
        for m in ("D", "G"):
            x = byk.get((cid, m, r))
            if x and x["answer"] in ("met", "not_met") and x.get("source_id"):
                src = next((s for s in c["sources"] if s["id"] == x["source_id"]), None)
                if src:
                    w, _ = window(page(src), x.get("quote") or "")
                    if w:
                        wins.setdefault(x["source_id"], [])
                        if w not in wins[x["source_id"]]:
                            wins[x["source_id"]].append(w)
    lane_c.append(dict(id=cid, kind=kind, question=c["question"], expected=fixes.get(cid, {}).get("new", c["expected"]), rounds=rounds,
                       sources=[dict(id=k, text="\n...\n".join(v)) for k, v in sorted(wins.items())],
                       r2_final=final.get(cid, {}).get("final"), r2_class=final.get(cid, {}).get("cls"),
                       wording_class=c.get("wording_class")))
print("lane C", len(lane_c), "adv", sum(1 for x in lane_c if x["kind"] == "adversarial"), "wording", sum(1 for x in lane_c if x["kind"] == "wording"))
json.dump(dict(planted=planted, lane_c=lane_c), open(os.path.join(OUT, "r2_regress.json"), "w"), indent=1, sort_keys=True)

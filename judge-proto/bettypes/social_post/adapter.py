import json, re, datetime as dt
from bettypes import harness as H
import judge as J

def parse_feed(body):
    d = json.loads(body); posts = []
    for f in d.get("feed", []):
        p = f["post"]; rec = p["record"]
        posts.append(dict(uri=p["uri"], text=rec.get("text", ""), created_at=rec.get("createdAt"), indexed_at=p.get("indexedAt"), reply="reply" in rec))
    return posts, d.get("cursor")

class Checker:
    def __init__(self, term):
        self.cfg = term["bettype"]; self.t = term["time"]
        assert len(self.cfg["phrase"]) >= 12, "phrase must be >=12 chars (the judge must quote it verbatim)"
    def prefilter(self, exhibits): return exhibits, None
    def __call__(self, term, q, sources):
        return self.x(sources) if self.cfg["platform"] == "x" else self.bsky(sources)
    # ---- bluesky: clock = server indexedAt (never author-set createdAt), top-level only, coverage proof for absence
    def bsky(self, sources):
        ph = J.norm(self.cfg["phrase"]); ws, we = self.t["window_start"], self.t["window_end"]; covered = None
        for s in sources:
            posts, cursor = parse_feed(H.split_text(s["text"])[1])
            for p in posts:
                if (not p["reply"]) and ph in J.norm(p["text"]) and ws <= p["indexed_at"] <= we:
                    return dict(answer="met", quote=self.cfg["phrase"], source_id=s["id"], reason="matching top-level post indexed in window")
            if cursor is None or any(p["indexed_at"] < ws for p in posts): covered = s
        if covered:
            return dict(answer="not_met", quote=H.safe_quote(covered["text"]), source_id=covered["id"], reason="feed covers the whole window; no qualifying post")
        return dict(answer="insufficient", reason="feed does not provably cover the window")
    # ---- X oEmbed: named URL only; date is DAY-granular, so window bounds must be day-aligned
    def x(self, sources):
        for s in sources:
            d = json.loads(H.split_text(s["text"])[1]); h = d["html"]
            m = re.search(r">([A-Z][a-z]+ \d{1,2}, \d{4})</a>", h)
            day = dt.datetime.strptime(m.group(1), "%B %d, %Y").strftime("%Y-%m-%dT00:00:00Z") if m else None
            same_url = d["url"].replace("twitter.com", "x.com") == self.cfg["tweet_url"]
            if same_url and day and self.t["window_start"] <= day < self.t["window_end"] and J.norm(self.cfg["phrase"]) in J.norm(h):
                return dict(answer="met", quote=self.cfg["phrase"], source_id=s["id"], reason="named tweet exists, day inside window, text matches")
        return dict(answer="not_met", quote=H.safe_quote(sources[0]["text"]), source_id=sources[0]["id"], reason="named tweet does not satisfy the element") if sources else dict(answer="insufficient", reason="no source")

def make_checker(term): return Checker(term)

import json, re
from bettypes import harness as H

def parse_releases(body):
    d = json.loads(body)
    assert isinstance(d, list), "releases endpoint must return a JSON list"
    return d

class Checker:
    def __init__(self, term):
        self.cfg = term["bettype"]; self.pin = term["repo_pin"]; self.t = term["time"]; self.rx = re.compile(self.cfg["tag_pattern"])
    def prefilter(self, exhibits):
        """Repo identity is the numeric id (rename/transfer/name-squat safe): an exhibit fetched from any other repo is dropped."""
        ok = [e for e in exhibits if ("repositories/%d/" % self.pin["repo_id"]) in H.split_text(e["text"])[0]]
        return ok, None
    def qualifies(self, r):
        return (bool(self.rx.fullmatch(r["tag_name"])) and not r["draft"] and not r["prerelease"]
                and self.t["window_start"] <= (r.get("published_at") or "") <= self.t["window_end"])
    def __call__(self, term, q, sources):
        complete = None
        for s in sources:
            header, body = H.split_text(s["text"])
            if "git/matching-refs" in header: continue                     # a bare tag is not a Release object
            rels = parse_releases(body)
            for r in rels:
                if self.qualifies(r):
                    return dict(answer="met", quote='"published_at": "%s"' % r["published_at"], source_id=s["id"], reason="qualifying published release")
            m = re.search(r"per_page=(\d+)", header)
            if len(rels) < int(m.group(1) if m else 30): complete = s       # a short page is the whole list
        if complete:
            return dict(answer="not_met", quote=H.safe_quote(complete["text"]), source_id=complete["id"], reason="complete release list has no qualifying release")
        return dict(answer="insufficient", reason="release list page is full; cannot prove absence")
def make_checker(term): return Checker(term)

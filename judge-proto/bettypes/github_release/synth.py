import json
RID = 65600975
def _url(rid=RID, per_page=100): return "https://api.github.com/repositories/%d/releases?per_page=%d" % (rid, per_page)
def raw(status, ct, body): return dict(url=_url(), status=status, content_type=ct, body=body)
def releases(rels, status=200, repo_id=RID):
    out = []
    for r in rels:
        o = {"tag_name": r["tag"], "name": "Release " + r["tag"], "draft": r.get("draft", False), "prerelease": r.get("prerelease", False),
             "created_at": r["created"], "published_at": r["published"], "html_url": "https://github.com/pytorch/pytorch/releases/tag/" + r["tag"], "target_commitish": "main"}
        if r.get("body"): o["body"] = r["body"]
        out.append(o)
    return dict(url=_url(repo_id), status=status, content_type="application/json; charset=utf-8", body=json.dumps(out, indent=1))
def tag_ref(tag):
    return dict(url="https://api.github.com/repositories/%d/git/matching-refs/tags/%s" % (RID, tag[:4]), status=200, content_type="application/json; charset=utf-8",
                body=json.dumps([{"ref": "refs/tags/" + tag, "object": {"type": "commit", "sha": "31a77fc9c0a7c6fff15a1ff58c743f53b1a9d457"}}], indent=1))

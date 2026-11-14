"""Synthetic fixtures in the exact shape of the recorded live Bluesky / X-oEmbed responses."""
import json
BSKY = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:z72i7hdynmk6r22z27h6tvur&filter=posts_no_replies&limit=50"
def raw(status, ct, body): return dict(url=BSKY, status=status, content_type=ct, body=body)
def bsky_feed(posts, more_pages=False):
    feed = []
    for i, p in enumerate(posts):
        rec = {"$type": "app.bsky.feed.post", "text": p["text"], "createdAt": p["created_at"]}
        if p.get("reply"): rec["reply"] = {"parent": {"uri": "at://did:plc:x/app.bsky.feed.post/parent"}}
        feed.append({"post": {"uri": "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3m%04d" % i, "record": rec, "indexedAt": p["indexed_at"]}})
    body = {"feed": feed}
    if more_pages: body["cursor"] = "2026-11-02T20:00:00.000Z"
    return dict(url=BSKY, status=200, content_type="application/json; charset=utf-8", body=json.dumps(body, indent=1))
def x_oembed(handle, tid, text, date):
    h = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">%s</p>&mdash; %s (@%s) <a href="https://x.com/%s/status/%s?ref_src=twsrc%%5Etfw">%s</a></blockquote>' % (text, handle, handle, handle, tid, date)
    body = {"url": "https://x.com/%s/status/%s" % (handle, tid), "author_name": handle, "author_url": "https://x.com/" + handle, "html": h}
    return dict(url="https://publish.twitter.com/oembed?url=https://twitter.com/%s/status/%s&omit_script=1" % (handle, tid), status=200,
                content_type="application/json; charset=utf-8", body=json.dumps(body, indent=1))

"""Shared harness for bet-type prototypes. Runs the REAL engine code paths (J.lint, E.classify_blocked_fetch,
E.admit, J.build_messages, J.verify, J.element_verdict, J.decide, E.resolve_with_recovery) with ONE seam replaced:
J.call, the model call, is a deterministic adapter-supplied checker (no model spend, no network). The checker must
return the same JSON the real judge returns, and its quote must be verbatim in the exhibit, or J.verify rejects it.
This proves term-sheet shape, fetch classification, admission, evidence shaping and decision plumbing -- NOT LLM
reading comprehension (that needs a separate, paid, cached model run)."""
import json, os, re, subprocess, sys, html
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # judge-proto/
import judge as J
import evidence as E
E.MODELS, E.RUNS = ["stub:deterministic"], 1

def load_term(here, name): return json.load(open(os.path.join(here, name)))
def load_fx(here, rel): return json.load(open(os.path.join(here, rel)))
def with_deadline(term, deadline):
    t = json.loads(json.dumps(term)); t["time"]["window_end"] = deadline; return t
def assert_eq(a, b): assert a == b, "%r != %r" % (a, b)
def assert_true(x, msg=""): assert x, msg or repr(x)

def live_fetch(url):
    r = subprocess.run(["curl", "-sL", "-m", "25", "-A", "praetorial-probe/0.1 (research)", "-w", "\n%{http_code}\t%{content_type}", url], capture_output=True, text=True)
    body, _, tail = r.stdout.rpartition("\n"); code, _, ct = tail.partition("\t")
    return dict(url=url, status=int(code or 0), content_type=ct, body=body)

def ex_from_fx(fx, id_, by, publisher, captured_at, expect_json=True):
    """Fixture -> (exhibit | None, blocked_reason). Mirrors the resolver: classify_blocked_fetch first (D-FETCH2);
    a blocked/broken fetch never becomes evidence (COULDNT_CHECK), so it can never read as NO."""
    reason = E.classify_blocked_fetch(fx["status"], fx["content_type"], fx["body"].encode(), expect_json=expect_json)
    if reason: return None, reason
    header = "GET %s -> HTTP %d %s captured %s" % (fx["url"], fx["status"], fx["content_type"].split(";")[0], captured_at)
    text = header + "\n\n" + fx["body"]
    assert len(text) <= E.MAX_EXCERPT_CHARS, "fixture too large for one exhibit (%d chars)" % len(text)
    return dict(id=id_, by=by, publisher=publisher, published=captured_at, submitted=captured_at,
                onchain_submitted_at=captured_at, text=text, archived_text=text), None

def split_text(text):
    header, _, body = text.partition("\n\n"); return header, body
def safe_quote(text): return split_text(text)[0]            # always >=12 chars, always verbatim
def line_quote(text, contains):
    for ln in text.splitlines():
        if contains in ln and len(ln.strip()) >= 12: return ln.strip()
    return safe_quote(text)

_SRC = re.compile(r'<source id="(.*?)" publisher="(.*?)" published="(.*?)" sha256="[0-9a-f]*"[^>]*>\n(.*?)\n</source>', re.S)
def _sources(user):
    return [dict(id=m[0], publisher=html.unescape(m[1]), published=m[2], text=html.unescape(m[3])) for m in _SRC.findall(user)]

def resolve(term, exhibits, checker, now, first_unavailable_at=None, briefs=None):
    exhibits = [e for e in exhibits if e]
    kept, override = checker.prefilter(exhibits)
    if override: return dict(outcome=override, why="adapter pre-check", rejected=[])
    def stub_call(model, messages, key=None, attempts=3):
        q = re.search(r"Question: (.*)", messages[1]["content"]).group(1)
        return json.dumps(checker(term, q, _sources(messages[1]["content"]))), "stub"
    orig, J.call = J.call, stub_call
    try:
        return E.resolve_with_recovery(term, kept, term["window_close"], now, first_unavailable_at, briefs)
    finally:
        J.call = orig

def prompt_for(term, exhibits):
    admitted, _ = E.admit(term, [e for e in exhibits if e], term["window_close"])
    return J.build_messages(term, term["elements"][0], admitted)[1]["content"]

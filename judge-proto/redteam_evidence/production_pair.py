"""RTE4 / D-RTE4: ONE shared production-pair judge call path (used by measure_production_pair.py AND the
test_redteam_evidence.py JUDGE cases).

Production pair (chain index 0): deepseek-ai/DeepSeek-V4.1-Flash-1017 + z-ai/glm-5.3-flash, messages built by the
Rust resolver core (build_messages_at via resolver/core/examples/dump_messages.rs), temperature 0, max_tokens 8192,
json_object, thinking = model default, no seed, no cache. Pair rule: both models must agree; disagreement is
'unresolved' (-> RETRY), which is NOT an expected outcome of any case, so it is a red, never retried.

NEAR_AI_API_KEY comes from the environment, falling back to $PRAETORIAL_SECRETS_DIR/praetorial-nearai.env (operator secrets dir; never printed).
HTTP 402 / insufficient / credit / quota / limit exceeded (not 429) => CreditsExhausted; 429 and other errors back off.
"""
import sys, os, json, time, subprocess, threading, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE)); sys.path.insert(0, HERE)
_argv = sys.argv[:]; sys.argv = sys.argv[:1]   # evidence.py reads sys.argv[1] at import
import judge as J, evidence as E
sys.argv = _argv

STREAM_MAX_ATTEMPTS = 2   # RTE4c: == resolver/wasm-bin/src/main.rs `pub const STREAM_MAX_ATTEMPTS` (verified by test_rte4c_replay); empty-stream TRANSPORT retry only, never a verdict retry
PAIR = ("deepseek-ai/DeepSeek-V4.1-Flash-1017", "z-ai/glm-5.3-flash")
ROOT = os.path.dirname(os.path.dirname(HERE))
DUMP = os.path.join(ROOT, "resolver", "target", "debug", "examples", "dump_messages")
CALL_URL = J.API
EXHAUSTED = threading.Event()
SECRETS = os.path.join(os.environ.get("PRAETORIAL_SECRETS_DIR") or "<PRAETORIAL_SECRETS_DIR unset>", "praetorial-nearai.env")
_built = threading.Lock(); _built_done = []

class PairInfraError(Exception):
    """No usable response from a production-pair model after retries (not a defence verdict)."""
class PairEmptyReply(PairInfraError):
    """Reply still empty after the production-mirroring transport retry (INFRA, never a verdict)."""
class CreditsExhausted(PairInfraError):
    """NEAR AI credits/quota exhausted (402 / insufficient / credit / quota / limit exceeded)."""

def api_key():
    k = os.environ.get("NEAR_AI_API_KEY")
    if k: return k
    if not os.path.isfile(SECRETS): raise PairInfraError("NEAR_AI_API_KEY not in env and no key file at " + SECRETS)
    for line in open(SECRETS):
        if line.startswith("NEAR_AI_API_KEY="): return line.split("=", 1)[1].strip().strip('"')
    raise PairInfraError("NEAR_AI_API_KEY not in env or " + SECRETS)

def example_path(name):
    return os.path.join(ROOT, "resolver", "target", "debug", "examples", name)

def build_rust(name="dump_messages"):
    with _built:
        if name in _built_done: return
        r = subprocess.run(["cargo", "build", "--example", name], cwd=os.path.join(ROOT, "resolver", "core"), capture_output=True, text=True)
        if r.returncode: raise PairInfraError("cargo build failed: " + r.stderr[-500:])
        _built_done.append(name)

def rust_messages(ts, el, srcs, as_of):
    inp = json.dumps(dict(ts=ts, element=el, sources=[dict(id=s["id"], publisher=s["publisher"], published=s["published"], text=s["text"]) for s in srcs], as_of=as_of))
    out = subprocess.run([DUMP], input=inp, capture_output=True, text=True, check=True).stdout
    return [dict(role=r, content=c) for r, c in json.loads(out)]

def post(model, messages):
    """-> (raw, err). Retries with backoff (429 included); stops at once on credit exhaustion.
    RTE4c: an EMPTY completion is retried (transport retry, mirrors wasm-bin verified_stream_call: STREAM_MAX_ATTEMPTS
    total attempts, 'stream ended without ... content'); still empty after that -> returns ("", None) = INFRA to the caller."""
    raw, err = "", None
    for _ in range(STREAM_MAX_ATTEMPTS):
        raw, err = _post_once(model, messages)
        if raw is None or raw.strip(): return raw, err
    return raw, err

def _post_once(model, messages):
    body = json.dumps({"model": model, "temperature": 0, "max_tokens": 8192, "response_format": {"type": "json_object"}, "messages": messages}).encode()
    key = api_key(); delay = 5
    for attempt in range(6):
        if EXHAUSTED.is_set(): return None, "aborted"
        if J.spent_usd() >= J.SPEND_CAP_USD:
            EXHAUSTED.set(); return None, "spend cap"
        req = urllib.request.Request(CALL_URL, body, {"Authorization": "Bearer " + key, "content-type": "application/json"})
        try:
            d = json.load(urllib.request.urlopen(req, timeout=240))
            J.log_spend(model, d.get("usage") or {})
            return (d["choices"][0]["message"]["content"] or ""), None
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "replace")[:500]
            low = txt.lower()
            if e.code == 402 or (e.code != 429 and any(k in low for k in ("insufficient", "credit", "quota", "limit exceeded"))):
                EXHAUSTED.set(); return None, "CREDITS %s %s" % (e.code, txt[:120])
            time.sleep(delay); delay = min(delay * 2, 60)
        except Exception:
            time.sleep(delay)
    return None, "failed"

def collect_raws(term, admitted, claims, as_of, deadline=None):
    """Model calls only (no decision logic): per element, per tier, one raw completion per PAIR model.
    -> ({element id: {str(tier): [raw per model in PAIR order]}}, [raw records]) or None on deadline."""
    build_rust(); raws = {}; recs = []
    tiers = sorted({a["tier"] for a in admitted})
    for el in term["elements"]:
        for t in tiers:
            srcs = [a for a in admitted if a["tier"] == t]
            msgs = rust_messages(term, el, srcs, as_of)
            rel = [c for c in claims if c["exhibit"] in {s["id"] for s in srcs}]
            msgs[1]["content"] = msgs[1]["content"].replace("\n\nReturn the JSON object now.", E.claims_block(rel) + "\n\nReturn the JSON object now.")
            for m in PAIR:
                if deadline and time.time() > deadline: return None
                raw, err = post(m, msgs)
                if raw is None:
                    if EXHAUSTED.is_set() and err and err.startswith("CREDITS"): raise CreditsExhausted(err)
                    raise PairInfraError("production pair model %s: %s (element %s)" % (m, err, el["id"]))
                if not raw.strip(): raise PairEmptyReply("production pair model %s returned no response (element %s)" % (m, el["id"]))
                raws.setdefault(el["id"], {}).setdefault(str(t), []).append(raw)
                recs.append(dict(tier=t, model=m, raw=raw, element=el["id"]))
    return raws, recs

def case_inputs(case):
    """admit -> check_claims -> as_of, exactly as the harness does."""
    term = case["term"]; wc = case.get("window_close", "2028-01-10T00:00:00Z")
    admitted, _ = E.admit(term, case["exhibits"], wc)
    claims, _ = E.check_claims(case.get("briefs", []), admitted)
    return term, admitted, claims, J.iso_to_unix(wc)   # D-EXH1a: job request time (case window_close), never exhibit text

def decide_from_raws(term, admitted, claims, as_of, raws):
    """THE one decision implementation (RTE4b / D-RTE4a): the Rust resolver path via
    resolver/core/examples/decide_element.rs (judge_element_tiered_at + decide + 'insufficient stays insufficient' +
    map_decision_outcome ESCALATE->VOID). raws: {element id: {str(tier): [raw per model]}}.
    -> dict(verdicts, outcome (escrow-legal YES/NO/VOID), outcome_raw, why)."""
    build_rust("decide_element")
    inp = json.dumps(dict(ts=term, admitted=admitted, claims=claims, as_of=as_of, raws=raws))
    r = subprocess.run([example_path("decide_element")], input=inp, capture_output=True, text=True)
    if r.returncode: raise PairInfraError("decide_element failed: " + r.stderr[-500:])
    return json.loads(r.stdout)

def single_origin(admitted):
    """True when NO tier's admitted exhibits span >= 2 derived origins: tiers are judged in isolation (judge_element_tiered)
    and a decisive verdict needs >= 2 origins inside the deciding tier (17d2a / R3 D-JUDGE4), so no decisive outcome is reachable."""
    for t in {a["tier"] for a in admitted}:
        if len(set(J.origin_groups([a for a in admitted if a["tier"] == t]))) >= 2: return False
    return True

def pair_resolve_case(case, deadline=None):
    """Production-pair resolve: model calls (collect_raws) -> Rust decision (decide_from_raws), pair together and each
    model alone. -> dict(outcome, outcome_raw, why, verdicts, model_verdicts, model_outcomes, raws, rust_inputs) or None on deadline."""
    term, admitted, claims, as_of = case_inputs(case)
    got = collect_raws(term, admitted, claims, as_of, deadline)
    if got is None: return None
    raws, recs = got
    pair = decide_from_raws(term, admitted, claims, as_of, raws)
    per = {}
    for i, m in enumerate(PAIR):
        per[m] = decide_from_raws(term, admitted, claims, as_of, {e: {t: [l[i]] for t, l in d.items()} for e, d in raws.items()})
    for rec in recs:
        rec["answer"] = J.verify(rec["raw"], [a for a in admitted if a["tier"] == rec["tier"]], "")[0]
    return dict(outcome=pair["outcome"], outcome_raw=pair["outcome_raw"], why=pair["why"], verdicts=pair["verdicts"],
                model_verdicts={m: per[m]["verdicts"] for m in PAIR}, model_outcomes={m: per[m]["outcome"] for m in PAIR},
                raws=recs, rust_inputs=dict(term=term, admitted=admitted, claims=claims, as_of=as_of, raws=raws))

# ---------------------------------------------------------------- RTE4c: offline replay of recorded production-pair raw answers
REPLAY_DIR = os.path.join(HERE, "replay")

def inputs_sha256(term, admitted, claims, as_of):
    import hashlib
    return hashlib.sha256(json.dumps(dict(ts=term, admitted=admitted, claims=claims, as_of=as_of), sort_keys=True).encode()).hexdigest()

def replay_resolve_case(case):
    """RTE4c / D-RTE4b: the fast gate's production-pair call. NO network, NO key: loads the committed recorded raw answers
    for this case (replay/<case>.json), checks they were recorded for the SAME inputs, and decides through the same shared
    Rust function (decide_from_raws). Same return shape as pair_resolve_case."""
    term, admitted, claims, as_of = case_inputs(case)
    p = os.path.join(REPLAY_DIR, case["name"] + ".json")
    if not os.path.isfile(p): raise FileNotFoundError("no replay fixture for case %s (record with record_replay.py)" % case["name"])
    fx = json.load(open(p))
    if fx["inputs_sha256"] != inputs_sha256(term, admitted, claims, as_of):
        raise ValueError("replay fixture for %s is stale: the case inputs changed since it was recorded (re-record)" % case["name"])
    raws = fx["raws"]
    pair = decide_from_raws(term, admitted, claims, as_of, raws)
    per = {}
    for i, m in enumerate(PAIR):
        per[m] = decide_from_raws(term, admitted, claims, as_of, {e: {t: [l[i]] for t, l in d.items()} for e, d in raws.items()})
    recs = [dict(tier=int(t), model=m, raw=l[i], element=e) for e, d in raws.items() for t, l in d.items() for i, m in enumerate(PAIR)]
    return dict(outcome=pair["outcome"], outcome_raw=pair["outcome_raw"], why=pair["why"], verdicts=pair["verdicts"],
                model_verdicts={m: per[m]["verdicts"] for m in PAIR}, model_outcomes={m: per[m]["outcome"] for m in PAIR},
                raws=recs, rust_inputs=dict(term=term, admitted=admitted, claims=claims, as_of=as_of, raws=raws))

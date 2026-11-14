#!/usr/bin/env python3
"""RTE4c / D-RTE4b: the fast production-pair redteam step is OFFLINE and replays committed, hashed fixtures.

Tests (names for the DONE line; any failure -> exit 1, never skipped):
  rte4c_fast_step_makes_zero_network_calls   runs test_redteam_evidence.py (default = replay backend) in a child whose
                                             sockets/DNS are blocked, NEAR_AI_API_KEY is unset and the secrets file is
                                             unreadable; child must exit 0 and never touch the network or the key.
  rte4c_replay_manifest_sha256_provenance    replay/MANIFEST.json lists EVERY replay fixture with sha256, run id, model
                                             ids (the production pair), UTC time; hashes match; every JUDGE case has a
                                             fixture whose inputs hash still matches the case.
  rte4c_empty_reply_maps_insufficient_to_void a recorded EMPTY glm reply replays to VOID (never NO, never YES).
"""
import sys, os, json, re, hashlib, subprocess, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
REPLAY = os.path.join(HERE, "replay")
FAILS = []

def check(name, ok, detail=""):
    print("%-48s %-4s %s" % (name, "PASS" if ok else "FAIL", detail[:300]))
    if not ok: FAILS.append(name)

BLOCK = '''
import socket, builtins, os
_m = os.environ["RTE4C_NET_MARKER"]
def _hit(what):
    open(_m, "a").write(what + "\\n")
    raise OSError("RTE4c: network/credential access is forbidden in the offline fast step: " + what)
class _S(socket.socket):
    def connect(self, *a, **k): _hit("connect %r" % (a,))
    def connect_ex(self, *a, **k): _hit("connect_ex %r" % (a,))
socket.socket = _S
socket.create_connection = lambda *a, **k: _hit("create_connection %r" % (a,))
socket.getaddrinfo = lambda *a, **k: _hit("getaddrinfo %r" % (a,))
_open = builtins.open
def _guard(f, *a, **k):
    if "praetorial-nearai" in str(f): _hit("open secrets file")
    return _open(f, *a, **k)
builtins.open = _guard
'''

def test_zero_network():
    d = tempfile.mkdtemp(prefix="rte4c_")
    open(os.path.join(d, "sitecustomize.py"), "w").write(BLOCK)
    marker = os.path.join(d, "marker"); open(marker, "w").close()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("NEAR_AI", "NEARAI", "RTE_JUDGE"))}
    env.update(PYTHONPATH=d + os.pathsep + env.get("PYTHONPATH", ""), RTE4C_NET_MARKER=marker)
    r = subprocess.run([sys.executable, os.path.join(HERE, "test_redteam_evidence.py")], cwd=HERE, env=env, capture_output=True, text=True, timeout=540)
    hits = open(marker).read().strip()
    out = r.stdout + r.stderr
    ok = r.returncode == 0 and not hits and not re.search(r"^\S+\s+INFRA", out, re.M)
    check("rte4c_fast_step_makes_zero_network_calls", ok, "exit=%s network_hits=%r tail=%r" % (r.returncode, hits[:150], out[-200:]))

def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()

def inputs_sha(case):
    import production_pair as PP
    term, admitted, claims, as_of = PP.case_inputs(case)
    return hashlib.sha256(json.dumps(dict(ts=term, admitted=admitted, claims=claims, as_of=as_of), sort_keys=True).encode()).hexdigest()

def test_manifest():
    import production_pair as PP, test_redteam_evidence as T
    problems = []
    mp = os.path.join(REPLAY, "MANIFEST.json")
    if not os.path.isfile(mp):
        check("rte4c_replay_manifest_sha256_provenance", False, "replay/MANIFEST.json missing"); return
    man = json.load(open(mp))["fixtures"]
    on_disk = sorted(f for f in os.listdir(REPLAY) if f.endswith(".json") and f != "MANIFEST.json")
    if sorted(man) != on_disk: problems.append("manifest/disk mismatch: %s" % sorted(set(man) ^ set(on_disk)))
    for f, m in man.items():
        p = os.path.join(REPLAY, f)
        if not os.path.isfile(p): continue
        if m.get("sha256") != sha(p): problems.append("%s sha256 mismatch" % f)
        if not m.get("run_id"): problems.append("%s no run_id" % f)
        if sorted(m.get("model_ids") or []) != sorted(PP.PAIR): problems.append("%s model_ids != production pair" % f)
        if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", m.get("recorded_utc") or ""): problems.append("%s recorded_utc not UTC ISO" % f)
    cases = {c["name"]: c for c in T._judge_cases()}
    for name, c in cases.items():
        fx = "%s.json" % name
        if fx not in man: problems.append("no replay fixture for JUDGE case " + name); continue
        d = json.load(open(os.path.join(REPLAY, fx)))
        if d.get("case") != name or d.get("inputs_sha256") != inputs_sha(c): problems.append("%s fixture stale vs case inputs" % name)
        if d.get("provenance", {}).get("run_id") != man[fx].get("run_id"): problems.append("%s run_id differs from manifest" % name)
    check("rte4c_replay_manifest_sha256_provenance", not problems, "fixtures=%d %s" % (len(man), "; ".join(problems)))

def test_empty_reply():
    import production_pair as PP, attacks as A
    fx = os.path.join(REPLAY, "empty_reply_mk_base64_encoded_instruction.json")
    if not os.path.isfile(fx):
        check("rte4c_empty_reply_maps_insufficient_to_void", False, "empty-reply fixture missing"); return
    d = json.load(open(fx))
    flat = [r for el in d["raws"].values() for t in el.values() for r in t]
    case = next(c for c in A.INJECTION if c["name"] == "mk_base64_encoded_instruction")
    term, admitted, claims, as_of = PP.case_inputs(case)
    res = PP.decide_from_raws(term, admitted, claims, as_of, d["raws"])
    ok = any(not r.strip() for r in flat) and res["outcome"] == "VOID" and res["outcome"] not in ("NO", "YES")
    check("rte4c_empty_reply_maps_insufficient_to_void", ok, "has_empty=%s outcome=%r outcome_raw=%r verdicts=%r" % (any(not r.strip() for r in flat), res["outcome"], res.get("outcome_raw"), res.get("verdicts")))

def test_transport_retry():
    import production_pair as PP
    src = open(os.path.join(HERE, "..", "..", "resolver", "wasm-bin", "src", "main.rs")).read()
    m = re.search(r"pub const STREAM_MAX_ATTEMPTS: u32 = (\d+);", src)
    bound_ok = bool(m) and int(m.group(1)) == PP.STREAM_MAX_ATTEMPTS
    calls = []
    def seq(*vals):
        it = iter(vals)
        def f(model, msgs): calls.append(1); return next(it)
        return f
    saved = PP._post_once
    try:
        PP._post_once = seq(("", None), ("", None), ("never", None)); r1 = PP.post("m", []); n1 = len(calls); calls.clear()
        PP._post_once = seq(("", None), ("ok", None)); r2 = PP.post("m", []); n2 = len(calls); calls.clear()
        PP._post_once = seq(("v1", None), ("v2", None)); r3 = PP.post("m", []); n3 = len(calls)
    finally: PP._post_once = saved
    check("rte4c_empty_transport_retry_bound_matches_wasm_bin", bound_ok and r1[0] == "" and n1 == PP.STREAM_MAX_ATTEMPTS and r2[0] == "ok" and n2 == 2 and r3[0] == "v1" and n3 == 1,
          "wasm-bin STREAM_MAX_ATTEMPTS=%s harness=%s calls(empty,empty)=%d (empty,ok)=%d (ok)=%d" % (m and m.group(1), PP.STREAM_MAX_ATTEMPTS, n1, n2, n3))

if __name__ == "__main__":
    test_transport_retry(); test_zero_network(); test_manifest(); test_empty_reply()
    sys.exit(1 if FAILS else 0)

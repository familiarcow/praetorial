#!/usr/bin/env python3
"""REPORT.md from examples.json + actual.json (actual.json is written by `L1_WRITE=1 cargo test l1a_examples` in resolver/wasm-bin)."""
import json, os
H = os.path.dirname(os.path.abspath(__file__))
ex = json.load(open(f"{H}/examples.json"))["examples"]; ac = {a["id"]: a for a in json.load(open(f"{H}/actual.json"))}
rows = []; npass = 0
for e in ex:
    a = ac[e["id"]]; npass += a["pass"]
    exp = e["expected"] if e["expected"] != "REJECT" else "REJECT:" + e["reject_code"]
    rows.append(f"| {e['id']}{' (SYNTH)' if e.get('synthetic') else ''}{' **[L1b]**' if e.get('l1b') else ''} | {e['phrasing'][:90].replace('|','/')} | {exp} | {a['actual']} | {a['path']} | {'PASS' if a['pass'] else 'RED'} |")
open(f"{H}/REPORT.md", "w").write(f"""# L1a: crypto-price example set, offline replay through the CURRENT resolver (f298d82)

{len(ex)} examples, {npass} PASS, {len(ex)-npass} RED. Recorded fixtures only (fixtures/manifest.json: url, fetch time, sha256). No network, no NEAR AI.
Test: `resolver/wasm-bin/src/item_l1a_tests.rs` (`cargo test l1a` in resolver/wasm-bin); regenerate with `python3 -I gen_examples.py`.
Paths: **code** = typed template decided by code (judge only audits); **AI** = custom/Jason-form sheet, judge reply is a RECORDED hand-written constant (so these test the resolver's gates and verbatim-quote check, not a model); **builder-reject** = materialize/open/relative-date checks refuse the sheet.

| id | phrasing | expected | actual | path | result |
|---|---|---|---|---|---|
""" + "\n".join(rows) + """

## L1b candidates (live testnet run)
""" + "\n".join(f"- `{e['id']}`: {e['l1b']}" for e in ex if e.get("l1b")) + """

## Finding (not in the merged set): custom Jason-form YES rests entirely on the judge
See FINDING.md. Probe `probe_adversarial_judge_met_one_venue` (side branch `feat/l1a-red-adversarial-judge`, RED): a judge reply `met` citing only the Bitstamp row for a level Coinbase never reached makes the resolver sign YES. Typed templates are not affected (code decides).
""")
print(npass, len(ex))

// usage: node extract_17c2.mjs <raw.json> <out.json> : pull the probe-sources JSON out of the tx result and stamp tx hash + wasm hash.
import fs from "node:fs";
const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const o of r.receipts_outcome) {
  const v = o.outcome.status.SuccessValue;
  if (!v) continue;
  const s = Buffer.from(v, "base64").toString();
  if (!s.startsWith('{"group"')) continue;
  const j = JSON.parse(s);
  j.tx_hash = r.transaction.hash;
  j.probe_wasm_sha256 = "ea72a347fc8af02107b65ac859863d53f4cb43b6d862a92335715a52ea491cb9";
  j.built_from_commit = "157f267 (features real-http,probe-sources)";
  fs.writeFileSync(process.argv[3], JSON.stringify(j, null, 1));
  console.log(JSON.stringify(j));
}

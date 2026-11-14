import fs from "node:fs";
const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const outs = r.receipts_outcome || [];
console.log("txhash", r.transaction.hash, "receipts", outs.length);
for (const o of outs) {
  const st = o.outcome.status;
  const v = st.SuccessValue;
  if (v) { const s = Buffer.from(v, "base64").toString(); console.log(o.outcome.executor_id, "SuccessValue len", s.length, s.slice(0, 120)); if (s.length > 1000) fs.writeFileSync(process.argv[3], s); }
}

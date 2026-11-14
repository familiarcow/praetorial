import fs from "node:fs";
const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).result;
if (!r) { console.log("no result", fs.readFileSync(process.argv[2],"utf8").slice(0,300)); process.exit(); }
console.log("status", Object.keys(r.status)[0], "receipts", r.receipts_outcome.length);
for (const o of r.receipts_outcome) {
  const lg = o.outcome.logs.map(l => l.slice(0, 200));
  console.log(o.outcome.executor_id, Object.keys(o.outcome.status)[0], "gas", o.outcome.gas_burnt, lg.length ? JSON.stringify(lg) : "");
}

const [h, a] = process.argv.slice(2);
const d = (await (await fetch(process.env.NEAR_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: [h, a] }) })).json()).result;
for (const r of d.receipts_outcome) console.log(r.id.slice(0, 8), r.outcome.executor_id, r.outcome.gas_burnt, JSON.stringify(r.outcome.logs).slice(0, 300), JSON.stringify(r.outcome.status).slice(0, 600));

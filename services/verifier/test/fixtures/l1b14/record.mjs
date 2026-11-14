// L1b14 recorder: like v1c/record.mjs but keeps EVERY tx touching the account (deploy/create/delete too, needed to find the current incarnation).
// usage: node record.mjs <network testnet|mainnet> <escrow> <bet_id> <out.json>
// Sources: plain NEAR RPC (views, view_account) + FastNEAR tx-history indexer (tx.<net>.fastnear.com /v0/account, /v0/transactions).
import { writeFileSync } from "node:fs";
const [network, escrow, bet, out] = process.argv.slice(2);
const RPC = network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com";
const IDX = network === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com";
const post = async (url, body) => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1000 * 2 ** i)); continue; }
    return r.json();
  }
  throw new Error("retries exhausted " + url);
};
const rpc = {};
const query = async (params, key) => { const j = await post(RPC, { jsonrpc: "2.0", id: "r", method: "query", params: { finality: "final", account_id: escrow, ...params } }); rpc[key] = j.result; };
const view = (m, a = {}) => query({ request_type: "call_function", method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") }, `call_function|${m}|${JSON.stringify(a)}`);
await query({ request_type: "view_account" }, "view_account||");
for (const m of ["resolver_keys", "outlayer_config", "is_shutdown"]) await view(m);
for (const m of ["get_bet", "pending_payouts"]) await view(m, { bet_id: Number(bet) });
const accountTxs = []; let resume;
do {
  const j = await post(`${IDX}/v0/account`, { account_id: escrow, limit: 200, ...(resume ? { resume_token: resume } : {}) });
  accountTxs.push(...j.account_txs); resume = j.resume_token && j.account_txs.length ? j.resume_token : undefined;
} while (resume);
const hashes = [...new Set(accountTxs.map((t) => t.transaction_hash))];
const transactions = {};
for (let i = 0; i < hashes.length; i += 5) {
  const j = await post(`${IDX}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 5) });
  for (const t of j.transactions) transactions[t.transaction.hash] = t;
}
writeFileSync(out, JSON.stringify({ network, escrow, bet: Number(bet), recorded_at: new Date().toISOString(), rpc, accountTxs, transactions }, null, 1));
console.log("recorded", Object.keys(rpc).length, "rpc,", accountTxs.length, "account txs,", Object.keys(transactions).length, "txs");

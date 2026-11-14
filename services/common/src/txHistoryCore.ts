// Host-neutral tx-history fetch (shared by the node verifier/indexer and the CF1d indexer Worker): no node:* / Buffer / process.
// FastNEAR tx indexer paging + dedupe + block-time ordering; the caller supplies the base URL.
export interface LiveDeps { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; /** retry attempts per request (default 6; a Worker invocation uses 1) */ attempts?: number }

/** u64 ns timestamps exceed 2^53: keep their digits by quoting them before JSON.parse. */
const quoteBig = (t: string) => t.replace(/"(block_timestamp|tx_block_timestamp)":\s*(\d{16,})/g, '"$1":"$2"');

export async function postJson(url: string, body: unknown, d: LiveDeps): Promise<any> {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = "";
  for (let i = 0; i < (d.attempts ?? 6); i++) {
    try {
      const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (r.status === 429 || r.status >= 500) { last = `HTTP ${r.status}`; await sleep(Math.min(1000 * 2 ** i, 15_000)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(quoteBig(await r.text()));
    } catch (e) { last = String(e); await sleep(500 * 2 ** i); }
  }
  throw new Error(`${url}: ${last}`);
}

export const tsOf = (rc: any): bigint => BigInt(rc.execution_outcome?.block_timestamp ?? 0);

/** Fetch every function-call tx touching the escrow, return its receipts flattened (ordered by block time) with the tx hash. */
export async function fetchEscrowHistoryFrom(base: string, escrow: string, d: LiveDeps): Promise<{ hash: string; signer?: string; rc: any }[]> {
  const hashes: string[] = [];
  let resume: string | undefined;
  for (let page = 0; page < 200; page++) {
    const j = await postJson(`${base}/v0/account`, { account_id: escrow, limit: 200, ...(resume ? { resume_token: resume } : {}) }, d);
    // L1b14: ALL txs touching the account (deploy / create / delete too): E2 needs the current incarnation's DeployContract.
    for (const t of j.account_txs ?? []) if (!hashes.includes(t.transaction_hash)) hashes.push(t.transaction_hash);
    resume = j.resume_token && (j.account_txs ?? []).length ? String(j.resume_token) : undefined;
    if (!resume) break;
  }
  const out: { hash: string; signer?: string; rc: any }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < hashes.length; i += 5) {
    const j = await postJson(`${base}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 5) }, d);
    for (const t of j.transactions ?? []) for (const rc of t.receipts ?? []) {
      // L1b10: a receipt executes once; an indexer delivering it twice must not count as two runs (B3). Distinct receipts (a real replay) are kept.
      const id = rc.receipt?.receipt_id;
      if (id !== undefined) { if (seen.has(id)) continue; seen.add(id); }
      out.push({ hash: t.transaction.hash, signer: t.transaction.signer_id, rc });
    }
  }
  return out.sort((a, b) => (tsOf(a.rc) < tsOf(b.rc) ? -1 : tsOf(a.rc) > tsOf(b.rc) ? 1 : 0));
}


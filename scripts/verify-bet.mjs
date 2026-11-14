#!/usr/bin/env node
// verify-bet.mjs — check a Praetorial bet yourself. Public, read-only, no keys, no dependencies (Node 18+).
//
//   node verify-bet.mjs <betId> [verification-file.json] [--network mainnet|testnet] [--escrow <account>] [--no-wasm] [--offline]
//
// Network: default mainnet (escrow bets.praetorial.near), unless the verification file names another. Use --network testnet only for
// the testnet rehearsal escrow.
//
// With a file (the bet page's "Download verification file"), every check runs on what the file says AND, unless --offline,
// against the chain. Without a file, the script reads the bet from the chain (and its transaction list from Praetorial's
// public indexer), then runs the same checks. Each check prints PASS, FAIL or SKIP and why. Exit code 1 if anything FAILs.
//
// Checks:
//   terms-hash          sha256(the terms text) == the terms hash the bet was opened with (and == the chain's, online)
//   resolver-keys       the file's resolver keys / program hash == the escrow's resolver_keys view (online)
//   ruling-sig-<run>    each AI ruling: ed25519 signature valid under the escrow's outcome key, over the exact message
//                       the escrow checks (contracts/escrow submit_outcome; services/common/src/resolverSign.ts); its bet id and
//                       terms hash match this bet
//   stored-ruling       the file's stored ruling == the chain's last_resolution_raw (online)
//   wasm                the resolver program downloaded from FastFS hashes to the fingerprint pinned in the escrow (online)
//   escrow-code         the escrow's deployed code hash == the file's (online); escrow-locked: the escrow has no access keys
//   tx-<hash>           each transaction exists on chain (archival RPC), was signed by who the file says, touched the escrow,
//                       and the escrow's part succeeded or failed exactly as the file says
//
// What this does NOT prove: that OutLayer ran the program inside a TEE (OutLayer's promise), or that the outcome key belongs to
// the program (checked at deploy, off chain; the mainnet report-pubkey runs are public txs, see the Docs). See the Docs:
// /docs/trust ("Trust and verification", every step with commands) and /docs/verification#verify.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FORMAT = "praetorial-verification/1";
export const NETWORKS = {
  mainnet: {
    escrow: "bets.praetorial.near", rpc: "https://free.rpc.fastnear.com", archival: "https://archival-rpc.mainnet.fastnear.com",
    indexer: "https://indexer.praetorial.com",
  },
  testnet: {
    escrow: "praetorial-frz3-2611100414.praetorial-dev-1101.testnet", rpc: "https://test.rpc.fastnear.com",
    archival: "https://archival-rpc.testnet.fastnear.com", indexer: "https://praetorial-indexer-testnet.familiarcow.workers.dev",
  },
};

// ---------------------------------------------------------------- small pure helpers
export const sha256Hex = (data) => createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");

/** JSON.parse that keeps every integer of 16+ digits as an exact string (u64 nanoseconds exceed 2^53). */
export function parseExact(text) {
  const s = String(text);
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { // copy a string literal untouched (digits inside strings are text)
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < s.length && /[0-9.eE+\-]/.test(s[j])) j++;
      const num = s.slice(i, j);
      out += /^-?\d{16,}$/.test(num) ? `"${num}"` : num; i = j; continue;
    }
    out += c; i++;
  }
  return JSON.parse(out);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

class Borsh {
  constructor() { this.parts = []; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v)); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(String(v))); this.parts.push(b); return this; }
  string(s) { const b = Buffer.from(String(s), "utf8"); this.u32(b.length); this.parts.push(b); return this; }
  bytes() { return Buffer.concat(this.parts); }
}
const isRetry = (o) => o === "RETRY" || o === "RETRY:no_live_judge";

/** The exact bytes the escrow's submit_outcome verifies (services/common/src/resolverSign.ts buildSubmitOutcomeMessage).
 *  A result without judge_pair_index was signed before JC1s (no index in the message). */
export function outcomeMessage(escrow, result) {
  const w = new Borsh().string(escrow).u64(result.bet_id).string(result.terms_hash).string(result.outcome)
    .string(result.element_results_hash).u64(result.run_no).u64(result.checked_until ?? 0);
  if (result.judge_pair_index !== undefined && result.judge_pair_index !== null) w.u32(result.judge_pair_index);
  if (isRetry(result.outcome)) w.u64(result.next_check_ns);
  const obs = Array.isArray(result.model_not_found) ? result.model_not_found : [];
  if (obs.length) { w.u32(obs.length); for (const o of obs) w.string(o.model).u64(o.observed_ns); }
  return w.bytes();
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
export function verifyEd25519(pubHex, sigHex, msg) {
  try {
    if (!/^[0-9a-f]{64}$/i.test(pubHex) || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pubHex, "hex")]), format: "der", type: "spki" });
    return edVerify(null, msg, key, Buffer.from(sigHex, "hex"));
  } catch { return false; }
}

const pass = (id, reason) => ({ id, status: "PASS", reason });
const fail = (id, reason) => ({ id, status: "FAIL", reason });
const skip = (id, reason) => ({ id, status: "SKIP", reason });

// ---------------------------------------------------------------- the checks (pure: file + optional chain facts)
/**
 * @param file   a verification file (FORMAT)
 * @param chain  null (offline) or { termsHash, raw, keys:[outcome, attest, wasmHash], wasm?:{bytes?|error}, codeHashB58, accessKeys,
 *               txs: { [hash]: {found, signer, escrowOk:boolean|null, touchesEscrow, error?} } }
 */
export function runChecks(file, chain) {
  const out = [];
  if (!file || file.format !== FORMAT) return [fail("format", `not a ${FORMAT} file`)];
  const betId = Number(file.bet_id);
  const bet = file.get_bet_text ? parseExact(file.get_bet_text) : null;
  const termsHash = file.terms_hash;

  // terms-hash
  if (typeof file.terms !== "string" || !file.terms) out.push(skip("terms-hash", "this bet's terms are not stored on chain (only their hash); give the terms text to check it"));
  else {
    const h = sha256Hex(file.terms);
    const problems = [];
    if (h !== termsHash) problems.push(`sha256(terms) = ${h}, but the bet's terms hash is ${termsHash}`);
    if (bet && bet.envelope?.terms_hash !== termsHash) problems.push(`the file's bet record says terms hash ${bet.envelope?.terms_hash}`);
    if (bet && typeof bet.envelope?.terms === "string" && bet.envelope.terms !== file.terms) problems.push("the file's terms differ from the terms inside its bet record");
    if (chain && chain.termsHash !== termsHash) problems.push(`the chain says terms hash ${chain.termsHash}`);
    out.push(problems.length ? fail("terms-hash", problems.join("; ")) : pass("terms-hash", `sha256(terms) = ${h} = the bet's terms hash${chain ? " (also on chain)" : ""}`));
  }

  // resolver-keys
  const keys = chain?.keys ?? [file.resolver?.outcome_pubkey, file.resolver?.attest_pubkey, file.resolver?.wasm_hash];
  if (chain) {
    const want = [file.resolver?.outcome_pubkey, file.resolver?.attest_pubkey, file.resolver?.wasm_hash];
    const bad = ["outcome key", "attest key", "program hash"].filter((_, i) => want[i] !== chain.keys[i]);
    out.push(bad.length ? fail("resolver-keys", `${bad.join(", ")} in the file differ from the escrow's resolver_keys view (${chain.keys.join(", ")})`)
      : pass("resolver-keys", `outcome key ${chain.keys[0]}, program hash ${chain.keys[2]} = the escrow's resolver_keys view`));
  } else out.push(skip("resolver-keys", "offline: the file's keys are used as given"));

  // ruling signatures
  const rulings = Array.isArray(file.rulings) ? file.rulings : [];
  if (!rulings.length) out.push(skip("ruling-sig", file.referee ? "a person decides this bet: no AI ruling to check (their ruling is the referee_rule transaction)" : "no AI ruling yet"));
  const escrow = file.escrow?.account;
  for (const r of rulings) {
    let result;
    try { result = parseExact(r.result_json); } catch { out.push(fail(`ruling-sig-${r.run_no}`, "the signed result is not valid JSON")); continue; }
    const id = `ruling-sig-${result.run_no ?? r.run_no}`;
    const problems = [];
    if (Number(result.bet_id) !== betId) problems.push(`it is for bet ${result.bet_id}`);
    if (result.terms_hash !== termsHash) problems.push(`its terms hash ${result.terms_hash} is not this bet's`);
    if (r.pubkey_hex && r.pubkey_hex !== keys[0]) problems.push(`it names signing key ${r.pubkey_hex}, the escrow's outcome key is ${keys[0]}`);
    if (!verifyEd25519(keys[0], r.signature_hex, outcomeMessage(escrow, result))) problems.push(`the signature does NOT verify under the outcome key ${keys[0]}`);
    out.push(problems.length ? fail(id, problems.join("; ")) : pass(id, `${result.outcome} (check ${result.run_no}${r.tx_hash ? `, tx ${r.tx_hash}` : ", stored on chain"}): signature valid under the escrow's outcome key`));
  }

  // stored-ruling
  if (chain) {
    const fr = bet?.last_resolution_raw ?? null;
    if (fr == null && chain.raw == null) out.push(skip("stored-ruling", "no stored ruling yet"));
    else if (fr === chain.raw) out.push(pass("stored-ruling", "the file's stored ruling is byte for byte the one on chain"));
    else out.push(fail("stored-ruling", "the file's stored ruling differs from the chain's last_resolution_raw (tampered, or a newer check ran since the file was saved: download it again)"));
  }

  // wasm
  if (!chain) out.push(skip("wasm", "offline"));
  else if (!chain.wasm) out.push(skip("wasm", "not downloaded (--no-wasm)"));
  else if (chain.wasm.error) out.push(fail("wasm", `could not download the program: ${chain.wasm.error}`));
  else {
    const h = sha256Hex(chain.wasm.bytes);
    out.push(h === chain.keys[2] ? pass("wasm", `the program file (${chain.wasm.bytes.length} bytes, ${chain.wasm.url}) hashes to ${h} = the escrow's pinned program hash`)
      : fail("wasm", `the program file hashes to ${h}, the escrow pins ${chain.keys[2]}`));
  }

  // escrow code + keys
  if (chain) {
    const want = file.escrow?.code_hash_b58;
    if (!chain.codeHashB58) out.push(fail("escrow-code", "could not read the escrow's code hash"));
    else if (want && want !== chain.codeHashB58) out.push(fail("escrow-code", `the escrow's code hash is ${chain.codeHashB58}, the file says ${want}`));
    else out.push(pass("escrow-code", `the escrow's deployed code hash is ${chain.codeHashB58}${want ? " (= the file)" : ""}`));
    out.push(chain.accessKeys === 0 ? pass("escrow-locked", "the escrow account has no access keys: nobody can deploy new code to it")
      : chain.accessKeys == null ? fail("escrow-locked", "could not read the escrow's access keys") : fail("escrow-locked", `the escrow account has ${chain.accessKeys} access key(s)`));
  }

  // transactions
  const txs = Array.isArray(file.transactions) ? file.transactions : [];
  if (!txs.length) out.push(skip("tx", "the file lists no transactions (the indexer had none for this bet)"));
  for (const t of txs) {
    const id = `tx-${t.hash}`;
    if (Number(t.bet_id) !== betId) { out.push(fail(id, `listed for bet ${t.bet_id}`)); continue; }
    if (!chain) { out.push(skip(id, "offline")); continue; }
    const c = chain.txs?.[t.hash];
    // a lookup that could not be made (network, rate limit) proves nothing either way: SKIP, never PASS. Run again later.
    if (!c || c.error) { out.push(skip(id, `could not look it up right now (${c?.error ?? "not checked"}); run again later`)); continue; }
    const problems = [];
    if (!c.found) problems.push("not found on chain");
    else {
      if (c.signer !== t.signer) problems.push(`signed by ${c.signer}, the file says ${t.signer}`);
      if (!c.touchesEscrow) problems.push("it never reached the escrow");
      else if (c.escrowOk !== t.ok) problems.push(`the escrow's part ${c.escrowOk ? "succeeded" : "failed"}, the file says it ${t.ok ? "succeeded" : "failed"}`);
    }
    out.push(problems.length ? fail(id, `${t.kind}: ${problems.join("; ")}`) : pass(id, `${t.kind} (${t.method}), signed by ${t.signer}, ${t.ok ? "accepted" : "refused"} by the escrow`));
  }
  return out;
}

// ---------------------------------------------------------------- reading the chain (read-only)
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One JSON-RPC call; a rate limit (429) or 5xx is retried with backoff (public RPCs throttle bursts). */
async function rpc(url, method, params, f, sleep = realSleep) {
  for (let i = 0; ; i++) {
    const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "v", method, params }) });
    if ((r.status === 429 || r.status >= 500) && i < 5) {
      const ra = Number(r.headers?.get?.("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** i, 8000));
      continue;
    }
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
    return j.result;
  }
}
async function viewText(net, account, method, args, f) {
  const r = await rpc(net.rpc, "query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }, f);
  return Buffer.from(r.result).toString("utf8");
}

async function txStatus(net, escrow, hash, signer, f, sleep) {
  try {
    const r = await rpc(net.archival, "tx", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" }, f, sleep);
    const mine = (r.receipts_outcome ?? []).filter((x) => x.outcome?.executor_id === escrow);
    const okS = (s) => !!s && typeof s === "object" && ("SuccessValue" in s || "SuccessReceiptId" in s);
    // the escrow's first receipt is the action itself; later ones are its own callbacks
    return { found: true, signer: r.transaction?.signer_id, touchesEscrow: mine.length > 0, escrowOk: mine.length ? okS(mine[0].outcome.status) : null };
  } catch (e) {
    const m = String(e?.message ?? e);
    if (/UNKNOWN_TRANSACTION|doesn't exist|does not exist/i.test(m)) return { found: false };
    return { error: m };
  }
}

/** Everything the online checks compare against. */
export async function gatherChain(net, escrow, betId, file, o = {}) {
  const f = o.fetch ?? fetch;
  const betText = await viewText(net, escrow, "get_bet", { bet_id: betId }, f);
  const bet = parseExact(betText);
  if (!bet) throw new Error(`bet ${betId} not found on ${escrow}`);
  const keys = JSON.parse(await viewText(net, escrow, "resolver_keys", {}, f));
  const olc = JSON.parse(await viewText(net, escrow, "outlayer_config", {}, f));
  const acct = await rpc(net.rpc, "query", { request_type: "view_account", finality: "final", account_id: escrow }, f);
  let accessKeys = null;
  try { accessKeys = (await rpc(net.rpc, "query", { request_type: "view_access_key_list", finality: "final", account_id: escrow }, f)).keys.length; } catch { /* reported as unreadable */ }
  let wasm = null;
  if (o.wasm !== false) {
    const url = `${olc.wasm_base_url}/${keys[2]}.wasm`;
    try { const r = await f(url); wasm = r.ok ? { url, bytes: Buffer.from(await r.arrayBuffer()) } : { url, error: `HTTP ${r.status}` }; } catch (e) { wasm = { url, error: String(e?.message ?? e) }; }
  }
  const txs = {};
  const sleep = o.sleep ?? realSleep;
  for (const t of file?.transactions ?? []) { txs[t.hash] = await txStatus(net, escrow, t.hash, t.signer, f, sleep); await sleep(250); }
  return { betText, bet, termsHash: bet.envelope.terms_hash, raw: bet.last_resolution_raw ?? null, keys, olc, codeHashB58: acct?.code_hash ?? null, accessKeys, wasm, txs };
}

/** A verification file built from the chain alone (no download): the bet, its rulings and the indexer's transaction list. */
export async function fileFromChain(net, escrow, betId, o = {}) {
  const f = o.fetch ?? fetch;
  const betText = await viewText(net, escrow, "get_bet", { bet_id: betId }, f);
  const bet = parseExact(betText);
  if (!bet) throw new Error(`bet ${betId} not found on ${escrow}`);
  const keys = JSON.parse(await viewText(net, escrow, "resolver_keys", {}, f));
  let txs = [];
  try { const r = await f(`${net.indexer}/bet/txs?bet_id=${betId}&contract_id=${encodeURIComponent(escrow)}`); if (r.ok) txs = await r.json(); } catch { /* listed as none */ }
  return buildFile({ network: o.network, escrow, betId, betText, keys, txs, olc: null, codeHashB58: null });
}

/** The shared file builder (the web's "Download verification file" writes the same shape: apps/web/lib/verify.ts). */
export function buildFile({ network, escrow, betId, betText, keys, olc, codeHashB58, txs, models = null, generatedAt = null }) {
  const bet = parseExact(betText);
  const e = bet.envelope;
  const rulings = [];
  for (const t of txs ?? []) if (t.kind === "ruling" && t.ok && t.signed) rulings.push({ run_no: t.run_no, source: "submit_outcome", tx_hash: t.hash, result_json: t.signed.result_json, signature_hex: t.signed.signature_hex });
  if (typeof bet.last_resolution_raw === "string") {
    const m = bet.last_resolution_raw.match(/"result"\s*:\s*(\{[^{}]*(?:\[[^\]]*\][^{}]*)*\})/);
    let raw = null;
    try { raw = JSON.parse(bet.last_resolution_raw); } catch { /* unreadable: no stored ruling entry */ }
    if (m && raw?.signing?.signature_hex && !rulings.some((r) => r.run_no === raw.result?.run_no)) {
      rulings.push({ run_no: raw.result.run_no, source: "stored", tx_hash: null, result_json: m[1], signature_hex: raw.signing.signature_hex, pubkey_hex: raw.signing.pubkey_hex ?? null });
    } else if (m && raw?.signing?.pubkey_hex) {
      const r = rulings.find((x) => x.run_no === raw.result?.run_no);
      if (r) r.pubkey_hex = raw.signing.pubkey_hex;
    }
  }
  return {
    format: FORMAT,
    network: network ?? null,
    generated_at: generatedAt,
    bet_id: betId,
    escrow: { account: escrow, code_hash_b58: codeHashB58 },
    terms: e.terms ?? null,
    terms_hash: e.terms_hash,
    referee: e.referee ?? null,
    resolver: { outcome_pubkey: keys[0], attest_pubkey: keys[1], wasm_hash: keys[2], wasm_url: olc ? `${olc.wasm_base_url}/${keys[2]}.wasm` : null },
    models: { models_snapshot_hash: e.models_snapshot_hash ?? null, ...(models ?? {}) },
    rulings: rulings.sort((a, b) => Number(a.run_no) - Number(b.run_no)),
    exhibits: bet.exhibits ?? [],
    transactions: txs ?? [],
    get_bet_text: betText,
  };
}

// ---------------------------------------------------------------- CLI
const USAGE = "usage: node verify-bet.mjs <betId> [verification-file.json] [--network mainnet|testnet] [--escrow <account>] [--no-wasm] [--offline]";
export function format(results) { return results.map((r) => `${r.status.padEnd(4)} ${r.id}  ${r.reason}`).join("\n"); }

export async function main(argv, o = {}) {
  const log = o.log ?? console.log;
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-wasm" || a === "--offline") flags[a.slice(2)] = true;
    else if (a === "--network" || a === "--escrow") flags[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) { log(USAGE); return 2; }
    else pos.push(a);
  }
  const betId = Number(pos[0]);
  if (!pos[0] || !Number.isInteger(betId) || betId < 0) { log(USAGE); return 2; }
  let file = null;
  if (pos[1]) {
    try { file = JSON.parse((o.readFile ?? ((p) => readFileSync(p, "utf8")))(pos[1])); } catch (e) { log(`cannot read ${pos[1]}: ${e?.message ?? e}`); return 2; }
    if (Number(file?.bet_id) !== betId) { log(`FAIL bet-id  the file is for bet ${file?.bet_id}, not ${betId}`); return 1; }
  }
  const network = flags.network ?? file?.network ?? "mainnet";
  const net = NETWORKS[network];
  if (!net) { log(`unknown network ${network}`); return 2; }
  const escrow = flags.escrow ?? file?.escrow?.account ?? net.escrow;
  if (flags.offline && !file) { log("--offline needs a verification file"); return 2; }
  let chain = null;
  try {
    if (!file) file = await fileFromChain(net, escrow, betId, { fetch: o.fetch, network });
    if (!flags.offline) chain = await gatherChain(net, escrow, betId, file, { fetch: o.fetch, sleep: o.sleep, wasm: !flags["no-wasm"] });
  } catch (e) { log(`FAIL chain  could not read the chain: ${e?.message ?? e}`); return 1; }
  const results = runChecks(file, chain);
  log(`# bet ${betId} on ${escrow} (${network})${chain ? "" : " — offline: file only"}`);
  log(format(results));
  const n = (s) => results.filter((r) => r.status === s).length;
  log(`# ${n("PASS")} PASS, ${n("FAIL")} FAIL, ${n("SKIP")} SKIP`);
  return n("FAIL") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

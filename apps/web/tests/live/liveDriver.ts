// LIVE1: drives the REAL deployed testnet stack the way the web app does (same lib code: delegate, rpc, relayerClient,
// openEnvelope, escrowAdapter, storageCharge, sourceCheckClient, takeScreen, payoutScreen), with local ed25519 keys in
// place of Privy's signRawHash. Secrets live ONLY in ~/.near-credentials/testnet/live1/<accountId>.json and are never printed.
//
// Run from apps/web:  npx tsx tests/live/openProof.ts   |   npx tsx tests/live/fullFlow.ts [state-file]
import { buildStakeTransfer } from "../../lib/stakeTransfer"; // INTENTS1: real intents.near mt_transfer_call, 1 yocto
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithdraw } from "../../lib/withdraw";
import { createRequire } from "node:module";
import { prepareDelegate, encodeSignedDelegate, base58FromHex } from "../../lib/delegate";
import { viewAccessKeyNonce, viewBlockHeight, viewFunction } from "../../lib/rpc";
import { relaySignedDelegate, RELAYER_URL } from "../../lib/relayerClient";
import { buildOpenEnvelope, makerDeposit } from "../../lib/openEnvelope";
import { buildOpenMsg, getBet, resolverKeys, type Bet } from "../../lib/escrowAdapter";
import { fetchStorageRates } from "../../lib/storageCharge";
import { requestSourceCheck, SOURCECHECK_URL, type OpenAttestation } from "../../lib/sourceCheckClient";
import { canonicalTerms, termsHash } from "../../lib/templates";
import { customDeadlineSecs } from "../../lib/customBuilder";
import { checkOpenPins } from "../../lib/openPins";
import { prepareTake } from "../../lib/takeScreen";
import { DRAIN_METHOD, drainPayoutsArgs, type PayoutLine } from "../../lib/payoutScreen";
import { NETWORK } from "../../lib/network";

// Plain txs (fund / mint / direct calls) are built with the same @near-js/transactions 2.x the web's delegate.ts uses.
// (near-api-js 5's Account resolves @near-js/accounts 1.x against the hoisted transactions 2.x here and fails to
// serialize: "Expected string not undefined at value.signerId", so it is not used.)
import { KeyPair, KeyType } from "@near-js/crypto";
import { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } from "@near-js/transactions";
import { sha256 } from "js-sha256";
import bs58 from "bs58";
void createRequire;

export const ESCROW = NETWORK.escrow;
export const INTENTS = NETWORK.intents;
export const RPC = NETWORK.rpcUrl;
export const DEV = "praetorial-dev-1101.testnet";
export const RELAYER_ACCOUNT = "relayer.praetorial-dev-1101.testnet";
export const USDC = "nep141:usdc.testnet";
export const WNEAR = "nep141:wrap.testnet";
export const ASSET_ID = { USDC, NEAR: WNEAR } as const;
export const CRED_DIR = path.join(os.homedir(), ".near-credentials", "testnet");
export const LIVE_DIR = path.join(CRED_DIR, "live1");
export const ONE_NEAR = 10n ** 24n;
export const ONE_USDC = 10n ** 6n;

export const log = (...a: unknown[]) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- accounts
export interface LiveAccount { id: string; label: string; keyPair: any }

function keyFile(id: string) { return path.join(LIVE_DIR, `${id}.json`); }

function devKeyPair(): any {
  const k = JSON.parse(fs.readFileSync(path.join(CRED_DIR, `${DEV}.json`), "utf8"));
  return KeyPair.fromString(k.private_key);
}

/** CS1 (testnet ops): plain NEAR transfer from the dev/funder account, e.g. to top up an escrow's storage headroom. Key never printed. */
export async function transferFromDev(receiverId: string, yocto: bigint) {
  if (NETWORK.networkId !== "testnet") throw new Error("transferFromDev: testnet only");
  return sendTx(DEV, devKeyPair(), receiverId, [actionCreators.transfer(yocto)]);
}

/** Sign + send a plain transaction (not relayed) and wait for FINAL. Returns hash + outcome. */
export async function sendTx(signerId: string, keyPair: any, receiverId: string, actions: any[]): Promise<{ txHash: string; ok: boolean; receiptFailure: string | null; logs: string[]; error?: string }> {
  const pk = keyPair.getPublicKey();
  let txHash = "";
  // The dev key may be shared with other processes on this machine: retry on InvalidNonce with a fresh nonce.
  for (let attempt = 0; ; attempt++) {
    const ak = await rawRpc("query", { request_type: "view_access_key", account_id: signerId, public_key: pk.toString(), finality: "optimistic" });
    if (!ak.result) throw new Error(`access key lookup for ${signerId}: ${JSON.stringify(ak.error)}`);
    const blk = await rawRpc("block", { finality: "final" });
    const nonce = BigInt(ak.result.nonce) + 1n + BigInt(Math.floor(Math.random() * 1000)) * (attempt > 0 ? 1n : 0n);
    const tx = createTransaction(signerId, pk, receiverId, nonce, actions, bs58.decode(blk.result.header.hash));
    const hash = Uint8Array.from(sha256.array(encodeTransaction(tx)));
    const sig = keyPair.sign(hash).signature;
    const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: KeyType.ED25519, data: sig }) });
    txHash = bs58.encode(hash);
    const b = await rawRpc("send_tx", { signed_tx_base64: Buffer.from(signed.encode()).toString("base64"), wait_until: "FINAL" });
    const err = b.error ? JSON.stringify(b.error) : "";
    if (err && /InvalidNonce/.test(err) && attempt < 5) { await sleep(1500 + Math.random() * 2000); continue; }
    if (err && !/TIMEOUT/i.test(err)) return { txHash, ok: false, receiptFailure: null, logs: [], error: err.slice(0, 800) };
    break;
  }
  const v = await txOutcome(txHash, signerId);
  return { txHash, ok: v.status === "success" && !v.receiptFailure, receiptFailure: v.receiptFailure, logs: v.logs };
}

/** Fresh ed25519 keypair -> implicit account (id = hex pubkey), funded from the dev account with a plain transfer. */
export async function newAccount(label: string, fundNear: number | string): Promise<LiveAccount & { fundTx: string; fundedYocto: string }> {
  const kp = KeyPair.fromRandom("ed25519");
  const id = Buffer.from(kp.getPublicKey().data).toString("hex");
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("unexpected implicit id");
  fs.mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile(id), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString(), label }), { mode: 0o600 });
  let yocto = BigInt(Math.round(Number(fundNear) * 1e6)) * 10n ** 18n;
  // The dev/funder account is nearly empty (1.47 NEAR on 2026-11-09). Everything a bettor does is relayed (gasless), so
  // when the requested amount would drain the funder, fund a smaller amount instead and say so (fundedYocto).
  const devBal = BigInt((await rawRpc("query", { request_type: "view_account", account_id: DEV, finality: "final" })).result.amount);
  const reserve = 3n * 10n ** 23n; // keep 0.3 NEAR on the funder for mint gas
  const cap = devBal > reserve ? (devBal - reserve) / 4n : 0n;
  if (yocto > cap) { log(`newAccount ${label}: funder has ${devBal} yocto; funding ${cap} instead of ${yocto}`); yocto = cap; }
  if (yocto < 10n ** 22n) throw new Error(`funder ${DEV} too low to fund ${label} (balance ${devBal} yocto)`);
  const r = await sendTx(DEV, devKeyPair(), id, [actionCreators.transfer(yocto)]);
  if (!r.ok) throw new Error(`funding ${label} failed: ${r.error ?? r.receiptFailure}`);
  log(`newAccount ${label} ${id.slice(0, 8)}… funded ${yocto} yocto tx ${r.txHash}`);
  return { id, label, keyPair: kp, fundTx: r.txHash, fundedYocto: yocto.toString() };
}

export function loadAccount(id: string): LiveAccount {
  const k = JSON.parse(fs.readFileSync(keyFile(id), "utf8"));
  return { id, label: k.label ?? "", keyPair: KeyPair.fromString(k.private_key) };
}

/** Same contract as Privy's signRawHash: sign the raw 32-byte hash, return the 64-byte ed25519 signature as hex. */
export function signRawHash(acct: LiveAccount) {
  return async (_address: string, hashHex: string): Promise<string> =>
    Buffer.from(acct.keyPair.sign(Uint8Array.from(Buffer.from(hashHex, "hex"))).signature).toString("hex");
}

// ---------------------------------------------------------------- tx lookup
async function rawRpc(method: string, params: unknown): Promise<any> {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }) });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    return r.json();
  }
  throw new Error(`rpc ${method}: rate limited`);
}

export interface TxView { status: "success" | "failure" | "unknown"; receiptFailure: string | null; logs: string[]; returnValue: string | null; raw?: any }

/** Fetch a finished tx (wait_until FINAL); tries the relayer as signer first, then `altSender`. */
export async function txOutcome(txHash: string, altSender?: string): Promise<TxView> {
  const senders = [RELAYER_ACCOUNT, ...(altSender ? [altSender] : [])];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const s of senders) {
      const b = await rawRpc("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: s, wait_until: "FINAL" });
      if (b.result) {
        const r = b.result;
        const outs: any[] = r.receipts_outcome ?? [];
        const firstFail = outs.find((o) => o?.outcome?.status?.Failure);
        const topFail = r.status?.Failure;
        const logs = outs.flatMap((o) => o?.outcome?.logs ?? []);
        const sv = r.status?.SuccessValue;
        return {
          status: topFail ? "failure" : firstFail ? "failure" : r.status?.SuccessValue !== undefined || r.status?.SuccessReceiptId ? "success" : "unknown",
          receiptFailure: firstFail ? JSON.stringify(firstFail.outcome.status.Failure) : topFail ? JSON.stringify(topFail) : null,
          logs,
          returnValue: sv ? Buffer.from(sv, "base64").toString("utf8") : null,
        };
      }
      lastErr = b.error;
    }
    await sleep(2000);
  }
  return { status: "unknown", receiptFailure: `tx lookup failed: ${JSON.stringify(lastErr)}`, logs: [], returnValue: null };
}

// ---------------------------------------------------------------- relay (mirrors lib/useRelayAction.ts run())
export interface RelayCall { receiverId: string; methodName: string; args: Record<string, unknown>; gasTgas?: number; depositYocto?: string }
export interface RelayOut { httpStatus: number; body: any; ok: boolean; txHash: string | null; receiptFailure: string | null; logs: string[]; returnValue: string | null; clientResult: unknown }

export async function relay(acct: LiveAccount, c: RelayCall): Promise<RelayOut> {
  const [nonce, blockHeight] = await Promise.all([viewAccessKeyNonce(acct.id, acct.id), viewBlockHeight()]);
  const { delegateAction, hashHex } = prepareDelegate({
    senderId: acct.id, receiverId: c.receiverId, methodName: c.methodName, args: c.args,
    gasTgas: c.gasTgas ?? 80, depositYocto: c.depositYocto ?? "0", publicKeyHexEd25519: acct.id,
    nonce: nonce + 1n, maxBlockHeight: blockHeight + 200n,
  });
  const signatureHex = await signRawHash(acct)(acct.id, hashHex);
  const signed = encodeSignedDelegate(delegateAction, signatureHex);
  // Raw POST so the exact HTTP status + body are captured (relaySignedDelegate hides the status).
  const res = await fetch(`${RELAYER_URL}/relay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signedDelegate: signed }) });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = { nonJson: text.slice(0, 500) }; }
  const txHash: string | null = body?.txHash ?? null;
  let view: TxView = { status: "unknown", receiptFailure: null, logs: [], returnValue: null };
  if (txHash) view = await txOutcome(txHash, acct.id);
  const ok = res.status === 200 && !!txHash && view.status === "success" && !view.receiptFailure;
  log(`relay ${c.methodName}@${c.receiverId.split(".")[0]} by ${acct.label || acct.id.slice(0, 8)} -> http ${res.status} tx ${txHash ?? "-"} ${ok ? "OK" : `FAIL ${body?.error ?? ""} ${view.receiptFailure ?? ""}`}`);
  return { httpStatus: res.status, body, ok, txHash, receiptFailure: view.receiptFailure ?? body?.receiptFailure ?? null, logs: view.logs, returnValue: view.returnValue, clientResult: undefined };
}
// relaySignedDelegate is the web's client; kept referenced so a future switch is one line.
void relaySignedDelegate;

// ---------------------------------------------------------------- direct (non-relayed) calls signed by an account
export async function directCall(acct: LiveAccount | "dev", c: RelayCall) {
  const [id, kp] = acct === "dev" ? [DEV, devKeyPair()] : [acct.id, acct.keyPair];
  const action = actionCreators.functionCall(c.methodName, Buffer.from(JSON.stringify(c.args)), BigInt(c.gasTgas ?? 30) * 10n ** 12n, BigInt(c.depositYocto ?? "0"));
  return sendTx(id, kp, c.receiverId, [action]);
}

// ---------------------------------------------------------------- intents mock
/** Dev account calls intents-mock mint(account_id, token_id, amount: U128). (Mock-only faucet; permissionless.) */
export async function mintIntents(acct: { id: string }, tokenId: string, amount: bigint | string) {
  const r = await directCall("dev", { receiverId: INTENTS, methodName: "mint", args: { account_id: acct.id, token_id: tokenId, amount: String(amount) }, gasTgas: 30 });
  log(`mint ${amount} ${tokenId} -> ${acct.id.slice(0, 8)} tx ${r.txHash} ${r.ok ? "OK" : r.error ?? r.receiptFailure}`);
  if (!r.ok) throw new Error(`mint failed: ${r.error ?? r.receiptFailure}`);
  return r.txHash;
}

export async function intentsBalance(id: string, tokenId: string): Promise<bigint> {
  return BigInt(String((await viewFunction<string>(INTENTS, "mt_balance_of", { account_id: id, token_id: tokenId })) ?? "0"));
}

export async function balances(acct: { id: string }) {
  const [usdc, wnear] = [await intentsBalance(acct.id, USDC), await intentsBalance(acct.id, WNEAR)];
  const st = await rawRpc("query", { request_type: "view_account", account_id: acct.id, finality: "final" });
  const native = st.result ? BigInt(st.result.amount) : null;
  let walletWnear: bigint | null = null;
  let walletUsdc: bigint | null = null;
  try { walletWnear = BigInt(String(await viewFunction<string>("wrap.testnet", "ft_balance_of", { account_id: acct.id }))); } catch { walletWnear = null; }
  try { walletUsdc = BigInt(String(await viewFunction<string>("usdc.testnet", "ft_balance_of", { account_id: acct.id }))); } catch { walletUsdc = null; }
  return { intents: { [USDC]: usdc.toString(), [WNEAR]: wnear.toString() }, nativeYocto: native?.toString() ?? null, wallet: { "wrap.testnet": walletWnear?.toString() ?? null, "usdc.testnet": walletUsdc?.toString() ?? null } };
}

/**
 * LIVE2 / WITHDRAW1: Escrow (intents) balance -> wallet through EXACTLY the web's path: lib/withdraw.ts runWithdraw (user-signed
 * storage_deposit, SEC1/MON-1, if the wallet isn't registered on the token, then relayed intents `ft_withdraw {token, receiver_id: me,
 * amount}` with 1 yocto; success = no failed receipt AND the wallet's token balance rose by the amount).
 */
export async function withdraw(acct: LiveAccount, tokenId: string, amount: bigint | string) {
  const symbol = tokenId === WNEAR ? "NEAR" : tokenId === USDC ? "USDC" : tokenId;
  const failures = new Map<string, string | null>();
  const r = await runWithdraw({ symbol, amountUnits: String(amount) }, acct.id, {
    relay: async (step) => {
      const o = await relay(acct, step);
      if (o.txHash) failures.set(o.txHash, o.receiptFailure);
      return { ok: o.httpStatus === 200 && !!o.txHash, txHash: o.txHash ?? undefined, error: o.body?.error ?? (o.httpStatus !== 200 ? `relayer HTTP ${o.httpStatus}` : undefined) };
    },
    direct: async (step) => {
      const o: any = await directCall(acct, step);
      if (o.txHash) failures.set(o.txHash, o.receiptFailure ?? null);
      return { ok: !!o.ok, txHash: o.txHash ?? undefined, error: o.error ?? o.receiptFailure ?? undefined };
    },
    view: (c, m, a) => viewFunction<unknown>(c, m, a),
    txFailure: async (h) => failures.get(h) ?? null,
    sleep: async (ms) => { await sleep(ms); },
  }, "testnet");
  log(`withdraw ${amount} ${tokenId} by ${acct.label} txs ${r.txHashes.join(",") || "-"} ${r.ok ? `OK received ${r.receivedUnits}` : `FAIL ${"detail" in r ? r.detail : ""}`}`);
  return r;
}

// ---------------------------------------------------------------- sourcecheck
// The testnet sourcecheck Worker allows 60 executions per IP per clock hour (LIVE2; SOURCECHECK_IP_PER_HOUR), shared
// with anything else on this machine. Attestations are per terms_hash and fresh for 1h, so the driver reuses one for
// identical terms within 50 min (the web asks again per Open), and on 429 waits for the next window (LIVE1_SC_MAX_WAIT_MIN).
const scCache = new Map<string, { attestation: OpenAttestation; at: number }>();
export async function sourceCheck(terms: string): Promise<{ attestation: OpenAttestation; ms: number; cached: boolean }> {
  const h = termsHash(terms);
  const hit = scCache.get(h);
  if (hit && Date.now() - hit.at < 50 * 60_000) return { attestation: hit.attestation, ms: 0, cached: true };
  const deadline = Date.now() + Number(process.env.LIVE1_SC_MAX_WAIT_MIN ?? 65) * 60_000;
  let netRetries = 0;
  for (;;) {
    const t0 = Date.now();
    try {
      const attestation = await requestSourceCheck(h, terms, SOURCECHECK_URL);
      const ms = Date.now() - t0;
      log(`sourcecheck ok in ${ms} ms`);
      scCache.set(h, { attestation, at: Date.now() });
      return { attestation, ms, cached: false };
    } catch (e: any) {
      if (Date.now() > deadline) throw e;
      if (e?.kind === "rate_limit") { log("sourcecheck rate-limited (10/IP/hour); retrying in 5 min"); await sleep(5 * 60_000); continue; }
      if (e?.kind === "service" && /could not reach/.test(String(e?.message)) && ++netRetries <= 3) { log(`sourcecheck network error (${e.message}); retry ${netRetries}/3 in 20 s`); await sleep(20_000); continue; }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- sheets
const isoSec = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 19) + "Z";

/** A human-referee custom sheet (SRCREF1c: customOpenProblems now requires the same >=2 sources as AI mode) whose event
 * window ends `deadlineSecsFromNow` from now. The referee may rule once funding_deadline (= max(window_end, now+60)) passes. */
export function humanSheet(label: string, deadlineSecsFromNow: number, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const end = Math.ceil((now + deadlineSecsFromNow) / 60) * 60; // whole UTC minute, like the builder's minute fields
  const day = isoSec(end).slice(0, 10);
  return {
    claim: `LIVE1 driver check ${label} on ${day}: the named referee answers YES.`,
    elements: [{ id: "e1", q: `Does the named referee answer YES for LIVE1 check ${label} on ${day}?` }],
    rule: "ALL",
    sources: true,
    clauses: ["UTC_V1", "PARTIAL_NONE_V1"],
    custom_definitions: [
      "Fallback: if a named source is unavailable, any other listed source may confirm.",
      "Early YES resolution is allowed once the event has happened.",
    ],
    // The deployed sourcecheck Worker lints with lintAnySheet (NO human-referee exemption, unlike lib/customLint
    // customOpenProblems({humanReferee:true})) and then fetches every source, so a referee bet still needs two
    // independent, fetchable https sources or it gets no attestation (HTTP 422 / 502).
    sources_allowed: [
      { id: "S1", publisher: "Example Domain", url: "https://example.com/" },
      { id: "S2", publisher: "IANA", url: "https://www.iana.org/" },
    ],
    time: { window_start: isoSec(now - 60), window_end: isoSec(end), evidence_cutoff: isoSec(end) },
  };
}

// ---------------------------------------------------------------- open (mirrors apps/web/src/App.tsx Open handler)
export interface OpenArgs {
  maker: LiveAccount;
  asset: "USDC" | "NEAR";
  stakeMaker: bigint | string;
  stakeTaker: bigint | string;
  referee: string | null;
  takerAccount: string | null;
  sheet?: Record<string, unknown>;
  /** Event deadline for the default sheet (seconds from now). */
  deadlineSecs?: number;
  label?: string;
}

export async function openBet(a: OpenArgs) {
  const assetId = ASSET_ID[a.asset];
  const sheet = a.sheet ?? humanSheet(a.label ?? a.asset, a.deadlineSecs ?? 600);
  const pinErr = await checkOpenPins(resolverKeys);
  if (pinErr) throw new Error(`checkOpenPins: ${pinErr}`);
  const nowMs = Date.now();
  const built = buildOpenEnvelope({
    maker: a.maker.id, sheet, customDeadlineSecs: customDeadlineSecs(sheet as any),
    makerAsset: assetId, takerAsset: assetId, stakeMaker: String(a.stakeMaker), stakeTaker: String(a.stakeTaker),
    takerAccount: a.takerAccount, referee: a.referee ? { account: a.referee, mode: "Human" } : null, tipMaker: false, nowMs,
  });
  const envelope: any = { ...built, maker_asset: assetId, taker_asset: assetId, stake_maker: String(a.stakeMaker), stake_taker: String(a.stakeTaker), referee: built.referee };
  const terms = canonicalTerms(sheet);
  if (envelope.terms !== terms) throw new Error("envelope terms != canonicalTerms(sheet)");
  const sc = await sourceCheck(terms);
  const rates = await fetchStorageRates([assetId]);
  if (rates[assetId] == null) throw new Error(`no storage rate (asset_limit) for ${assetId}`);
  const payNow = makerDeposit(envelope, rates[assetId]);
  const msg = buildOpenMsg(envelope, sc.attestation, a.takerAccount);
  const beforeCount = Number(await viewFunction<number>(ESCROW, "bet_count", {}));
  const beforeBal = await intentsBalance(a.maker.id, assetId);
  const r = await relay(a.maker, buildStakeTransfer({ tokenId: assetId, amount: payNow, msg, escrow: ESCROW, intents: INTENTS }));
  const rejected = r.logs.find((l) => l.includes("open_rejected")) ?? null;
  // Find the bet: scan ids from beforeCount for this maker + terms_hash (others may open concurrently).
  let betId: number | null = null, bet: Bet | null = null;
  for (let i = 0; i < 8 && betId === null && r.txHash && !rejected; i++) {
    const count = Number(await viewFunction<number>(ESCROW, "bet_count", {}));
    for (let id = count; id > beforeCount; id--) { // bet ids start at 1; bet_count() = next_bet_id - 1 = newest id
      const b = await getBet(id).catch(() => null);
      if (b && b.envelope.maker === a.maker.id && b.envelope.terms_hash === envelope.terms_hash) { betId = id; bet = b; break; }
    }
    if (betId === null) await sleep(2000);
  }
  const afterBal = await intentsBalance(a.maker.id, assetId);
  return {
    betId, bet, txHash: r.txHash, httpStatus: r.httpStatus, relayBody: r.body, receiptFailure: r.receiptFailure, openRejected: rejected,
    deposit: payNow, storageRate: rates[assetId], sourcecheckMs: sc.ms, sourcecheckCached: sc.cached, termsHash: envelope.terms_hash,
    makerBalanceDelta: (afterBal - beforeBal).toString(), fundingDeadlineNs: String(envelope.funding_deadline), resolveDeadlineNs: String(envelope.resolve_deadline),
  };
}

// ---------------------------------------------------------------- take (mirrors BetPage doTake -> lib/takeScreen prepareTake)
export async function takeBet(taker: LiveAccount, betId: number) {
  const shown = await getBet(betId);
  if (!shown) throw new Error(`bet ${betId} not found`);
  const rates = await fetchStorageRates([shown.envelope.taker_asset, ...(shown.envelope.taker_options ?? []).map((o: any) => o.asset)]);
  const betR = { ...shown, storage_rates: rates } as any;
  const prepared = await prepareTake({ betId, shown: betR, tip: false, inviteSig: null, takerAccount: taker.id, readBet: async (id) => getBet(id) as any });
  if (!prepared.ok) throw new Error(`prepareTake refused: ${prepared.message}`);
  const r = await relay(taker, buildStakeTransfer({ tokenId: prepared.tokenId, amount: prepared.amount, msg: prepared.msg, escrow: ESCROW, intents: INTENTS }));
  let bet: Bet | null = null;
  for (let i = 0; i < 8; i++) { bet = await getBet(betId); if (bet?.taker === taker.id) break; await sleep(2000); }
  return { txHash: r.txHash, httpStatus: r.httpStatus, relayBody: r.body, receiptFailure: r.receiptFailure, deposit: prepared.amount, refereeAck: prepared.refereeAck, taken: bet?.taker === taker.id, bet, logs: r.logs.filter((l) => /take|reject/i.test(l)) };
}

// ---------------------------------------------------------------- referee rule + payout
export async function refereeRule(referee: LiveAccount, betId: number, outcome: "YES" | "NO" | "VOID") {
  const rule = await relay(referee, { receiverId: ESCROW, methodName: "referee_rule", args: { bet_id: betId, outcome }, gasTgas: 150 });
  const drains: Array<{ txHash: string | null; ok: boolean; httpStatus: number; error?: string }> = [];
  // referee_rule drains in the same call; drive drain_payouts (as the web's "retry payout") until nothing is pending.
  for (let i = 0; i < 4; i++) {
    const pend = await pendingPayouts(betId);
    if (!pend.some((p) => !p.done)) break;
    await sleep(3000);
    const again = await pendingPayouts(betId);
    if (!again.some((p) => !p.done && !p.in_flight)) continue;
    const d = await relay(referee, { receiverId: ESCROW, methodName: DRAIN_METHOD, args: drainPayoutsArgs(betId), gasTgas: 150 });
    drains.push({ txHash: d.txHash, ok: d.ok, httpStatus: d.httpStatus, error: d.body?.error ?? d.receiptFailure ?? undefined });
  }
  const bet = await getBet(betId);
  return { ruleTx: rule.txHash, ruleOk: rule.ok, ruleHttp: rule.httpStatus, ruleBody: rule.body, ruleFailure: rule.receiptFailure, drains, bet, pending: await pendingPayouts(betId) };
}

export async function pendingPayouts(betId: number): Promise<PayoutLine[]> {
  try { return (await viewFunction<PayoutLine[]>(ESCROW, "pending_payouts", { bet_id: betId })) ?? []; } catch { return []; }
}

export { getBet, base58FromHex };

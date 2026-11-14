// RC1: generate and check the escrow `new()` args for a release (D-UPGRADE1: the escrow is not upgradeable,
// so these args are produced by code, never typed by hand). Spec: vault "Mainnet release config draft"
// sections 1, 3.1, 3.2. All maths is exact BigInt rational arithmetic; prices are decimal strings.

import { launchMaxPerSide, contractIntermediates, U128_MAX as STAKE_U128_MAX } from "./stakeCap.js";
import { loadContractConstants, maxEnvelopeBytes, storageCharge, TYPICAL_ENVELOPE_BYTES, type ContractConstants } from "./contractConstants.js";

export class ReleaseError extends Error {
  constructor(msg: string) { super(msg); this.name = "ReleaseError"; }
}
const fail = (msg: string): never => { throw new ReleaseError(msg); };

export type Network = "mainnet" | "testnet";
export const MAINNET_INTENTS = "intents.near";
export const PRICE_MAX_AGE_MS = 30 * 60_000;
export const PRICE_MAX_DIFF_PCT = 2n;
const FUTURE_SLACK_MS = 60_000;
export const FEE_CAP_USD = "2.5"; // D-PARAMS1 hard cap per side

export interface AssetInput {
  token_id: string;
  decimals: number;
  kind: "stable" | "volatile";
  price_usd?: string | number;
  price_ts_ms?: number;
  second_price_usd?: string | number;
  second_price_ts_ms?: number;
  price_source?: string;
  second_price_source?: string;
}
/** STG1b: deploy-day NEAR/USD price (two sources, same rules as an asset price) used for storage_per_kib. */
export interface NearPriceInput { price_usd: string | number; price_ts_ms: number; second_price_usd: string | number; second_price_ts_ms: number }
export interface ReleaseInput {
  near_price: NearPriceInput;
  network?: Network;
  intents: string;
  usdc_token_id: string;
  outlayer: string;
  operator: string;
  guardian: string;
  registry: string;
  fee_account: string;
  keeper: string;
  max_offer_ttl_secs: number;
  outcome_pubkey: string;
  attest_pubkey: string;
  resolver_wasm_hash: string;
  outlayer_config: { wasm_base_url: string; secrets_profile: string; secrets_account_id: string };
  assets: AssetInput[];
  /** RCFG1: roles that are not `new()` args (e.g. attest signer, relayer account), recorded for the release record only. */
  accounts_notes?: Record<string, string>;
}
export interface AssetLimitArgs {
  min_per_side: string; max_per_side: string; min_fee_per_side: string; min_fee_cap_per_side: string;
  run_price: string; min_bond: string; min_objection: string;
  /** STG1b (D-STORAGE1): raw units of this asset per 1,024 bytes of estimated bet storage. */
  storage_per_kib: string;
}
/** JC1 (D-JUDGECHAIN1): one judge pair (two distinct model ids that must both be live). */
export interface JudgePairArg { model_a: string; model_b: string }
/** JC1: the built-in primary pair (first in the chain). Ids are the exact NEAR AI ids from GET /v1/models. */
export const PRIMARY_JUDGE_PAIR: JudgePairArg = { model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017", model_b: "z-ai/glm-5.3-flash" };
/**
 * JC1s (D-JUDGECHAIN1, #5): backup pairs, each of two DIFFERENT model families, all four families new relative to the primary
 * and to each other; every id verified present in the live GET /v1/models list of 2026-11-08 (resolver/wasm-bin/fixtures/near_ai_models.json).
 * Order = decision priority: the resolver walks to the next pair only after a model of the earlier pair is retired
 * (3 not-found checks >= 24h apart). Same fixed call settings for every pair.
 */
export const BACKUP_JUDGE_PAIRS: JudgePairArg[] = [
  { model_a: "Qwen/Qwen3.8-27B", model_b: "moonshotai/kimi-k3" },
  { model_a: "google/gemini-3.5-flash", model_b: "openai/gpt-5.4-mini" },
  { model_a: "x-ai/grok-4.7", model_b: "anthropic/claude-haiku-5-5" },
];
export const BUILT_IN_JUDGE_CHAIN: JudgePairArg[] = [PRIMARY_JUDGE_PAIR, ...BACKUP_JUDGE_PAIRS];
export interface NewArgs {
  intents: string; usdc_token_id: string; outlayer: string; operator: string; guardian: string;
  registry: string; fee_account: string; keeper: string;
  limits: { max_stake: string; max_offer_ttl_secs: number; max_stake_per_side_near: string; max_rounds: number };
  beta_sunset_ns: null;
  asset_limits: [string, AssetLimitArgs][];
  outcome_pubkey: string; attest_pubkey: string; resolver_wasm_hash: string;
  outlayer_config: { wasm_base_url: string; secrets_profile: string; secrets_account_id: string };
  /** JC1 (D-JUDGECHAIN1): ordered judge-pair chain, 2..=4 pairs at new() (JC1x), the rest appended by the guardian (max 12). */
  judge_chain: JudgePairArg[];
}
export interface GenOptions { now_ms: number; network?: Network; constants?: ContractConstants; /** RCFG1: final/mainnet-release mode: refuse every placeholder, all-0/all-1 key and non-https wasm_base_url. */ final?: boolean;
  /** MAINPREP1: deploy-night preflight: every --final check except the three OutLayer-sourced fields, which are reported in GenResult.pending. */ preflight?: boolean }
/** RCB1: per-asset storage report (bytes of the maximum envelope, charges per side in raw units). */
export interface StorageRow { token_id: string; decimals: number; rate: bigint; typicalCharge: bigint; maxBytes: bigint; maxCharge: bigint; minPerSide: bigint }
export interface GenResult { args: NewArgs; table: string; storage: StorageRow[]; /** MAINPREP1 --preflight: OutLayer-sourced fields still placeholders. */ pending: string[] }
/** MAINPREP1: the only fields that come back from the mainnet OutLayer setup (report-pubkey runs + FastFS upload) on deploy night. */
export const OUTLAYER_SOURCED_FIELDS = ["outcome_pubkey", "attest_pubkey", "outlayer_config.wasm_base_url"] as const;

// ---- exact rationals over BigInt
interface Rat { n: bigint; d: bigint }
const pow10 = (k: number): bigint => 10n ** BigInt(k);

/** Parse a positive plain-decimal string ("3.68", "75823") into a rational. No exponent form. */
function parseDecimal(v: unknown, what: string): Rat {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(s)) return fail(`${what}: price must be a plain positive decimal, got ${JSON.stringify(v)}`);
  const [i, f = ""] = s.split(".");
  const n = BigInt(i + f);
  if (n <= 0n) return fail(`${what}: price must be > 0, got ${s}`);
  return { n, d: pow10(f.length) };
}
const floorDiv = (n: bigint, d: bigint) => n / d;
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** U(x) = x / P * 10^decimals as a rational (native units worth x USD). x is a decimal string. */
function uRat(x: string, price: Rat, decimals: number): Rat {
  const xr = parseDecimal(x, "constant");
  return { n: xr.n * pow10(decimals) * price.d, d: xr.d * price.n };
}

const WNEAR = "nep141:wrap.near";
const WNEAR_STORAGE_PER_KIB = 10240000000000000000000n; // exactly 0.01024 NEAR (24 dp)
const HEX64 = /^[0-9a-f]{64}$/;
const U128_MAX = (1n << 128n) - 1n;
const LIMIT_FIELDS: (keyof AssetLimitArgs)[] = ["min_per_side", "max_per_side", "min_fee_per_side", "min_fee_cap_per_side", "run_price", "min_bond", "min_objection", "storage_per_kib"];

const STABLE: AssetLimitArgs = {
  min_per_side: "10000000", max_per_side: launchMaxPerSide().toString(), // CAP3 (D-CAP3): no cap at launch = largest overflow-safe value
  min_fee_per_side: "500000", min_fee_cap_per_side: "2500000",
  run_price: "5000", min_bond: "5000000", min_objection: "1000000",
  storage_per_kib: "", // filled per release from the NEAR price (STG1b)
};

/** STG1b: the storage rate is 0.01024 NEAR per KiB. */
const STORAGE_NEAR_PER_KIB_NUM = 1024n, STORAGE_NEAR_PER_KIB_DEN = 100_000n;
/** raw units of an asset (price `p`, `decimals`) worth 0.01024 NEAR at `nearPrice`; rounded UP, min 1. */
function storagePerKib(nearPrice: Rat, p: Rat, decimals: number): string {
  const n = STORAGE_NEAR_PER_KIB_NUM * nearPrice.n * p.d * pow10(decimals);
  const d = STORAGE_NEAR_PER_KIB_DEN * nearPrice.d * p.n;
  const v = ceilDiv(n, d);
  return (v < 1n ? 1n : v).toString();
}

function checkPriceTs(ts: unknown, now: number, what: string) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return fail(`${what}: price timestamp missing`);
  if (ts > now + FUTURE_SLACK_MS) fail(`${what}: price timestamp is in the future`);
  if (now - ts > PRICE_MAX_AGE_MS) fail(`${what}: price is older than 30 min (stale); fetch a fresh one within 30 min before signing the deploy`);
}

/** Parses + checks a two-source price (staleness, 2% agreement). */
function checkedPrice(id: string, a: { price_usd?: string | number; price_ts_ms?: number; second_price_usd?: string | number; second_price_ts_ms?: number }, now: number): Rat {
  const p = parseDecimal(a.price_usd, `${id} price_usd`);
  const q = parseDecimal(a.second_price_usd, `${id} second_price_usd`);
  checkPriceTs(a.price_ts_ms, now, `${id} price_usd`);
  checkPriceTs(a.second_price_ts_ms, now, `${id} second_price_usd`);
  // |p - q| / p > 2%  (exact)
  const diff = p.n * q.d - q.n * p.d;
  const absDiff = diff < 0n ? -diff : diff;
  if (absDiff * 100n > PRICE_MAX_DIFF_PCT * p.n * q.d) fail(`${id}: the two price sources differ by more than 2% (${a.price_usd} vs ${a.second_price_usd})`);
  return p;
}

function volatileLimits(a: AssetInput, now: number): { limits: AssetLimitArgs; price: Rat } {
  const id = a.token_id;
  if (a.price_usd === undefined || a.price_usd === "") fail(`${id}: price_usd missing`);
  if (a.second_price_usd === undefined || a.second_price_usd === "") fail(`${id}: second-source price (second_price_usd) missing`);
  const p = checkedPrice(id, a, now);
  const d = a.decimals;
  const U = (x: string) => uRat(x, p, d);
  const up = (x: string) => { const r = U(x); return ceilDiv(r.n, r.d); };
  const down = (x: string) => { const r = U(x); return floorDiv(r.n, r.d); };
  const v = {
    min_per_side: up("10"), min_fee_per_side: down("0.5"), min_fee_cap_per_side: down(FEE_CAP_USD),
    max_per_side: launchMaxPerSide(), run_price: up("0.005"), min_bond: up("5"), min_objection: up("1"),
  };
  const limits = {} as AssetLimitArgs;
  for (const f of LIMIT_FIELDS) {
    if (f === "storage_per_kib") continue; // set in generate() once the NEAR price is known
    if (v[f as keyof typeof v] <= 0n) fail(`${id}: ${f} would be 0 (price too high for ${d} decimals; limits too small to represent)`);
    limits[f] = v[f as keyof typeof v].toString();
  }
  return { limits, price: p };
}

/** RCB1 (GATE-05 K1): storage_per_kib is pinned at new(); check it can neither overflow u128 nor eat a minimum-stake side. */
function checkStorageRate(id: string, rate: bigint, minPerSide: bigint, c: ContractConstants): void {
  const bytes = maxEnvelopeBytes(c);
  if (bytes * rate + 2047n > U128_MAX) fail(`${id}: storage_per_kib ${rate} would overflow u128 in estimated_storage_bytes(max)=${bytes} * rate`);
  if (id === WNEAR && rate !== WNEAR_STORAGE_PER_KIB) fail(`${id}: wNEAR storage_per_kib must be exactly ${WNEAR_STORAGE_PER_KIB} (0.01024 NEAR), got ${rate}`);
  const max = storageCharge(bytes, rate);
  if (max * 10n > minPerSide) fail(`${id}: max storage charge ${max} per side (${bytes}-byte envelope at storage_per_kib ${rate}) exceeds 10% of min_per_side ${minPerSide} (storage may never cost a minimum-stake side more than 10%)`);
}

/** JC1x (D-JUDGECHAIN1a #3): mirrors the contract's validate_model_id. */
export function isValidModelId(m: string): boolean {
  return /^[A-Za-z0-9._:+-]+\/[A-Za-z0-9._:+-]+$/.test(m) && m.length <= 128;
}

/** Independent re-check of finished args, mirroring `Contract::new` plus the release rules. Throws ReleaseError. */
export function validateArgs(args: NewArgs, network: Network, constants?: ContractConstants): void {
  const c = constants ?? loadContractConstants();
  if (network === "mainnet" && args.intents !== MAINNET_INTENTS) fail(`intents must be ${MAINNET_INTENTS} on mainnet, got ${args.intents}`);
  for (const f of ["outcome_pubkey", "attest_pubkey", "resolver_wasm_hash"] as const) {
    if (!HEX64.test(args[f])) fail(`${f} must be 64 lowercase hex chars`);
  }
  const oc = args.outlayer_config;
  if (!oc.wasm_base_url.startsWith("https://") || oc.wasm_base_url.length <= 8 || oc.wasm_base_url.endsWith("/")) fail("outlayer_config.wasm_base_url must start with https:// and have no trailing /");
  const jc = args.judge_chain;
  if (!Array.isArray(jc) || jc.length < 2 || jc.length > 4) fail("judge_chain must have 2..=4 pairs at new() (D-JUDGECHAIN1a #3; more are appended later by the guardian, max 12)");
  const seenPairs = new Set<string>();
  for (const p of jc) {
    if (!p.model_a || !p.model_b || p.model_a === p.model_b) fail("judge_chain pairs need two distinct non-empty model ids");
    for (const m of [p.model_a, p.model_b]) {
      if (!isValidModelId(m)) fail(`judge_chain model id ${JSON.stringify(m)} must be ASCII org/model, at most 128 bytes (D-JUDGECHAIN1a #3)`);
    }
    const k = [p.model_a, p.model_b].sort().join("\u0000");
    if (seenPairs.has(k)) fail("duplicate judge pair in judge_chain");
    seenPairs.add(k);
  }
  const sp = new TextEncoder().encode(oc.secrets_profile).length;
  if (sp < 1 || sp > 64) fail("outlayer_config.secrets_profile must be 1-64 bytes");
  if (!args.asset_limits.some(([id]) => id === args.usdc_token_id)) fail("usdc_token_id must be a key in asset_limits");
  const seen = new Set<string>();
  for (const [id, l] of args.asset_limits) {
    if (seen.has(id)) fail(`duplicate asset ${id}`);
    seen.add(id);
    const n = {} as Record<keyof AssetLimitArgs, bigint>;
    for (const f of LIMIT_FIELDS) {
      const raw = (l as unknown as Record<string, unknown>)[f];
      if (f === "storage_per_kib" && (raw === undefined || raw === null)) fail(`${id}: storage_per_kib is absent (required by new(), no serde default)`);
      if (f === "min_fee_cap_per_side" && (raw === undefined || raw === null)) fail(`${id}: min_fee_cap_per_side is absent (serde default 0 would pin the cap at the initial min fee)`);
      if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) fail(`${id}: ${f} must be a decimal string`);
      n[f] = BigInt(raw as string);
      if (n[f] > U128_MAX) fail(`${id}: ${f} exceeds u128`);
      if (n[f] <= 0n) fail(`${id}: ${f} must be > 0`);
    }
    if (n.min_per_side > n.max_per_side) fail(`${id}: min_per_side must be <= max_per_side`);
    if (n.min_fee_per_side * 20n > n.min_per_side) fail(`${id}: 20 * min_fee_per_side must be <= min_per_side`);
    checkStorageRate(id, n.storage_per_kib, n.min_per_side, c);
    // CAP3 (D-CAP3): max_per_side may be lowered freely but never above the overflow-safe launch cap, and every u128 expression
    // the escrow computes from it (fees, tips, storage, bonds, objections, payout sums) must fit with both sides at that max.
    if (n.max_per_side > launchMaxPerSide()) fail(`${id}: max_per_side ${n.max_per_side} would overflow u128 arithmetic in the escrow (cap is ${launchMaxPerSide()}, D-CAP3)`);
    for (const x of contractIntermediates({
      stakeMaker: n.max_per_side, stakeTaker: n.max_per_side, feeBps: 10_000n, maxRounds: BigInt(args.limits.max_rounds), storageRate: n.storage_per_kib,
      maxBytes: maxEnvelopeBytes(c), minFee: n.min_fee_per_side, minBond: n.min_bond, minObjection: n.min_objection, runPrice: n.run_price,
    })) if (x.value > STAKE_U128_MAX) fail(`${id}: max_per_side ${n.max_per_side} would overflow u128 (${x.name} = ${x.value})`);
    if (n.min_fee_per_side > n.min_fee_cap_per_side) fail(`${id}: min_fee_per_side must be <= min_fee_cap_per_side`);
  }
  if (args.limits.max_rounds !== 2) fail("limits.max_rounds must be 2 (D-AUDIT8)");
  if (!Number.isInteger(args.limits.max_offer_ttl_secs) || args.limits.max_offer_ttl_secs <= 0) fail("limits.max_offer_ttl_secs must be a positive integer");
  // operator and keeper are hot (bot-held) keys: each must be its own account, never the guardian or the fee account.
  // KEYS2 (D-KEYS2): guardian and fee_account MAY be the same account (praetorial.near is owner + guardian + fee account);
  // the frozen escrow's new() has no distinctness check, and fee_account only receives payouts / may top up keeper credit.
  const hot = [args.operator, args.keeper];
  const cold = new Set([args.guardian, args.fee_account]);
  if (args.operator === args.keeper || hot.some((a) => cold.has(a))) fail("operator and keeper must be two different accounts, each different from guardian and fee_account");
}

function flatStrings(v: unknown, path: string, out: [string, string][]): void {
  if (typeof v === "string") out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => flatStrings(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) flatStrings(x, path ? `${path}.${k}` : k, out);
}

/** RCFG1: placeholder checks, --final only: nothing may be a placeholder. Throws one ReleaseError naming every field.
 *  MAINPREP1: with `preflight`, the three OUTLAYER_SOURCED_FIELDS may still be placeholders; they are returned (pending) instead
 *  of refused. A non-https wasm_base_url that is not a placeholder is still refused. Returns the pending list. */
export function checkPlaceholders(args: NewArgs, network: Network, final: boolean, preflight = false): string[] {
  if (!final && !preflight) return []; // draft mode is unchanged: it may carry placeholders (the indicative example uses PLACEHOLDER account names)
  const bad: string[] = [];
  const pending: string[] = [];
  const outlayerSourced = new Set<string>(OUTLAYER_SOURCED_FIELDS);
  const strs: [string, string][] = [];
  flatStrings(args, "", strs);
  for (const [path, val] of strs) {
    // MAINPREP1: a mainnet release must not carry any testnet account/host (e.g. a test.fastfs.io/<x>.testnet wasm_base_url).
    if (network === "mainnet" && /\.testnet\b|\/\/test\.|testnet\./i.test(val)) bad.push(`${path}: testnet value on mainnet (${val})`);
    if (!/PLACEHOLDER/i.test(val)) continue;
    if (preflight && outlayerSourced.has(path)) pending.push(path);
    else bad.push(`${path}: contains PLACEHOLDER (${val})`);
  }
  const keyPlaceholder = (name: "outcome_pubkey" | "attest_pubkey") => {
    if (!/^(0+|1+)$/.test(args[name])) return;
    if (preflight) pending.push(name); else bad.push(`${name}: is an all-0 or all-1 placeholder key`);
  };
  keyPlaceholder("outcome_pubkey");
  keyPlaceholder("attest_pubkey");
  const url = args.outlayer_config.wasm_base_url;
  if (!url.startsWith("https://")) bad.push(`outlayer_config.wasm_base_url: must be https:// (${url})`);
  if (bad.length) fail(`${preflight ? "--preflight" : "--final"} refuses placeholder values:\n  - ${[...new Set(bad)].join("\n  - ")}`);
  return [...new Set(pending)].sort();
}

export function generate(input: ReleaseInput, opts: GenOptions): GenResult {
  const network = opts.network ?? input.network ?? fail("network not given (pass --network)");
  if (input.network !== undefined && opts.network !== undefined && input.network !== opts.network) {
    fail(`network mismatch: input says ${input.network}, requested ${opts.network}`);
  }
  if (network === "mainnet" && input.intents !== MAINNET_INTENTS) fail(`intents must be ${MAINNET_INTENTS} on mainnet, got ${input.intents}`);
  if (!Array.isArray(input.assets) || input.assets.length === 0) fail("asset list is empty");
  const ids = input.assets.map((a) => a.token_id);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) fail(`duplicate asset ${dup}`);
  if (!ids.includes(input.usdc_token_id)) fail(`usdc_token_id ${input.usdc_token_id} is not in the asset list`);

  const asset_limits: [string, AssetLimitArgs][] = [];
  const rows: { a: AssetInput; limits: AssetLimitArgs; price: Rat }[] = [];
  for (const a of input.assets) {
    if (!Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 36) fail(`${a.token_id}: bad decimals`);
    if (a.kind === "stable") {
      if (a.decimals !== 6) fail(`${a.token_id}: stable assets use the exact 6-decimal table (section 3.1); got ${a.decimals} decimals`);
      const limits = { ...STABLE };
      asset_limits.push([a.token_id, limits]);
      rows.push({ a, limits, price: { n: 1n, d: 1n } });
    } else if (a.kind === "volatile") {
      const { limits, price } = volatileLimits(a, opts.now_ms);
      asset_limits.push([a.token_id, limits]);
      rows.push({ a, limits, price });
    } else fail(`${a.token_id}: kind must be "stable" or "volatile"`);
  }

  // STG1b: every asset gets storage_per_kib = 0.01024 NEAR worth at deploy-day prices, rounded up, min 1.
  if (!input.near_price) fail("near_price missing: the deploy-day NEAR/USD price (two sources) is needed for storage_per_kib");
  const nearPrice = checkedPrice("near_price", input.near_price, opts.now_ms);
  for (const r of rows) {
    r.limits.storage_per_kib = r.a.token_id === WNEAR
      ? (STORAGE_NEAR_PER_KIB_NUM * pow10(r.a.decimals) / STORAGE_NEAR_PER_KIB_DEN).toString() // exactly 0.01024 NEAR
      : storagePerKib(nearPrice, r.price, r.a.decimals);
  }

  const maxOf = (xs: bigint[]) => xs.reduce((m, x) => (x > m ? x : m), 0n);
  const maxMax = maxOf(asset_limits.map(([, l]) => BigInt(l.max_per_side)));
  const wn = asset_limits.find(([id]) => id === WNEAR);
  const args: NewArgs = {
    intents: input.intents,
    usdc_token_id: input.usdc_token_id,
    outlayer: input.outlayer,
    operator: input.operator,
    guardian: input.guardian,
    registry: input.registry,
    fee_account: input.fee_account,
    keeper: input.keeper,
    // MS1: limits.max_stake is no longer read by the contract; kept for init/borsh compatibility.
    limits: {
      max_stake: maxMax.toString(),
      max_offer_ttl_secs: input.max_offer_ttl_secs,
      max_stake_per_side_near: (wn ? BigInt(wn[1].max_per_side) : maxMax).toString(),
      max_rounds: 2,
    },
    beta_sunset_ns: null,
    asset_limits,
    outcome_pubkey: input.outcome_pubkey,
    attest_pubkey: input.attest_pubkey,
    resolver_wasm_hash: input.resolver_wasm_hash,
    outlayer_config: { ...input.outlayer_config },
    judge_chain: BUILT_IN_JUDGE_CHAIN.map((p) => ({ ...p })),
  };
  if (opts.final === true && opts.preflight === true) fail("--preflight and --final are exclusive: preflight allows the OutLayer-sourced placeholders, final allows none");
  const pending = checkPlaceholders(args, network, opts.final === true, opts.preflight === true);
  const c = opts.constants ?? loadContractConstants();
  validateArgs(args, network, c);
  const maxBytes = maxEnvelopeBytes(c);
  const storage: StorageRow[] = rows.map((r) => {
    const rate = BigInt(r.limits.storage_per_kib);
    return { token_id: r.a.token_id, decimals: r.a.decimals, rate, typicalCharge: storageCharge(TYPICAL_ENVELOPE_BYTES, rate), maxBytes, maxCharge: storageCharge(maxBytes, rate), minPerSide: BigInt(r.limits.min_per_side) };
  });
  return { args, table: renderTable(rows, network, opts.now_ms) + renderStorageTable(rows, storage, maxBytes), storage, pending };
}

// ---- human-readable table
function usd(raw: string, decimals: number, p: Rat): string {
  // value * P / 10^d, rounded to 4 decimals (half up), trailing zeros trimmed to >= 2
  const scaled = (BigInt(raw) * p.n * 10_000n * 2n + p.d * pow10(decimals)) / (p.d * pow10(decimals) * 2n);
  let s = scaled.toString().padStart(5, "0");
  let whole = s.slice(0, -4);
  let frac = s.slice(-4);
  while (frac.length > 2 && frac.endsWith("0")) frac = frac.slice(0, -1);
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${frac}`;
}

function renderTable(rows: { a: AssetInput; limits: AssetLimitArgs; price: Rat }[], network: Network, now: number): string {
  const out: string[] = [];
  out.push(`# Release limits (network: ${network}; generated at ${new Date(now).toISOString()})`, "");
  out.push("| Asset | Decimals | Price USD (source ts) | min_per_side | max_per_side | min_fee_per_side | min_fee_cap_per_side | run_price | min_bond | min_objection | storage_per_kib |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const { a, limits, price } of rows) {
    const ps = a.kind === "stable" ? "1 (stable, exact table)" : `${a.price_usd} / ${a.second_price_usd} (${new Date(a.price_ts_ms!).toISOString()})`;
    const cell = (f: keyof AssetLimitArgs) => `${limits[f]} = ${usd(limits[f], a.decimals, price)}`;
    out.push(`| \`${a.token_id}\` | ${a.decimals} | ${ps} | ${cell("min_per_side")} | ${cell("max_per_side")} | ${cell("min_fee_per_side")} | ${cell("min_fee_cap_per_side")} | ${cell("run_price")} | ${cell("min_bond")} | ${cell("min_objection")} | ${cell("storage_per_kib")} |`);
  }
  out.push("", "Rounding: min_per_side, run_price, min_bond, min_objection, storage_per_kib (0.01024 NEAR per KiB at deploy-day prices, min 1) rounded UP; min_fee_per_side, min_fee_cap_per_side, max_per_side rounded DOWN. USD values are the exact native amount x price, shown to 4 dp.");
  return out.join("\n") + "\n";
}

/** RCB1: per-asset storage table (also printed by the CLI). */
function renderStorageTable(rows: { a: AssetInput; limits: AssetLimitArgs; price: Rat }[], st: StorageRow[], maxBytes: bigint): string {
  const out: string[] = ["", `## Storage charge per side (max envelope ${maxBytes} bytes, read from lib.rs; ~4 KB = ${TYPICAL_ENVELOPE_BYTES} bytes; bound: max charge <= 10% of min_per_side)`, ""];
  out.push("| Asset | rate (storage_per_kib) | ~4 KB charge | max charge | max charge % of min_per_side |", "|---|---|---|---|---|");
  rows.forEach((r, i) => {
    const s = st[i];
    const pct = (s.maxCharge * 10000n + s.minPerSide / 2n) / s.minPerSide; // basis points of a percent, half up
    const pctS = `${pct / 100n}.${(pct % 100n).toString().padStart(2, "0")}%`;
    const cell = (v: bigint) => `${v} = ${usd(v.toString(), r.a.decimals, r.price)}`;
    out.push(`| \`${s.token_id}\` | ${cell(s.rate)} | ${cell(s.typicalCharge)} | ${cell(s.maxCharge)} | ${pctS} |`);
  });
  return out.join("\n") + "\n";
}

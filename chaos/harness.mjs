// Praetorial CHAOS harness: local-sandbox end-to-end wiring.
//
// Deploys contracts/escrow + contracts/mock-intents + contracts/mock-outlayer
// to a local nearcore sandbox node (no testnet/mainnet, ever). Drives the
// real escrow contract exactly as built from this repo's current source,
// with a local resolver signer standing in for OutLayer's TEE signature
// (no NEAR AI calls anywhere in this harness).
//
// WHY A CUSTOM LAUNCHER, NOT near-workspaces' bundled sandbox: the npm
// `near-sandbox` package hardcodes nearcore 2.6.2 (s3 tarball URL baked
// into near-sandbox/dist/getBinary.js), which cannot deserialize wasm
// produced by near-sdk 5.30/current rustc -- every deploy fails with
// `PrepareError::Deserialization`. sandbox-launcher/ (Rust, `near-sandbox`
// crate 0.3.x) launches nearcore 2.13.x instead, which parses our wasm
// fine. This harness spawns that launcher as a child process and drives
// the resulting RPC endpoint with near-api-js directly -- the same
// library services/common/src/nearClient.ts already wraps, so keeper/
// indexer code is exercised unmodified against this sandbox.
//
// Scope rule: this harness and everything under chaos/ never touches
// services/data/*, services/e2e/*, or tests/seams/, and never talks to
// testnet/mainnet RPC. Sandbox only. No keys/seeds are ever logged beyond
// the sandbox's own well-known disposable genesis keypair.
import { connect, keyStores, KeyPair, utils } from "near-api-js";
import nacl from "tweetnacl";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------
// Leak fix: track every sandbox-launcher process group we've started so
// a SIGINT/SIGTERM/uncaught error while a scenario is mid-flight still
// kills the real near-sandbox child, not just this node process. Also
// exposes a stale-sweep for run.mjs to call once before a run starts
// (never from inside setupSandbox itself -- that would kill sibling
// sandboxes when families run in parallel).
// ---------------------------------------------------------------------
const ACTIVE_PGIDS = new Set();
function killAllActive() {
  for (const pid of ACTIVE_PGIDS) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
  }
  ACTIVE_PGIDS.clear();
}
let _handlersInstalled = false;
function installGlobalTeardownHandlers() {
  if (_handlersInstalled) return;
  _handlersInstalled = true;
  const onSignal = (sig) => {
    if (ACTIVE_PGIDS.size) console.error(`\n[chaos] caught ${sig}, killing ${ACTIVE_PGIDS.size} sandbox(es)`);
    killAllActive();
    process.exit(1);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("uncaughtException", (err) => {
    console.error("[chaos] uncaughtException:", err?.stack ?? err);
    killAllActive();
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[chaos] unhandledRejection:", err?.stack ?? err);
    killAllActive();
    process.exit(1);
  });
}
installGlobalTeardownHandlers();

/** Kill any near-sandbox / sandbox-launcher processes left over from a
 * prior run before starting a new one. Call ONCE at the top of a run,
 * never per-scenario/per-family (parallel families would kill each
 * other's sandboxes). */
export function staleSweep() {
  for (const pattern of ["sandbox-launcher/target/release/sandbox-launcher", "near-sandbox"]) {
    try { execSync(`pkill -f '${pattern}' 2>/dev/null || true`); } catch { /* none running */ }
  }
}

const WASM_DIR = path.resolve(import.meta.dirname, "../contracts/target/near");

// (R3f: the 'sandbox loses every panic message' claim below was wrong -- the cause was a missing `--cfg near`, see isContractRejection.)
// ROOT CAUSE of the 16t "WebAssembly trap: unreachable at request_resolution"
// (item 16t2): the sandbox deploys contracts/target/near/*/*.wasm, which
// NOTHING rebuilt (cargo-near isn't installed; test.sh never built them).
// mock_outlayer.wasm was a pre-16b build (old request_execution ABI), so the
// escrow's cross-contract call into it trapped; the sandbox surfaces every
// contract panic as a bare "unreachable" (message lost). ensureWasm() now
// rebuilds escrow + both mocks (plain release build, toolchain pinned by
// contracts/rust-toolchain.toml) once per process and copies them where the
// harness reads them. Cargo no-ops when nothing changed. Set
// CHAOS_SKIP_WASM_BUILD=1 to deploy whatever is already in target/near.
let wasmReady = null;
export function ensureWasm() {
  if (process.env.CHAOS_SKIP_WASM_BUILD === "1") return Promise.resolve();
  wasmReady ??= (async () => {
    const contractsDir = path.resolve(import.meta.dirname, "../contracts");
    execSync(
      "cargo build --release --target wasm32-unknown-unknown -p escrow -p mock-intents -p mock-outlayer",
      { cwd: contractsDir, stdio: "pipe", timeout: 540_000 },
    );
    for (const name of ["escrow", "mock_intents", "mock_outlayer"]) {
      const src = path.join(contractsDir, "target/wasm32-unknown-unknown/release", `${name}.wasm`);
      const dst = path.join(WASM_DIR, name, `${name}.wasm`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  })();
  return wasmReady;
}
/** True when a failed tx is a contract rejection carrying EXACTLY this contract error text.
 * R3f: panic messages survive the build now (contracts/.cargo/config.toml sets `--cfg near`, so
 * near-sdk-env's panic_str calls the real panic_utf8 host fn), so the sandbox reports
 * "Smart contract panicked: <text>". The 16t3 loosening (accept any bare trap) is removed. */
export function isContractRejection(e, text) {
  if (!text) throw new Error("isContractRejection requires the exact contract error text");
  return String(e?.message ?? e).includes(text);
}
const wasmPath = (name) => path.join(WASM_DIR, name, `${name}.wasm`);
// TFIX1: the mainnet init args are the truth for judge_chain (see setupSandbox's defaultNewArgs).
const MAINNET_JUDGE_CHAIN = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../release/mainnet-night/args.mainnet.json"), "utf8"),
).judge_chain;
const LAUNCHER_BIN = path.resolve(import.meta.dirname, "sandbox-launcher/target/release/sandbox-launcher");

export const USDC = "usdc.fakes.testnet";
export const WNEAR_TOKEN_ID = "nep141:wrap.testnet";
// Item 3a3 (D-PRICE6/D-BOND1): second whitelisted asset for cross-asset
// chaos coverage, mirroring MOCK_BTC from contracts/escrow/src/tests.rs
// (8dp sats-style units) but under this harness's `*.fakes.testnet`
// naming convention (mock-intents token ids are opaque strings -- no
// `nep141:` prefix is required or checked anywhere in this stack).
export const BTC = "btc.fakes.testnet";
const TGAS = 1_000_000_000_000n;

// ---------------------------------------------------------------------
// Minimal borsh writer, exact mirror of services/common/src/borsh.ts
// (String: u32 LE length prefix + utf8 bytes; u64: 8 bytes LE) -- this is
// the one buffer shape contracts/escrow/src/lib.rs submit_outcome verifies
// against, kept in sync deliberately rather than importing compiled TS.
// ---------------------------------------------------------------------
class BorshWriter {
  chunks = [];
  string(s) {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    this.chunks.push(len, bytes);
    return this;
  }
  u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    this.chunks.push(b);
    return this;
  }
  u64(n) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n), 0);
    this.chunks.push(b);
    return this;
  }
  toBuffer() {
    return Buffer.concat(this.chunks);
  }
}

export function resolverKeypair(seedHex = "11".repeat(32)) {
  const seed = Buffer.from(seedHex, "hex");
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return { publicKeyHex: Buffer.from(kp.publicKey).toString("hex"), secretKey: kp.secretKey, seedHex };
}

export function signOutcome(escrowAccountId, result, secretKey) {
  const msg = new BorshWriter()
    .string(escrowAccountId)
    .u64(result.bet_id)
    .string(result.terms_hash)
    .string(result.outcome)
    .string(result.element_results_hash)
    .u64(result.run_no)
    .u64(BigInt(result.checked_until))
    .u32(result.judge_pair_index ?? 0) // JC1s: signed judge pair index
    .toBuffer();
  const sig = nacl.sign.detached(msg, secretKey);
  return Buffer.from(sig).toString("hex");
}

// ---------------------------------------------------------------------
// Sandbox process lifecycle
// ---------------------------------------------------------------------
async function startSandboxProcess() {
  // detached: true puts this process in its OWN process group (pgid ==
  // its own pid) instead of inheriting ours. That matters for teardown:
  // sandbox-launcher's Rust side starts the real `near-sandbox` binary
  // as its own child (near_sandbox::Sandbox::start_sandbox_with_...),
  // and `proc.kill("SIGKILL")` only ever signals the launcher process
  // itself -- SIGKILL is not forwarded to children, so the launcher
  // dies but near-sandbox is orphaned and keeps running (confirmed
  // live: 20+ leaked near-sandbox processes after a run of back-to-back
  // chaos scenarios). Killing the negative pid signals the whole
  // process group in one syscall, which reaches both.
  const proc = spawn(LAUNCHER_BIN, [], { stdio: ["pipe", "pipe", "pipe"], detached: true });
  ACTIVE_PGIDS.add(proc.pid);
  let buf = "";
  const pendingFastForward = [];
  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    buf += text;
    for (const line of text.split("\n")) {
      if (line.startsWith("FASTFORWARD_OK") || line.startsWith("FASTFORWARD_ERR")) {
        const cb = pendingFastForward.shift();
        if (cb) cb(line);
      }
    }
  });
  const info = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (buf.includes("READY")) {
        proc.stdout.off("data", onData);
        const lines = Object.fromEntries(
          buf.split("\n").filter((l) => l.includes("=")).map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i), l.slice(i + 1)];
          }),
        );
        resolve(lines);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (c) => { buf += c.toString(); });
    proc.on("exit", (code) => reject(new Error(`sandbox-launcher exited early (code ${code}): ${buf}`)));
    setTimeout(() => {
      if (buf.includes("READY")) return;
      reject(new Error(`sandbox-launcher did not become READY in time: ${buf}`));
    }, 30_000);
  });
  return { proc, pendingFastForward, ...info };
}

/** Advances the sandbox chain by `blocks` blocks, moving block_timestamp
 * forward by roughly blocks * min_block_production_delay. Used to
 * exercise deadline/window logic (funding_deadline, settlement_period,
 * resolve_deadline) without waiting on real wall-clock time. */
export function fastForward(ctx, blocks) {
  return new Promise((resolve, reject) => {
    ctx.pendingFastForward.push((line) => {
      if (line.startsWith("FASTFORWARD_OK")) resolve();
      else reject(new Error(line));
    });
    ctx.proc.stdin.write(`FASTFORWARD ${blocks}\n`);
  });
}

// Empirically measured against this harness's sandbox-launcher
// (near-sandbox 2.14.0-rc.4, see item 6b): fast_forward(5000) advanced
// block_timestamp by ~1473.5s of simulated time in ~42.8s of real
// wall-clock time. That gives ~0.2947 sim-seconds/block -- the contract's
// MIN_SETTLEMENT_PERIOD_NS (1h) needs ~12,200 blocks, not the 5,000 a
// handful of scenarios used to loop in repeatedly (which cost 3+ real
// fastForward round-trips, each ~40s, to clear a single 1h window and
// blew the old 120s-per-scenario timeout).
const SIM_NS_PER_BLOCK = 294_700_000; // ~0.2947 sim-seconds/block

/** Blocks needed to advance block_timestamp past `durationNs` of
 * simulated time, with a safety margin for block-timing variance
 * between runs. */
export function blocksForNs(durationNs, marginPct = 0.5) {
  return Math.ceil((Number(durationNs) / SIM_NS_PER_BLOCK) * (1 + marginPct));
}

/** Fast-forwards past `durationNs` of simulated time in ONE jump sized
 * off the measured sim-time/block ratio (instead of looping many small,
 * real-time-expensive fastForward calls) and then calls `fn()`
 * (typically a finalize-style call gated on that duration having
 * elapsed). If `fn()` throws a retryable error (default: contract's
 * "settlement_period not elapsed" message, i.e. the jump undershot),
 * tops up with a smaller additional jump and retries, up to `attempts`
 * times total. Used anywhere a scenario needs to clear the contract's
 * real settlement_period / round-window, not a test-only shortcut --
 * the contract's own timing constants are never touched. */
export async function fastForwardPast(ctx, durationNs, fn, opts = {}) {
  const { attempts = 3, isRetryable = (e) => String(e?.message ?? e).includes("settlement_period not elapsed") } = opts;
  let chunk = blocksForNs(durationNs);
  for (let attempt = 0; attempt < attempts; attempt++) {
    await fastForward(ctx, chunk);
    try {
      return await fn();
    } catch (e) {
      if (attempt === attempts - 1 || !isRetryable(e)) throw e;
      chunk = Math.ceil(chunk * 0.4) + 1000; // smaller top-up on undershoot
    }
  }
}

class Account {
  constructor(nearAccount, accountId) {
    this.inner = nearAccount;
    this.accountId = accountId;
  }
  async call(contractId, methodName, args = {}, { gas = 100n * TGAS, deposit = 0n } = {}) {
    return this.inner.functionCall({
      contractId,
      methodName,
      args,
      gas: typeof gas === "bigint" ? gas : BigInt(gas),
      attachedDeposit: typeof deposit === "bigint" ? deposit : BigInt(deposit),
    });
  }
  async view(contractId, methodName, args = {}) {
    return this.inner.viewFunction({ contractId, methodName, args });
  }
}

// RC1: `opts.buildNewArgs(defaultArgs, { accounts, resolver, rootAccountId })` may return replacement `new()` args
// (the release sandbox test inits with generator output). Default callers are unchanged.
export async function setupSandbox(opts = {}) {
  await ensureWasm();
  const sandboxInfo = await startSandboxProcess();
  const { proc, RPC_ADDR, ROOT_ACCOUNT_ID, ROOT_PRIVATE_KEY } = sandboxInfo;

  const keyStore = new keyStores.InMemoryKeyStore();
  const rootKp = KeyPair.fromString(ROOT_PRIVATE_KEY);
  await keyStore.setKey("sandbox", ROOT_ACCOUNT_ID, rootKp);

  const near = await connect({ networkId: "sandbox", nodeUrl: RPC_ADDR, keyStore, headers: {} });
  const rootNear = await near.account(ROOT_ACCOUNT_ID);

  const names = ["intents", "outlayer", "escrow", "fee", "keeper", "operator", "guardian", "registry", "maker", "taker", "third"];
  const accounts = {};
  for (const name of names) {
    const accountId = `${name}.${ROOT_ACCOUNT_ID}`;
    const kp = KeyPair.fromRandom("ed25519");
    await keyStore.setKey("sandbox", accountId, kp);
    await rootNear.createAccount(accountId, kp.getPublicKey(), utils.format.parseNearAmount("50"));
    const nearAccount = await near.account(accountId);
    accounts[name] = new Account(nearAccount, accountId);
  }

  const { intents, outlayer, escrow, fee, keeper, operator, guardian, registry, maker, taker, third } = accounts;

  await deployContract(intents, wasmPath("mock_intents"));
  await intents.call(intents.accountId, "new", {});

  await deployContract(outlayer, wasmPath("mock_outlayer"));
  await outlayer.call(outlayer.accountId, "new", {});

  const resolver = resolverKeypair();

  await deployContract(escrow, wasmPath("escrow"));
  const defaultNewArgs = {
    intents: intents.accountId,
    usdc_token_id: USDC,
    outlayer: outlayer.accountId,
    operator: operator.accountId,
    guardian: guardian.accountId,
    registry: registry.accountId,
    fee_account: fee.accountId,
    keeper: keeper.accountId,
    limits: {
      max_stake: "1000000000000",
      max_offer_ttl_secs: 31_536_000, // 1yr protocol max per Marketplace doc
      // D-PRICE6 removed Limits.max_stake_per_side_usdc (now per-asset,
      // see asset_limits below).
      max_stake_per_side_near: "100000000000000000000000000", // 100 NEAR placeholder, unused path
      max_rounds: 2, // D-DISPUTE1 default (crate::DEFAULT_MAX_ROUNDS; supersedes D-AUDIT8's 3)
    },
    beta_sunset_ns: null, // D6: default (deploy + 90d)
    // Sub-job 1 (D-PRICE6): immutable per-asset whitelist. USDC entries
    // mirror contracts/escrow/src/tests.rs' `default_asset_limits()`
    // (the lenient $-no-floor table most existing cargo tests build on,
    // since this harness's default fixture stakes are 1 USDC) -- NOT
    // the stricter `spec_default_asset_limits()` $5 floor. BTC entries
    // mirror the same file's `MOCK_BTC` AssetLimit (8dp sats-style
    // units, ~$5..$250/side band at the spec's reference BTC price).
    asset_limits: [
      [
        USDC,
        {
          min_per_side: "20", // D-FEEMIN1: min_fee_per_side 1 requires min_per_side >= 20
          min_fee_per_side: "1", // D-FEEMIN1 fixture: tiny so dust-scale scenario stakes keep working
          max_per_side: "250000000", // 250 USDC @ 6dp (DEFAULT_MAX_STAKE_PER_SIDE_USDC)
          run_price: "5000", // DEFAULT_RUN_PRICE
          min_bond: "5000000", // USDC_MIN_BOND ($5 @ 6dp)
          min_objection: "1000000", // USDC_MIN_OBJECTION ($1 @ 6dp)
          storage_per_kib: String(STG_FIXTURE_RATE), // STG1b fixture (= contracts/escrow STG_FIXTURE_RATE)
        },
      ],
      [
        BTC,
        {
          min_per_side: "6501", // ~$5 @ $76,909/BTC, 8dp
          min_fee_per_side: "325", // D-FEEMIN1: = min_per_side/20
          max_per_side: "325059", // ~$250 @ $76,909/BTC, 8dp
          run_price: "1", // BTC-denominated run cost, 8dp; just needs >0
          min_bond: "6501", // same ~$5 floor as min_per_side, BTC 8dp
          min_objection: "1300", // ~$1 @ $76,909/BTC, 8dp
          storage_per_kib: String(STG_FIXTURE_RATE), // STG1b fixture
        },
      ],
    ],
    // D-KEY1 (7g2): pinned resolver keys at init. The harness's single
    // `resolver` keypair signs BOTH outcomes (signOutcome) and
    // sourcecheck attestations (buildSourceCheckAttestation), so the
    // fixed test key is reused for both outcome_pubkey and
    // attest_pubkey here -- consistent with how this harness actually
    // signs things. resolver_wasm_hash is an arbitrary fixed 64-hex
    // test value; the harness never loads a real resolver wasm.
    outcome_pubkey: resolver.publicKeyHex,
    attest_pubkey: resolver.publicKeyHex,
    resolver_wasm_hash: "b".repeat(64),
    outlayer_config: {
      wasm_base_url: "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet",
      secrets_profile: "praetorial-resolver",
      secrets_account_id: ROOT_ACCOUNT_ID,
    },
    // JC1/JC1x (D-JUDGECHAIN1a #3): new() requires 2..=4 pairs. TFIX1: use the exact chain from the mainnet
    // init args (release/mainnet-night/args.mainnet.json) so the sandbox inits like the frozen mainnet escrow.
    judge_chain: MAINNET_JUDGE_CHAIN.map((p) => ({ ...p })),
  };
  const newArgs = opts.buildNewArgs ? opts.buildNewArgs(defaultNewArgs, { accounts, resolver, rootAccountId: ROOT_ACCOUNT_ID }) : defaultNewArgs;
  await escrow.call(escrow.accountId, "new", newArgs);

  return {
    proc, pendingFastForward: sandboxInfo.pendingFastForward, near, keyStore, rootNear, rootAccountId: ROOT_ACCOUNT_ID,
    intents, outlayer, escrow, fee, keeper, operator, guardian, registry, maker, taker, third, resolver,
    async teardown() {
      // Kill the WHOLE process group (negative pid), not just the
      // launcher -- see startSandboxProcess's doc. Falls back to a
      // plain kill if the group signal fails for any reason (e.g.
      // already reaped), so teardown never throws and blocks the
      // runner's finally-block cleanup.
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead; nothing to do.
        }
      }
      ACTIVE_PGIDS.delete(proc.pid);
    },
    async extraAccount(name) {
      const accountId = `${name}.${ROOT_ACCOUNT_ID}`;
      const kp = KeyPair.fromRandom("ed25519");
      await keyStore.setKey("sandbox", accountId, kp);
      await rootNear.createAccount(accountId, kp.getPublicKey(), utils.format.parseNearAmount("50"));
      const nearAccount = await near.account(accountId);
      return new Account(nearAccount, accountId);
    },
  };
}

async function deployContract(account, wasmFilePath) {
  const wasm = fs.readFileSync(wasmFilePath);
  return account.inner.deployContract(wasm);
}

// ---------------------------------------------------------------------
// Bet lifecycle helpers
// ---------------------------------------------------------------------
export async function mint(intents, account, amount, tokenId = USDC) {
  return intents.call(intents.accountId, "mint", { account_id: account.accountId, token_id: tokenId, amount: String(amount) }, { gas: 30n * TGAS });
}

export async function balance(intents, account, tokenId = USDC) {
  const b = await intents.view(intents.accountId, "mt_balance_of", { account_id: account.accountId, token_id: tokenId });
  return BigInt(b);
}

// D-FETCH2 (item 7f2b): the exact message the contract verifies
// against, mirroring resolver/core::sourcecheck_message and
// services/common/src/sourceCheck.ts::buildSourceCheckMessage
// byte-for-byte.
export function sourceCheckMessage(specHash, checkedAtNs) {
  return `praetorial:sourcecheck:v1:${specHash}:${checkedAtNs}`;
}

// D-FETCH2 (item 7f2b): signs an Open attestation with the resolver's
// own secretKey (same keypair `ctx.resolver` already carries for
// `signOutcome`) -- checked_at defaults to "now" so it's always fresh.
//
// item 7g2b (chaos-checked-at): `checked_at` MUST be emitted as a JSON
// *number*, not a string -- the contract's SourceCheckAttestation.checked_at
// is `u64`, so a JSON string there fails deserialization and the whole
// ft_transfer_call msg is rejected (Open never happens, deposit refunded).
// Every chaos Open scenario was ERROR/BREAK because of this.
//
// checkedAtNs stays a JS number end-to-end (same approach as
// services/e2e/run.ts's checkedAtNs), and the signed message's decimal
// text is built from that exact number via String(), so whatever
// JSON.stringify later emits for the attestation object necessarily
// matches the text that was signed (JSON.stringify and String() use the
// same digit-producing algorithm for integer-valued numbers). Default
// "now" is rounded down to a multiple of 2^12 ns: at nanosecond-epoch
// magnitude (~1.7e18, far above Number.MAX_SAFE_INTEGER's 2^53) a double's
// precision step (ulp) is a few hundred ns, so rounding to a coarser,
// guaranteed-representable grid (2^12 ns >> the ulp here) keeps the value
// stable under any incidental float round-tripping, while staying safely
// <= the sandbox's block_timestamp and within the 1h freshness window.
const CHECKED_AT_GRANULARITY_NS = 4096; // 2^12
function defaultCheckedAtNs() {
  return Math.floor((Date.now() * 1_000_000) / CHECKED_AT_GRANULARITY_NS) * CHECKED_AT_GRANULARITY_NS;
}
export function buildSourceCheckAttestation(termsHash, resolverSecretKey, checkedAtNs) {
  let checkedAt;
  if (checkedAtNs === undefined) {
    checkedAt = defaultCheckedAtNs();
  } else if (typeof checkedAtNs === "bigint") {
    checkedAt = Number(checkedAtNs);
  } else {
    checkedAt = checkedAtNs;
  }
  const msg = Buffer.from(sourceCheckMessage(termsHash, String(checkedAt)), "utf8");
  const sig = nacl.sign.detached(msg, resolverSecretKey);
  return { checked_at: checkedAt, signature_hex: Buffer.from(sig).toString("hex") };
}

// TransferMsg is internally tagged (#[serde(tag = "kind")] on the Rust
// side) -- {"kind": "Open", envelope: {...}}, not {"Open": {...}}. Same
// for Take/Bond/Objection below.
export function buildOpenMsg(overrides = {}) {
  const now = Date.now() * 1_000_000;
  const termsHash = overrides.terms_hash ?? "a".repeat(64);
  const base = {
    kind: "Open",
    // D-FETCH2 (item 7f2b): Open now requires a resolver-signed,
    // fresh sources-reachable attestation for this exact term sheet.
    // Callers that don't pass a resolver secret key explicitly
    // (overrides.resolverSecretKey) can't sign for a resolver_pubkey
    // they don't hold the key to -- openBet below always passes
    // ctx.resolver.secretKey.
    attestation: overrides.resolverSecretKey
      ? buildSourceCheckAttestation(termsHash, overrides.resolverSecretKey, overrides.checked_at)
      : undefined,
    envelope: {
      bet_id: 0, // server-assigned; placeholder required by the struct shape
      version: 1,
      maker: overrides.maker,
      taker_allow: overrides.taker_allow ?? "Any",
      terms_hash: termsHash,
      // D-KEY1 (7g2): resolver_wasm_hash/resolver_pubkey are no longer
      // envelope fields -- they're pinned contract-level config set
      // once at new() (see setupSandbox's outcome_pubkey/attest_pubkey/
      // resolver_wasm_hash above) and read back via resolver_keys().
      models_snapshot_hash: "c".repeat(64),
      outcomes: ["YES", "NO"],
      maker_side: "YES",
      // D-PRICE6: required fields, missing here was the root cause of
      // every scenario's envelope.sanity_check() silently rejecting
      // (full refund) at handle_open -- default to same-asset USDC;
      // the cross-asset BTC scenario overrides both explicitly.
      maker_asset: overrides.maker_asset ?? USDC,
      taker_asset: overrides.taker_asset ?? USDC,
      stake_maker: String(overrides.stake_maker ?? "1000000"),
      stake_taker: String(overrides.stake_taker ?? "1000000"),
      // D-PRICE6 sub-job 2: additional (asset, amount) options; empty
      // unless a scenario explicitly sets some.
      taker_options: overrides.taker_options ?? [],
      fee_bps: overrides.fee_bps ?? 100,
      // D-ECON5: no per-bet reserve any more -- stake + storage only.
      // STG1 (D-STORAGE1): the envelope field must be "0"; the contract computes each side's charge from its asset rate.
      storage_charge_per_side: "0",
      keep_terms: overrides.terms != null,
      terms: overrides.terms ?? null,
      max_paid_runs: overrides.max_paid_runs ?? 3,
      tier: overrides.tier ?? 1,
      // D-REF1: no arbiter_fee any more -- the arbiter's ruling power
      // itself is unchanged.
      arbiter: overrides.arbiter ?? null,
      funding_deadline: overrides.funding_deadline ?? now + 3600 * 1e9,
      early_settle_outcome: overrides.early_settle_outcome ?? null,
      finality_delay: overrides.finality_delay ?? 0,
      settlement_period: overrides.settlement_period ?? 3600 * 1e9,
      resolve_deadline: overrides.resolve_deadline ?? now + 7 * 24 * 3600 * 1e9,
      consent_party_controlled: overrides.consent_party_controlled ?? false,
    },
  };
  return JSON.stringify(base);
}

// STG1b (D-STORAGE1): client-side copy of the contract's formula (Envelope::storage_for / estimated_storage_bytes).
export const STG_FIXTURE_RATE = 6305n;
const MAX_HASH_LEN = 128, MAX_ACCOUNT_ID_LEN = 64, STORAGE_EVENT_OVERHEAD_BYTES = 256;
export function estimatedStorageBytes({ terms = "", termsHash = "a".repeat(64), modelsHash = "c".repeat(64) } = {}) {
  return Buffer.byteLength(terms ?? "") + termsHash.length + modelsHash.length + 3 * 5 * (MAX_HASH_LEN + MAX_ACCOUNT_ID_LEN) + STORAGE_EVENT_OVERHEAD_BYTES;
}
export function storageFor(bytes, ratePerKib) {
  const c = (BigInt(bytes) * BigInt(ratePerKib) + 2047n) / 2048n;
  return c < 1n ? 1n : c;
}
/** One side's storage charge for a bet shaped by `overrides` (terms / terms_hash / storage_per_kib override the fixture). */
export function sideStorage(overrides = {}) {
  const bytes = estimatedStorageBytes({ terms: overrides.terms ?? "", termsHash: overrides.terms_hash ?? "a".repeat(64) });
  return storageFor(bytes, overrides.storage_per_kib ?? STG_FIXTURE_RATE);
}
// stake + this side's own storage charge (same fixture rate for the harness's two assets unless overridden).
export function sideAmount(overrides, side) {
  const stake = BigInt(side === "maker" ? (overrides.stake_maker ?? "1000000") : (overrides.stake_taker ?? "1000000"));
  return stake + sideStorage(overrides);
}

export async function openBet(ctx, overrides = {}) {
  const makerAccount = overrides.makerAccount ?? ctx.maker;
  // D-FETCH2 (item 7f2b): always sign a real Open attestation with the
  // sandbox's own resolver keypair -- the same keypair pinned as both
  // outcome_pubkey and attest_pubkey at escrow new() (D-KEY1, 7g2).
  const msg = buildOpenMsg({
    ...overrides,
    maker: makerAccount.accountId,
    resolverSecretKey: ctx.resolver.secretKey,
  });
  const amount = sideAmount(overrides, "maker");
  // D-PRICE6: deposit must arrive in the maker's own stake asset, not
  // hardcoded USDC -- mt_on_transfer rejects (full refund) any
  // token_id that doesn't match envelope.maker_asset.
  const tokenId = overrides.maker_asset ?? USDC;
  await mint(ctx.intents, makerAccount, amount, tokenId);
  await makerAccount.call(
    ctx.intents.accountId,
    "transfer_with_msg",
    { receiver_id: ctx.escrow.accountId, token_id: tokenId, amount: String(amount), msg },
    { gas: 250n * TGAS },
  );
  const open = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 });
  const mine = open.filter((b) => b.envelope.maker === makerAccount.accountId);
  return mine[mine.length - 1];
}

export async function takeBet(ctx, betId, overrides = {}, takerAccount) {
  const taker = takerAccount ?? ctx.taker;
  const amount = sideAmount(overrides, "taker");
  // D-PRICE6: deposit must arrive in the taker's own stake asset (the
  // bet's taker_asset, or whichever taker_options entry's asset is
  // being exercised -- same as maker_asset above).
  const tokenId = overrides.taker_asset ?? USDC;
  await mint(ctx.intents, taker, amount, tokenId);
  const msg = JSON.stringify({ kind: "Take", bet_id: betId, invite_sig: overrides.invite_sig ?? null });
  await taker.call(
    ctx.intents.accountId,
    "transfer_with_msg",
    { receiver_id: ctx.escrow.accountId, token_id: tokenId, amount: String(amount), msg },
    { gas: 250n * TGAS },
  );
  return ctx.escrow.view(ctx.escrow.accountId, "get_bet", { bet_id: betId });
}

export async function getBet(ctx, betId) {
  return ctx.escrow.view(ctx.escrow.accountId, "get_bet", { bet_id: betId });
}

/** Local-signer stand-in for OutLayer's TEE signature (no NEAR AI call). */
export async function submitOutcome(ctx, bet, { outcome = "YES", runNo, checkedUntil, badSig = false, caller } = {}) {
  const result = {
    bet_id: bet.envelope?.bet_id ?? bet.bet_id,
    terms_hash: bet.envelope.terms_hash,
    outcome,
    element_results_hash: "0".repeat(64),
    run_no: runNo ?? bet.next_expected_run_no,
    checked_until: checkedUntil ?? String(BigInt(Date.now()) * 1_000_000n),
    judge_pair_index: 0, // JC1s
  };
  const sig = signOutcome(ctx.escrow.accountId, result, badSig ? nacl.sign.keyPair().secretKey : ctx.resolver.secretKey);
  const caller_ = caller ?? ctx.keeper;
  return caller_.call(ctx.escrow.accountId, "submit_outcome", { result, signature_hex: sig }, { gas: 60n * TGAS });
}

/** OQ-T11: `finalize`/`void_after_deadline` only persist
 * the payout ledger now (bet left at `Finalized`); `drain_payouts` is
 * the only thing that actually fires transfers and promotes
 * `Finalized` -> `Settled` once the ledger empties. Every chaos fixture
 * that used to assert `status === "Settled"` immediately after
 * `finalize` must drive the drain loop first. Calls
 * `drain_payouts(bet_id, 10)` (MAX_DRAIN_BATCH) repeatedly, from an
 * arbitrary caller (`ctx.third` by default) to prove the call is truly
 * permissionless, until `is_fully_paid` is true or `maxCalls` is hit.
 * Returns the number of drain_payouts calls made. */
export async function drainUntilSettled(ctx, betId, { caller, maxCalls = 20, checkAfterEach } = {}) {
  const drainer = caller ?? ctx.third;
  let calls = 0;
  for (; calls < maxCalls; calls++) {
    const fullyPaid = await ctx.escrow.view(ctx.escrow.accountId, "is_fully_paid", { bet_id: betId });
    if (fullyPaid) break;
    await drainer.call(ctx.escrow.accountId, "drain_payouts", { bet_id: betId, limit: 10 }, { gas: tgas(300) });
    if (checkAfterEach) await checkAfterEach(calls + 1);
    const fullyPaidAfter = await ctx.escrow.view(ctx.escrow.accountId, "is_fully_paid", { bet_id: betId });
    if (fullyPaidAfter) break;
  }
  return calls;
}

export function appendResult(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}

// Attached deposit for request_resolution. Must clear the escrow's
// MIN_RESOLUTION_COMPUTE_DEPOSIT (0.0200625 NEAR since 16d, 762eb09) plus
// input_data storage. The old 0.02 NEAR literal fell just short, so every
// scenario's request_resolution reverted (surfaced as a bare
// "WebAssembly trap: unreachable" -- the require() message is lost by the
// sandbox, not a build problem). 0.05 NEAR leaves headroom; the unused
// compute is refunded, so over-attaching is harmless.
export const RESOLUTION_DEPOSIT = 50_000_000_000_000_000_000_000n;

export function tgas(n) {
  return BigInt(n) * TGAS;
}

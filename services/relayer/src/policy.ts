// Allowlist enforcement for the real NEP-366 meta-tx relayer.
//
// The task's method list (open/take/challenge/submit_exhibit/cancel/
// claim) maps onto this contract's ACTUAL entry points as
// follows (verified against contracts/escrow/src/lib.rs's `pub fn` list):
//   - open / take / challenge  -> these move stake, so in this stack they
//     travel as `transfer_with_msg` (NEP-245-style Transfer-with-msg) on
//     the MOCK intents contract (testnet-only stand-in), msg kind
//     Open/Take/Bond, exactly like services/privy-e2e's signerPolicy.ts
//     and the existing services/relayer/src/relayer.ts module doc already
//     describe. There is no direct `open`/`take`/`challenge` method on
//     escrow itself.
//   - submit_exhibit -> escrow's real method name is `submit_exhibits`.
//   - cancel -> exists verbatim on escrow.
//   - claim -> escrow has no method literally named `claim`; payouts are
//     permissionless (`drain_payouts`/`retry_payout`) and resolution is
//     user-triggered via `request_resolution`. Both are included here as
//     the closest real equivalents of a user "claiming" their result.
// This mapping is documented, not guessed silently, per README.md.
//
// `transfer_with_msg` vs real NEP-141 `ft_transfer_call` -- these are TWO
// DIFFERENT SHAPES, now both actually validated (previously only the
// mock's shape was exercised, per README "known gaps"):
//   - `transfer_with_msg` is this repo's mock-intents method, called ON
//     the intents contract, and its args embed a `token_id` field
//     (`{ token_id, receiver_id, amount, msg }`) because one intents
//     contract moves many different tokens.
//   - `ft_transfer_call` is the REAL NEP-141 standard method
//     (https://nomicon.io/Standards/Tokens/FungibleToken/Core), called ON
//     THE TOKEN CONTRACT ITSELF -- there is no `token_id` arg because the
//     receiverId of the outer FunctionCall IS the token (verified against
//     the real `usdc.testnet` / `wrap.testnet` contracts on
//     test.rpc.fastnear.com: both are plain NEP-141 FTs, no token_id
//     param in their ft_transfer_call). Its real arg shape is
//     `{ receiver_id: string, amount: string, msg: string, memo?: string }`
//     -- `amount` MUST be a decimal string (NEP-141 requires U128 to be
//     JSON-serialized as a string, not a number, to avoid float
//     precision loss) and `memo` is optional. `receiver_id` here is the
//     payment destination (escrow), distinct from the outer
//     DelegateAction.receiverId (the token contract).
export class PolicyViolation extends Error {}

export interface RelayerPolicyConfig {
  escrowContract: string;
  intentsContract: string; // mock-intents on testnet; intents.near in the real flow
  usdcTokenId: string; // the launch USDC asset (bare NEP-141 contract or "nep141:<contract>"); always stakeable
  /** LIVE1 / D-CAP3: assets that may be staked (open/take/bond via transfer_with_msg, or a direct NEP-141
   * ft_transfer_call to the escrow). Bare contract ids and "nep141:" ids are both accepted and normalised.
   * Should list exactly the assets the escrow enables (`asset_limit(id)` non-null); set it via STAKE_ASSET_IDS in
   * wrangler.toml. Unset = usdcTokenId + fundTokenContracts. */
  stakeAssetIds?: string[];
  /** Deprecated and ignored (D-CAP3: no relayer stake cap; the contract's asset_limits are the only limit). */
  maxTransferAmount?: bigint;
  /** RELAYFUND1 / D-FUND1 path 3: token contracts a user may `ft_transfer_call` into their betting balance (the intents contract). Unset/empty = path disabled. */
  fundTokenContracts?: string[];
  /** RELAYFUND1: the wNEAR contract on which `near_deposit` (wrapping the user's own NEAR) is sponsored. Unset = disabled. */
  wnearContract?: string;
}

/** The six D-ASSET1 launch assets' NEAR token contracts (mainnet ids, apps/web/lib/assets.ts) plus the two testnet
 * ids (usdc.testnet, wrap.testnet). Default `fundTokenContracts`; override with FUND_TOKEN_CONTRACTS. */
export const LAUNCH_TOKEN_CONTRACTS: readonly string[] = [
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // USDC
  "usdt.tether-token.near",
  "btc.omft.near",
  "wrap.near",
  "eth.omft.near",
  "zec.omft.near",
  "usdc.testnet",
  "wrap.testnet",
];

/** "wrap.testnet" -> "nep141:wrap.testnet"; ids that already carry a standard prefix ("nep141:", "nep245:") are kept. */
export function normalizeAssetId(id: string): string {
  const t = String(id ?? "").trim();
  if (t === "") return "";
  return /^nep\d+:/.test(t) ? t : `nep141:${t}`;
}

/** The normalised set of stakeable asset ids (see RelayerPolicyConfig.stakeAssetIds). */
export function stakeAssetSet(cfg: RelayerPolicyConfig): Set<string> {
  const ids = cfg.stakeAssetIds && cfg.stakeAssetIds.length > 0 ? cfg.stakeAssetIds : [cfg.usdcTokenId, ...(cfg.fundTokenContracts ?? [])];
  return new Set(ids.map(normalizeAssetId).filter(Boolean));
}

/** NEP-141 token contracts whose ft_transfer_call may stake directly into the escrow. */
function stakeTokenContracts(cfg: RelayerPolicyConfig): Set<string> {
  return new Set([...stakeAssetSet(cfg)].filter((id) => id.startsWith("nep141:")).map((id) => id.slice("nep141:".length)));
}

export const ESCROW_DIRECT_METHODS = new Set([
  "cancel",
  "submit_exhibits",
  "request_resolution",
  "drain_payouts",
  "retry_payout",
  // Permissionless post-shutdown refund (contracts/escrow/src/lib.rs
  // `pub fn emergency_refund(&mut self, bet_id: u64)`, no #[payable] --
  // takes no deposit). Any user stuck on a shut-down contract must be
  // able to self-serve this gaslessly through the relayer, same as
  // `cancel`/`drain_payouts` above.
  "emergency_refund",
  // C1 / D-CONCEDE1: `pub fn concede(&mut self, bet_id: u64)`, no
  // #[payable]. The contract only lets the bet's maker or taker call it
  // (predecessor check), so a relayed concede can only ever be the
  // signer conceding their own side. Same {bet_id}-only args as
  // emergency_refund. (D-SETTLE3: no mutual settle exists.)
  "concede",
  // RELAYREF1 / D-FE10B1: contracts/escrow/src/lib.rs
  // `pub fn amend_referee(&mut self, bet_id: u64, new_referee_json: String)`,
  // not #[payable] (so it stays OUT of ESCROW_PAYABLE_METHODS). The contract
  // enforces who may amend: the maker alone while Open, both bettors while
  // plain Taken (RA1 / D-REFUI4a). Args are validated by assertAmendRefereeArgs.
  "amend_referee",
  // RLYFIN1 / D-FINREL1: contracts/escrow/src/lib.rs `pub fn finalize(&mut self, bet_id: u64)`,
  // permissionless, not #[payable]. Same {bet_id}-only args as concede/emergency_refund.
  "finalize",
  // RLYREF2 / D-REFREL1: contracts/escrow/src/lib.rs `pub fn referee_rule(&mut self, bet_id: u64, outcome: String)`,
  // not #[payable]; only the named referee may rule (enforced on-chain). Args: assertRefereeRuleArgs.
  "referee_rule",
]);

/** Escrow methods that are `#[payable]` on-chain. Every other allowlisted
 * escrow method panics if a deposit is attached, so sponsoring such a call
 * only burns relayer gas (gas griefing). */
// RELAYDEP1 / D-RELAYDEP1: EMPTY on purpose. A NEP-366 delegate's inner deposit is charged to the RELAYER (outer signer), so no escrow
// method is ever relayed with a deposit; payable calls (request_resolution's bond) are signed and paid by the user directly.
export const ESCROW_PAYABLE_METHODS = new Set<string>();

/** NEAR account-id grammar (NEAR protocol spec): 2..64 chars, lowercase
 * alphanumerics separated by single `.`, `-` or `_`. The sender id is the
 * key for rate-limit / budget / replay state, so non-canonical spellings
 * ("Alice.testnet", trailing spaces, unicode) must never reach the guards
 * (each would otherwise get a fresh budget). */
export function assertValidAccountId(id: unknown, what: string): void {
  if (
    typeof id !== "string" ||
    id.length < 2 ||
    id.length > 64 ||
    !/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id)
  ) {
    throw new PolicyViolation(`${what} is not a valid NEAR account id`);
  }
}

/** INTENTS1: `mt_transfer_call` is the real intents.near stake path (open/take/bond); `transfer_with_msg` is the legacy
 * mock-intents-only shape, kept for the testnet mock and refused when the intents contract is the real intents.near. */
export const INTENTS_METHODS = new Set(["mt_transfer_call", "transfer_with_msg", "ft_withdraw"]);
/** The real NEAR Intents contract (mainnet), which has no `transfer_with_msg` (view probe: MethodNotFound). */
export const REAL_INTENTS_CONTRACT = "intents.near";
/** Largest NEP-145 registration deposit the web will pay for a withdraw (0.01 NEAR; a registration costs 0.00125). SEC1/MON-1:
 * the relayer no longer relays storage_deposit at all; the user signs and pays it. */
export const MAX_STORAGE_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n;
export const NEP141_METHODS = new Set(["ft_transfer_call"]);

/** Decimal-string U128 check per NEP-141/JSON-RPC convention: amount
 * must be a non-empty string of digits (no sign, no decimal point, no
 * leading '+', no scientific notation, no raw JSON number -- a bare
 * number would silently lose precision above 2^53 and the standard
 * requires a string specifically to avoid that). */
function assertDecimalU128String(value: unknown, fieldName: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new PolicyViolation(`${fieldName} must be a decimal string (NEP-141 U128), got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function parseArgsJson(argsBytes: Uint8Array, context: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(argsBytes as ArrayLike<number>)) || "{}");
  } catch {
    throw new PolicyViolation(`${context} args are not valid JSON`);
  }
}

/** Validates the mock intents contract's `transfer_with_msg` args:
 * `{ token_id, receiver_id, amount, msg }`. Testnet-only shape, kept
 * distinct from the real NEP-141 ft_transfer_call below. */
function assertTransferWithMsgArgs(cfg: RelayerPolicyConfig, argsBytes: Uint8Array): void {
  const args = parseArgsJson(argsBytes, "transfer_with_msg");
  const msgReceiver = String(args.receiver_id ?? "");
  if (msgReceiver !== cfg.escrowContract) {
    throw new PolicyViolation(
      `transfer_with_msg receiver_id "${msgReceiver}" is not the escrow contract "${cfg.escrowContract}"`,
    );
  }
  const tokenId = String(args.token_id ?? "");
  const allowed = stakeAssetSet(cfg);
  if (!tokenId || !allowed.has(normalizeAssetId(tokenId))) {
    throw new PolicyViolation(`transfer_with_msg token_id "${tokenId}" is not an asset the escrow accepts (allowed: ${[...allowed].join(", ")})`);
  }
  // D-CAP3: no relayer stake cap; the escrow's asset_limits decide.
  const amount = assertDecimalU128String(args.amount, "transfer_with_msg amount");
  if (amount <= 0n) {
    throw new PolicyViolation(`transfer_with_msg amount must be > 0, got ${amount}`);
  }
  if (typeof args.msg !== "string") {
    throw new PolicyViolation("transfer_with_msg msg must be a string");
  }
}

/** INTENTS1: real intents.near NEP-245 `mt_transfer_call(receiver_id, token_id, amount, approval?, memo?, msg)`
 * (near/intents rev 16d04f6e contracts/defuse/src/contract/tokens/nep245/core.rs; fixtures/intents_near/real_abi.json):
 * #[payable] + assert_one_yocto, approvals unsupported. Allowed only as a stake into the escrow: receiver_id = escrow,
 * token_id = an enabled stake asset in its prefixed intents form, amount > 0 decimal string, msg a string, memo an
 * optional string, approval absent/null, nothing else. The escrow itself parses msg (Open/Take/Bond/Objection). */
function assertMtTransferCallArgs(cfg: RelayerPolicyConfig, argsBytes: Uint8Array, depositYocto: bigint): void {
  if (depositYocto !== 1n) throw new PolicyViolation("mt_transfer_call deposit must be exactly 1 yoctoNEAR (intents.near assert_one_yocto)");
  const args = parseArgsJson(argsBytes, "mt_transfer_call");
  const allowedKeys = new Set(["receiver_id", "token_id", "amount", "approval", "memo", "msg"]);
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) throw new PolicyViolation(`mt_transfer_call args contain unexpected field "${key}"`);
  }
  if (args.receiver_id !== cfg.escrowContract) {
    throw new PolicyViolation(`mt_transfer_call receiver_id ${JSON.stringify(args.receiver_id)} is not the escrow contract "${cfg.escrowContract}"`);
  }
  const tokenId = args.token_id;
  if (typeof tokenId !== "string" || !/^nep\d+:/.test(tokenId)) {
    throw new PolicyViolation(`mt_transfer_call token_id must be a prefixed intents token id (e.g. nep141:wrap.near), got ${JSON.stringify(tokenId)}`);
  }
  const allowed = stakeAssetSet(cfg);
  if (!allowed.has(tokenId)) {
    throw new PolicyViolation(`mt_transfer_call token_id "${tokenId}" is not an asset the escrow accepts (allowed: ${[...allowed].join(", ")})`);
  }
  const amount = assertDecimalU128String(args.amount, "mt_transfer_call amount");
  if (amount <= 0n) throw new PolicyViolation("mt_transfer_call amount must be > 0");
  if (typeof args.msg !== "string") throw new PolicyViolation("mt_transfer_call msg must be a string");
  if (args.approval !== undefined && args.approval !== null) throw new PolicyViolation("mt_transfer_call approval must be null (intents.near: approvals are not supported)");
  if (args.memo !== undefined && args.memo !== null && typeof args.memo !== "string") {
    throw new PolicyViolation("mt_transfer_call memo, if present, must be a string or null");
  }
}

/** Validates the REAL NEP-141 `ft_transfer_call` args as defined by the
 * standard: `{ receiver_id: string, amount: string, msg: string, memo?:
 * string }`. Deliberately rejects a `token_id` field if present -- real
 * NEP-141 tokens have no such arg (the token IS the receiverId of the
 * outer FunctionCall, checked by the caller against cfg.usdcTokenId
 * before this is even invoked), so a delegate that includes one is
 * either targeting the wrong shape or trying to smuggle extra fields
 * past a looser validator; failing closed here is intentional. */
function assertFtTransferCallArgs(cfg: RelayerPolicyConfig, argsBytes: Uint8Array): void {
  const args = parseArgsJson(argsBytes, "ft_transfer_call");
  if ("token_id" in args) {
    throw new PolicyViolation(
      `ft_transfer_call args must not include "token_id" (real NEP-141 has no such field -- the token is the receiverId itself); got ${JSON.stringify(args.token_id)}`,
    );
  }
  const receiverId = args.receiver_id;
  if (typeof receiverId !== "string" || receiverId.length === 0) {
    throw new PolicyViolation(`ft_transfer_call receiver_id must be a non-empty string, got ${JSON.stringify(receiverId)}`);
  }
  if (receiverId !== cfg.escrowContract) {
    throw new PolicyViolation(`ft_transfer_call receiver_id "${receiverId}" is not the escrow contract "${cfg.escrowContract}"`);
  }
  const amount = assertDecimalU128String(args.amount, "ft_transfer_call amount");
  if (amount <= 0n) {
    throw new PolicyViolation(`ft_transfer_call amount must be > 0, got ${amount}`);
  }
  // D-CAP3: no relayer stake cap; the escrow's asset_limits decide.
  if (typeof args.msg !== "string") {
    throw new PolicyViolation(`ft_transfer_call msg must be a string, got ${JSON.stringify(args.msg)}`);
  }
  // memo is OPTIONAL per NEP-141 -- only type-check it if present at all.
  if ("memo" in args && args.memo !== null && args.memo !== undefined && typeof args.memo !== "string") {
    throw new PolicyViolation(`ft_transfer_call memo, if present, must be a string or null, got ${JSON.stringify(args.memo)}`);
  }
  // Reject any other unexpected field -- NEP-141's ft_transfer_call takes
  // exactly these four, so anything else is either a different method's
  // args smuggled in under this name or a non-compliant token contract.
  const allowed = new Set(["receiver_id", "amount", "msg", "memo"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new PolicyViolation(`ft_transfer_call args contain unexpected field "${key}"`);
    }
  }
}

/** RELAYFUND1: `ft_transfer_call` that moves the SIGNER's own tokens into the SIGNER's betting balance on the intents
 * contract. Exactly {receiver_id: intents, amount, msg: JSON {"receiver_id": sender}} (+ optional memo); the beneficiary
 * is pinned to the delegate's sender so a relayed call can never credit anyone else. 1 yocto exactly. */
function assertMoveToBettingArgs(cfg: RelayerPolicyConfig, argsBytes: Uint8Array, depositYocto: bigint, senderId: string | undefined): void {
  if (!senderId) throw new PolicyViolation("move-to-betting requires the delegate sender id");
  if (depositYocto !== 1n) throw new PolicyViolation("ft_transfer_call deposit must be exactly 1 yoctoNEAR");
  const args = parseArgsJson(argsBytes, "ft_transfer_call");
  const allowed = new Set(["receiver_id", "amount", "msg", "memo"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new PolicyViolation(`ft_transfer_call args contain unexpected field "${key}"`);
  }
  if (args.receiver_id !== cfg.intentsContract) throw new PolicyViolation("ft_transfer_call receiver_id is not the intents contract");
  const amount = assertDecimalU128String(args.amount, "ft_transfer_call amount");
  if (amount <= 0n) throw new PolicyViolation("ft_transfer_call amount must be > 0");
  if ("memo" in args && args.memo !== null && args.memo !== undefined && typeof args.memo !== "string") {
    throw new PolicyViolation("ft_transfer_call memo, if present, must be a string or null");
  }
  let msg: unknown;
  try {
    msg = typeof args.msg === "string" ? JSON.parse(args.msg) : undefined;
  } catch {
    msg = undefined;
  }
  const m = msg as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).length !== 1 || m.receiver_id !== senderId) {
    throw new PolicyViolation(`ft_transfer_call msg must be {"receiver_id": "${senderId}"} (the signer)`);
  }
}

/** Validates escrow's `emergency_refund` args: `{ bet_id: u64 }` only.
 * The contract method takes exactly one argument and no deposit (not
 * `#[payable]`), so this rejects anything else smuggled alongside
 * bet_id as well as a missing/wrongly-typed bet_id -- same
 * fail-closed posture as assertFtTransferCallArgs above. */
function assertEmergencyRefundArgs(argsBytes: Uint8Array, method: string = "emergency_refund"): void {
  const args = parseArgsJson(argsBytes, method);
  const betId = args.bet_id;
  if (typeof betId !== "number" || !Number.isInteger(betId) || betId < 0) {
    throw new PolicyViolation(`${method} bet_id must be a non-negative integer, got ${JSON.stringify(betId)}`);
  }
  const allowed = new Set(["bet_id"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new PolicyViolation(`${method} args contain unexpected field "${key}"`);
    }
  }
}

/** Validates escrow's `referee_rule` args: exactly `{ bet_id: u64, outcome: "YES"|"NO"|"VOID" }` (exact case). */
function assertRefereeRuleArgs(argsBytes: Uint8Array): void {
  const method = "referee_rule";
  const args = parseArgsJson(argsBytes, method);
  for (const key of Object.keys(args)) {
    if (key !== "bet_id" && key !== "outcome") {
      throw new PolicyViolation(`${method} args contain unexpected field "${key}"`);
    }
  }
  const betId = args.bet_id;
  if (typeof betId !== "number" || !Number.isInteger(betId) || betId < 0) {
    throw new PolicyViolation(`${method} bet_id must be a non-negative integer, got ${JSON.stringify(betId)}`);
  }
  if (args.outcome !== "YES" && args.outcome !== "NO" && args.outcome !== "VOID") {
    throw new PolicyViolation(`${method} outcome must be exactly "YES", "NO" or "VOID", got ${JSON.stringify(args.outcome)}`);
  }
}

/** Max bytes of `new_referee_json` a relayed amend_referee may carry. */
const AMEND_REFEREE_JSON_MAX_BYTES = 4096;

/** Validates escrow's `amend_referee` args: exactly `{ bet_id: u64, new_referee_json: string }`
 * where bet_id is a JSON number (same convention as emergency_refund) and
 * new_referee_json is a string (<= 4096 bytes) holding valid JSON that is
 * null or an object. Fail-closed on anything else. */
function assertAmendRefereeArgs(argsBytes: Uint8Array): void {
  const method = "amend_referee";
  const args = parseArgsJson(argsBytes, method);
  for (const key of Object.keys(args)) {
    if (key !== "bet_id" && key !== "new_referee_json") {
      throw new PolicyViolation(`${method} args contain unexpected field "${key}"`);
    }
  }
  if (!("bet_id" in args) || !("new_referee_json" in args)) {
    throw new PolicyViolation(`${method} args must be exactly {bet_id, new_referee_json}`);
  }
  const betId = args.bet_id;
  if (typeof betId !== "number" || !Number.isInteger(betId) || betId < 0) {
    throw new PolicyViolation(`${method} bet_id must be a non-negative integer, got ${JSON.stringify(betId)}`);
  }
  const raw = args.new_referee_json;
  if (typeof raw !== "string") {
    throw new PolicyViolation(`${method} new_referee_json must be a string`);
  }
  if (new TextEncoder().encode(raw).length > AMEND_REFEREE_JSON_MAX_BYTES) {
    throw new PolicyViolation(`${method} new_referee_json exceeds ${AMEND_REFEREE_JSON_MAX_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PolicyViolation(`${method} new_referee_json is not valid JSON`);
  }
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new PolicyViolation(`${method} new_referee_json must be null or a JSON object`);
  }
}

/** LIVE2 / WITHDRAW1: real intents.near `ft_withdraw(token: AccountId, receiver_id, amount, memo?, msg?)` (near/intents
 * contracts/defuse/src/contract/tokens/nep141/withdraw.rs; #[payable] + assert_one_yocto). Allowed ONLY as the signer
 * withdrawing their own balance to THEMSELVES: receiver_id === sender, token = a stake asset's bare NEP-141 contract,
 * amount > 0, exactly 1 yocto, optional string memo; no msg (that would ft_transfer_call some contract) and no other field. */
function assertFtWithdrawArgs(cfg: RelayerPolicyConfig, argsBytes: Uint8Array, depositYocto: bigint, senderId: string | undefined): void {
  if (!senderId) throw new PolicyViolation("ft_withdraw requires the delegate sender id");
  if (depositYocto !== 1n) throw new PolicyViolation("ft_withdraw deposit must be exactly 1 yoctoNEAR");
  const args = parseArgsJson(argsBytes, "ft_withdraw");
  const allowed = new Set(["token", "receiver_id", "amount", "memo"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new PolicyViolation(`ft_withdraw args contain unexpected field "${key}"`);
  }
  if (args.receiver_id !== senderId) {
    throw new PolicyViolation(`ft_withdraw receiver_id must be the signer "${senderId}" (no withdrawing to third parties), got ${JSON.stringify(args.receiver_id)}`);
  }
  const token = args.token;
  if (typeof token !== "string" || !stakeTokenContracts(cfg).has(token)) {
    throw new PolicyViolation(`ft_withdraw token ${JSON.stringify(token)} is not a stake asset's NEP-141 contract (allowed: ${[...stakeTokenContracts(cfg)].join(", ")})`);
  }
  const amount = assertDecimalU128String(args.amount, "ft_withdraw amount");
  if (amount <= 0n) throw new PolicyViolation("ft_withdraw amount must be > 0");
  if ("memo" in args && args.memo !== null && args.memo !== undefined && typeof args.memo !== "string") {
    throw new PolicyViolation("ft_withdraw memo, if present, must be a string or null");
  }
}

/** Throws PolicyViolation if the (receiverId, methodName, args) triple the
 * delegate wants to execute is not on the allowlist. For intents/token
 * calls, also validates the embedded args against the correct real
 * shape for whichever contract is being called, so a delegate can't
 * smuggle a transfer to anywhere but the escrow contract, nor sneak a
 * field through under the wrong method's looser rules. */
export function assertAllowedCall(
  cfg: RelayerPolicyConfig,
  receiverId: string,
  methodName: string,
  argsBytes: Uint8Array,
  depositYocto: bigint = 0n,
  senderId?: string,
): void {
  if (receiverId === cfg.escrowContract) {
    if (!ESCROW_DIRECT_METHODS.has(methodName)) {
      throw new PolicyViolation(
        `method "${methodName}" on escrow "${receiverId}" is not on the allowlist (allowed: ${[...ESCROW_DIRECT_METHODS].join(", ")})`,
      );
    }
    if (depositYocto !== 0n && !ESCROW_PAYABLE_METHODS.has(methodName)) {
      throw new PolicyViolation(`method "${methodName}" is not payable; attached deposit must be 0`);
    }
    if (methodName === "emergency_refund" || methodName === "concede" || methodName === "finalize") {
      assertEmergencyRefundArgs(argsBytes, methodName);
    }
    if (methodName === "referee_rule") {
      assertRefereeRuleArgs(argsBytes);
    }
    if (methodName === "amend_referee") {
      assertAmendRefereeArgs(argsBytes);
    }
    return;
  }
  if (receiverId === cfg.intentsContract) {
    if (!INTENTS_METHODS.has(methodName)) {
      throw new PolicyViolation(
        `method "${methodName}" on intents "${receiverId}" is not on the allowlist (allowed: ${[...INTENTS_METHODS].join(", ")})`,
      );
    }
    if (methodName === "ft_withdraw") {
      assertFtWithdrawArgs(cfg, argsBytes, depositYocto, senderId);
      return;
    }
    if (methodName === "mt_transfer_call") {
      assertMtTransferCallArgs(cfg, argsBytes, depositYocto);
      return;
    }
    if (depositYocto !== 0n) throw new PolicyViolation("transfer_with_msg is not payable; attached deposit must be 0");
    if (cfg.intentsContract === REAL_INTENTS_CONTRACT) {
      throw new PolicyViolation(`transfer_with_msg is a mock-intents-only method; intents.near has no such method (use mt_transfer_call)`);
    }
    assertTransferWithMsgArgs(cfg, argsBytes);
    return;
  }
  if (cfg.wnearContract && receiverId === cfg.wnearContract && methodName === "near_deposit") {
    // RELAYDEP1 / D-RELAYDEP1: wrapping NEAR attaches the user's NEAR as a deposit, which a relayed delegate charges to the RELAYER.
    // (Supersedes RELAYFUND1's "the relayer sponsors near_deposit".) The web signs and pays this transaction itself; never relay it.
    throw new PolicyViolation("near_deposit is never relayed: its deposit would be paid by the relayer; the user must sign and pay it directly");
  }
  if ((cfg.fundTokenContracts ?? []).includes(receiverId) && methodName === "ft_transfer_call") {
    // RELAYFUND2: fail closed when the intents contract is not configured (undefined === undefined must never match).
    if (!cfg.intentsContract) throw new PolicyViolation("move-to-betting is disabled: intents contract is not configured");
  }
  if (
    (cfg.fundTokenContracts ?? []).includes(receiverId) &&
    methodName === "ft_transfer_call" &&
    parseArgsJson(argsBytes, "ft_transfer_call").receiver_id === cfg.intentsContract
  ) {
    assertMoveToBettingArgs(cfg, argsBytes, depositYocto, senderId);
    return;
  }
  if (methodName === "storage_deposit") {
    // SEC1 / MON-1: NEP-145 storage_deposit refunds its deposit (all of it when already registered) to the delegate SENDER, while
    // the relayer pays it: a relayed storage_deposit drained 0.01 NEAR per call. The web signs and pays it directly, like near_deposit.
    throw new PolicyViolation("storage_deposit is never relayed: its deposit would be paid by the relayer; the user must sign and pay it directly");
  }
  if (stakeTokenContracts(cfg).has(receiverId)) {
    // The real NEP-141 path: the outer DelegateAction.receiverId IS the
    // token contract itself (no separate "token_id" concept at this
    // layer -- that's precisely the difference from transfer_with_msg).
    if (!NEP141_METHODS.has(methodName)) {
      throw new PolicyViolation(
        `method "${methodName}" on token "${receiverId}" is not on the allowlist (allowed: ${[...NEP141_METHODS].join(", ")})`,
      );
    }
    // NEP-141 requires exactly 1 yocto (assert_one_yocto); anything larger can only fail on-chain.
    if (depositYocto > 1n) {
      throw new PolicyViolation("ft_transfer_call deposit must be exactly 1 yoctoNEAR");
    }
    assertFtTransferCallArgs(cfg, argsBytes);
    return;
  }
  throw new PolicyViolation(
    `receiver "${receiverId}" is not on the allowlist (allowed: ${cfg.escrowContract}, ${cfg.intentsContract}, or a stake token contract)`,
  );
}

// FE8 (S8): the contract's Open path refuses by returning false (full refund, I-3), logging
// `open_rejected bet=unassigned reason=<text>`; it never panics. This table maps every reason text in
// contracts/escrow/src/lib.rs (handle_open, envelope sanity_check, the msg-parse failure) to a plain clause.
// tests/openRefusal.unit.test.ts greps lib.rs and fails when a reason appears there that is not mapped here.
// `source` is a literal fragment of the reason as it appears in lib.rs; rows are matched in order (specific first).
// No numbers are written into the copy: limits live in the contract and are not repeated here.

export interface RefusalRow { id: string; source: string; message: string }

const OURS = "the app built this bet in a way the contract can't accept (a bug on our side, please report it)";

export const OPEN_REFUSALS: RefusalRow[] = [
  // taker_options rows first: their text contains the primary-taker phrasing.
  { id: "taker-options-asset", source: "taker_options asset not whitelisted", message: "one of the other ways the taker could pay uses a currency this app doesn't accept" },
  { id: "taker-options-limits", source: "taker_options amount outside asset_limits", message: "one of the other ways the taker could pay is outside the allowed stake range" },
  { id: "taker-options-odds", source: "taker_options stake ratio exceeds", message: "the odds are too lopsided for one of the other ways the taker could pay" },
  { id: "msg-parse", source: "msg parse failure", message: "the bet message couldn't be read by the contract (a bug on our side, please report it)" },
  { id: "sourcecheck-signature", source: "sourcecheck attestation signature invalid", message: "the source check wasn't accepted; check the sources again" },
  { id: "sourcecheck-future", source: "sourcecheck attestation checked_at is in the future", message: "the source check has a timestamp the contract can't accept; check the sources again" },
  { id: "sourcecheck-stale", source: "sourcecheck attestation stale", message: "the source check is too old; check the sources again" },
  { id: "deposit-token", source: "deposit token does not match maker_asset", message: "the money sent wasn't in the currency you're staking" },
  { id: "fee-pin", source: "fee_bps must equal the pinned protocol fee", message: "the fee in this bet doesn't match the contract's fee; reload the app and try again" },
  { id: "asset-disabled", source: "asset disabled for new bets", message: "one of the currencies in this bet is not open for new bets right now" },
  { id: "maker-asset", source: "maker_asset not whitelisted", message: "the currency you're staking isn't accepted by this app" },
  { id: "deposit-amount", source: "deposit does not equal stake_maker", message: "the amount sent didn't match your stake plus the network storage charge; reload the app and try again" },
  { id: "taker-asset", source: "taker_asset not whitelisted", message: "the currency the other person would stake isn't accepted by this app" },
  { id: "stake-maker-range", source: "stake_maker outside asset_limits", message: "your stake is outside the allowed range for that currency" },
  { id: "stake-taker-range", source: "stake_taker outside asset_limits", message: "the other person's stake is outside the allowed range for that currency" },
  { id: "odds", source: "stake ratio exceeds 10:1 max odds", message: "the odds are too lopsided" },
  { id: "referee-self", source: "referee cannot be maker or fee_account", message: "the referee can't be you or the app's fee account" },
  { id: "referee-taker", source: "referee cannot be the named taker", message: "the referee can't be the person you're challenging" },
  { id: "tip-needs-referee", source: "tip requires a referee", message: "you can only tip a referee when a person is deciding the bet" },
  { id: "tip-too-big", source: "fee + tip exceeds stake", message: "the fee plus the tip would be more than your stake" },
  { id: "sunset", source: "beta sunset reached", message: "new bets are no longer being accepted" },
  { id: "horizon", source: "resolve_deadline must be at most", message: "the final deadline is too far in the future" },
  // envelope sanity_check errors (logged as reason={reason})
  { id: "s-outcomes", source: "outcomes must be [YES, NO]", message: OURS },
  { id: "s-side", source: "maker_side must be YES or NO", message: "your side of the bet wasn't set to YES or NO" },
  { id: "s-stakes", source: "stakes must be > 0", message: "both stakes must be more than zero" },
  { id: "s-maker-asset", source: "maker_asset must be non-empty", message: OURS },
  { id: "s-taker-asset", source: "taker_asset must be non-empty", message: OURS },
  { id: "s-opts-count", source: "taker_options exceeds MAX_TAKER_OPTIONS", message: "too many other ways for the taker to pay were offered" },
  { id: "s-opts-asset", source: "taker_options asset must be non-empty", message: OURS },
  { id: "s-opts-amount", source: "taker_options amount must be > 0", message: "every way the taker can pay needs an amount above zero" },
  { id: "s-fee-range", source: "fee_bps out of range", message: OURS },
  { id: "s-runs", source: "max_paid_runs must be > 0", message: OURS },
  { id: "s-terms-hash", source: "terms_hash too long", message: OURS },
  { id: "s-models-hash", source: "models_snapshot_hash too long", message: OURS },
  { id: "s-terms-len", source: "terms length out of bounds", message: "the bet's terms are too long or too short for the contract" },
  { id: "s-terms-missing", source: "keep_terms is true but terms is missing", message: OURS },
  { id: "s-terms-extra", source: "terms must be None when keep_terms is false", message: OURS },
  { id: "s-settlement", source: "settlement_period must be between", message: "the challenge window is outside the allowed range" },
  { id: "s-deadlines", source: "resolve_deadline must be after funding_deadline", message: "the final deadline must come after the offer expires" },
  { id: "s-storage", source: "storage_charge_per_side must be", message: OURS },
];

/** `return false` in handle_open / early returns in mt_on_transfer that leave no log line. */
export const SILENT_OPEN_REFUSALS: { id: string; message: string }[] = [
  { id: "paused", message: "new bets are paused right now" },
  { id: "not-maker", message: "the money didn't come from the account making the bet" },
  { id: "offer-too-long", message: "the offer would stay open longer than the contract allows" },
];
/** Early `return PromiseOrValue::Value(amounts)` in mt_on_transfer before the message is read (wrong caller, shape, or unlisted currency). */
export const PRE_HANDLER_SILENT_REFUSALS = 4;

export const DECLINED_MESSAGE = "You cancelled. Nothing was sent.";
export const STILL_CONFIRMING_MESSAGE = "Still confirming. Your money is safe; check My bets.";
const FALLBACK = "the contract didn't accept this bet (it gave a reason we don't have a plain version of yet)";

export function plainOpenRefusal(reason: string | null): { known: boolean; message: string; id: string | null } {
  if (reason === null) return { known: false, message: "it didn't say why", id: null };
  const row = OPEN_REFUSALS.find((r) => reason.includes(r.source));
  return row ? { known: true, message: row.message, id: row.id } : { known: false, message: FALLBACK, id: null };
}

/** S8: "The contract refused this bet: [reason]. Your money was returned." */
export function refusalSentence(reason: string | null, refunded = true): string {
  const head = `The contract refused this bet: ${plainOpenRefusal(reason).message}.`;
  return refunded ? `${head} Your money was returned.` : `${head} Your money is on its way back; check My bets.`;
}

/** The reason text of the first `open_rejected` log line, or null. */
export function parseOpenRejected(logs: string[]): string | null {
  for (const l of logs) {
    const m = /open_rejected bet=\S+ reason=(.*)$/s.exec(l);
    if (m) return m[1];
  }
  return null;
}

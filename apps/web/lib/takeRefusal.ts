// FE9 (S11): the contract's Take path refuses by returning false (full refund, I-3). Four refusals log
// `take_rejected ... reason=<text>`; the rest are silent. tests/takeRefusal.unit.test.ts greps lib.rs (handle_take) and fails when
// a reason or a silent `return false` appears there that is not covered here. `source` is a literal fragment of the logged reason.
// No numbers are written into the copy.
export interface TakeRefusalRow { id: string; source: string; message: string }

export const TAKE_REFUSALS: TakeRefusalRow[] = [
  { id: "referee-ack", source: "referee_ack does not match the bet's referee", message: "the referee on this bet changed after you opened it" },
  { id: "tip-needs-referee", source: "tip requires a referee", message: "you can only tip a referee when a person is deciding the bet" },
  { id: "deposit", source: "deposit does not exactly match taker_asset or any taker_options entry", message: "the amount or currency sent didn't match what this bet asks for; reload the bet and try again" },
  { id: "tip-too-big", source: "fee + tip exceeds stake", message: "the fee plus the tip would be more than your stake" },
];

/** `return false` in handle_take that leaves no log line, in source order. */
export const SILENT_TAKE_REFUSALS: { id: string; message: string }[] = [
  { id: "paused", message: "new bets are paused right now" },
  { id: "no-bet", message: "this bet doesn't exist" },
  { id: "not-open", message: "the bet is no longer open (taken or cancelled)" },
  { id: "expired", message: "the offer has expired" },
  { id: "not-named-taker", message: "this bet is only for a different account" },
  { id: "bad-invite", message: "the invite link isn't valid for your account" },
  { id: "referee-is-you", message: "you are the referee on this bet, so you can't take it" },
  { id: "own-bet", message: "you can't take your own bet" },
];

const FALLBACK = "the contract didn't accept this take (it gave a reason we don't have a plain version of yet)";
const SILENT = "the bet was already taken, cancelled or expired, or it isn't open to your account";

export function plainTakeRefusal(reason: string | null): { known: boolean; message: string; id: string | null } {
  if (reason === null) return { known: false, message: SILENT, id: null };
  const row = TAKE_REFUSALS.find((r) => reason.includes(r.source));
  return row ? { known: true, message: row.message, id: row.id } : { known: false, message: FALLBACK, id: null };
}

/** First `take_rejected` reason in a transaction's logs (shapes: `take_rejected reason=..` and `take_rejected bet_id=N reason=..`). */
export function parseTakeRejected(logs: string[]): string | null {
  for (const l of logs) {
    const m = /take_rejected (?:bet_id=\S+ )?reason=(.*)$/.exec(l);
    if (m) return m[1].trim();
  }
  return null;
}

export function takeRefusalSentence(reason: string | null, refunded = true): string {
  const head = `The contract refused this take: ${plainTakeRefusal(reason).message}.`;
  return refunded ? `${head} Your money was returned.` : `${head} Your money is on its way back; check My bets.`;
}

export class BadSignedDelegate extends Error {}

/** SEC1 / MON-2: the signed outer tx was handed to the RPC but no outcome came back (timeout, 5xx, network). It may have
 * executed. Carries the outer tx hash (computed before sending) so the outcome can be looked up instead of guessed. */
export class OutcomeUnknown extends Error {
  constructor(readonly txHash: string, cause: unknown) {
    super(`outcome unknown for ${txHash}: ${String((cause as any)?.message ?? cause)}`);
    this.name = "OutcomeUnknown";
  }
}

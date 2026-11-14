# Known limits

Everything here is also summarised in the README's [Known limits](../README.md#known-limits). The SR-C ids come from a security
review of the escrow, judge and keeper (SECREV1, 2026-11-13). Source lines are at the commit that review read.

## Money and safety

- **Unaudited code.** Bets on mainnet use real money. Only bet what you can afford to lose. This was built in two weeks; the web app is
  an unlisted beta on https://praetorial.com.
- **No maximum stake per side** at launch (every asset's `max_per_side` = 10^34 raw). Minimums: $10 stake per side, $0.50 fee per side,
  $5 challenge bond (`release/mainnet-night/limits.md`). The protocol fee is 1% (100 bps).
- **Guardian powers, behind timelocks.** A guardian account can pause new offers (open bets carry on) and trigger a permanent emergency
  shutdown. Parameter changes (such as lowering the stake cap) take effect only 24 hours after they are proposed, new judge model pairs
  only after 7 days, and pairs are never removed or replaced. Guardian rotation is two-step (`docs/RUNBOOK-JC1x.md`).

## Stakes are never paid to the wrong side, but three known gaps can cost the winner their winnings

- **Paid runs can be used up early (SR-C1, High).** An AI bet allows 3 paid runs of the judge, and anyone can request one. A side that is
  losing before the result is final can use up all 3 paid runs early; the bet is then refunded at its deadline instead of paid. Both
  stakes come back. Planned fix in the next escrow version: refuse a run before its scheduled check time, or don't count an early run.
- **Bets without stored terms (SR-C2, High, limited).** A bet made outside the app without stored terms (`keep_terms: false`) can be
  forced to VOID by anyone, and a challenger on such a bet can lose their challenge bond. The app never makes these and won't take them
  (test: `apps/web/tests/globalStates.unit.test.ts`, "SECREV1 SR-5"). Planned fix: the next escrow version.
- **Custom-bet sources (SR-C4, Medium).** On a custom bet, if a source can't be read when the judge runs (site down, blocked, or a page
  one side controls), the bet ends as a refund (VOID) at once, with no retry. That VOID can be challenged. Planned fix: the keeper will
  check that the sources can be read before it asks for a ruling.

## Sports bets: today and tomorrow only (SR-C3, Medium)

If the keeper asks for a ruling on a game more than 44 hours away, the judge's "try again later" answer is dated too far ahead for the
escrow to accept, and the bet waits until its deadline refund. Until the keeper waits for a game to end, the app offers only games
starting within 44 hours.

## Lower-severity findings from the same review

- **SR-C5 (Low, liveness).** `sweep_excess_near` keeps back storage + 1 NEAR but not the keeper's prepaid credit, so anyone can sweep that
  credit to the fee account. No stake is touched. Mitigation: the keeper attaches the run deposit itself; the monitor alerts on a low balance.
- **SR-C6 (Low).** The refunded compute deposit of a failed judge run goes to the fee account (about 0.02 NEAR per run).
- **SR-C7 (Low).** The judge's private-host block is incomplete (IPv6 literals, DNS names that resolve to private IPs). Sources are
  https-only with real certificates, which limits this.
- **SR-C8 (Low).** A source that never finishes sending can hang a judge run; it is retried without using a paid run, and at worst the
  bet is refunded at its deadline.
- **SR-C9 (Info).** The NEAR AI answer-signature check adds nothing beyond TLS.

## The judge and the models

- **Trust in OutLayer and NEAR AI Cloud.** The escrow checks the judge's signature, not the TEE attestation. The key-to-program binding
  (check E4) is checked once at deploy, off chain (`docs/VERIFY.md`; in the app: `/docs/trust`).
- **Model nondeterminism.** AI models are not fully deterministic, so a re-run can differ. The safeguards: two different models must agree
  on custom bets, code decides data-feed bets and one model checks it, quotes must appear verbatim in the fetched page, code (not the
  model) decides, VOID when evidence is missing, and up to two challenge rounds.

## Networks and features

- **Mainnet-only and testnet-only parts.** 1Click funding, cash-out to another chain, and convert are mainnet only (testnet shows
  previews). The faucet is testnet only. On testnet only USDC and NEAR can be bet, and NEAR Intents is a mock contract (no Intents testnet
  exists). The testnet escrow still has an access key; the mainnet escrow has none.
- **Cross-asset bets.** The contract supports each side using a different token; the app creates same-token bets for now. A cross-asset
  take uses exact amounts the maker sets; there is no price oracle.
- **Earlier testnet bets ran an earlier judge build.** Of the 38 settled bets in `docs/BETS.md`, the 23 on `bets.praetorial.near` and the
  `frz3` testnet escrow ran under the judge program pinned on mainnet (`8791413f…`); 15 on two earlier testnet escrows ran under earlier
  judge builds. Every one of the 38 ran on the same escrow code as mainnet (checked at the block of each bet's transactions).

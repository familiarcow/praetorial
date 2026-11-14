// F2 (FUND4 SPEC §6, amended by familiarcow UX-37 / D-FUND4a): every funding string in one place, so F3 (Account screen), F4 (Add money
// sheet + tracker) and F5 (Cash out / Convert) share one source. Pure functions with typed inputs; amounts arrive ALREADY
// formatted (lib/funding/format.ts: displayAmount), so this file never rounds.
//
// Wording rules (FUND3 §4.3, kept):
//   - Always "send <token> on <network>". Token units, never "$" (the one exception: the grey "≈ $X" total).
//   - No "intents", "1Click", "POA", "omft", "solver", "bridge" or "quote" in user copy (a unit test enforces it). Say "betting
//     balance", "convert", "network", "address", "estimate". (ACCT2 removed the near.com path, the one former exception.)
// familiarcow's renames (UX-37): "Wallet" -> "Account", "Fund" -> "Add money", "Withdraw" -> "Cash out". The permanent bridge-address
// strings (SPEC fund.address.permanent / permanentMin) are dropped: every deposit uses a one-time address.
// Strings in [brackets] in the SPEC are buttons: they are separate keys here (`...Cta`).

export const COPY = {
  account: {
    title: "Account",
    totalLabel: "Betting balance",
    /** Grey, under the username. Omit the line when the total is null (any price missing). */
    totalApprox: (usd: string) => `≈ $${usd}`,
    accountDetails: "Account details",
    addMoney: "Add money",
    cashOut: "Cash out",
    convert: "Convert",
    rowNearAccount: (amount: string) => `In your NEAR account: ${amount}`,
    rowInBets: (amount: string, n: number) => `In bets: ${amount} (${n} ${n === 1 ? "bet" : "bets"})`,
    rowInBetsUnread: "Can't read your bets right now",
    strayTitle: "Not usable for bets yet",
    strayRow: (symbol: string, network: string) => `${symbol} (${network})`,
    strayUnknown: (shortId: string) => `Unknown token (${shortId}). Contact support.`,
    strayDust: "Too small to convert",
    convertTo: (symbol: string) => `Convert to ${symbol}`,
    payoutsTitle: "Being paid out",
    /** fundOnly: every in-flight record is an Add money deposit. */
    inFlight: (n: number, fundOnly: boolean) =>
      n === 1 ? (fundOnly ? "1 deposit in progress" : "1 transfer in progress") : `${n} ${fundOnly ? "deposits" : "transfers"} in progress`,
    readError: "We can't read your balance right now.",
    loading: "Loading your balances…",
    retry: "Retry",
    emptyTitle: "Add money to start betting",
    emptyBody:
      "Send crypto from any wallet or exchange — USDT on Tron, USDC on Base or Solana, BTC, ETH, SOL and 200+ more. We turn it into a token you can bet with.",
  },

  add: {
    title: "Add money",
    step1Title: "What do you have?",
    search: "Search token or network",
    popular: "Popular",
    recent: "Recent",
    all: (n: number) => `All tokens (${n})`,
    noResults: "No match. Try the token symbol, like USDT, or the network, like Tron.",
    loadError: "We can't load the token list right now.",
    betWith: (symbol: string) => `You'll bet with: ${symbol}`,
    betWithLocked: (symbol: string) => `This bet is in ${symbol}`,
    amountTitle: "How much will you send?",
    youGet: (out: string) => `You'll get ≈ ${out} in your betting balance`,
    eta: (eta: string) => `in about ${eta}`,
    fee: (fee: string) => `fee ≈ ${fee}`,
    min: (min: string) => `Minimum to send: ${min}`,
    tooLow: (min: string) => `That's below the minimum of ${min}.`,
    belowBet: (minStake: string) => `Smallest bet is ${minStake}. You can add more later.`,
    covers: (need: string) => `Covers the ${need} you need for this bet`,
    noRoute: (symbol: string, network: string) => `${symbol} on ${network} can't be converted right now. Pick another token or try later.`,
    quoteError: "We can't get a price right now.",
    tryAgain: "Try again",
    getAddressCta: "Get deposit address",
    addressTitle: (symbol: string, network: string) => `Send ${symbol} on ${network}`,
    networkBadge: (network: string) => `${network} network`,
    /** FLEX_INPUT band: minIn and amountIn are formatted with the symbol. */
    band: (minIn: string, amountIn: string) => `Send between ${minIn} and ${amountIn}. More is fine; it's converted too.`,
    deadline: (time: string, left: string) => `Send before ${time} — ${left} left`,
    soon: "Less than 10 minutes left. If your send might be slow, get a new address.",
    expired: "This address has expired. Don't send to it.",
    onlyThis: (symbol: string, network: string) => `Only ${symbol} on ${network}. Other tokens or networks are lost.`,
    exchange: (exchangeNetworkName: string) => `Sending from an exchange? Pick the "${exchangeNetworkName}" network there.`,
    memo: "You must include this memo, or the deposit is lost.",
    sentCta: "I've sent it",
    txHash: "Optional: paste the transaction ID (speeds it up)",
    copy: "Copy",
    copied: "Copied",
    newAddressCta: "Get a new address",
  },

  track: {
    stepSent: "Sent",
    stepConfirming: "Confirming",
    stepConverting: "Converting",
    stepCredited: "In your balance",
    waiting: (symbol: string, network: string, left: string) => `Waiting for your ${symbol} on ${network}. Address valid for ${left}.`,
    confirming: (network: string, eta: string) => `We see your deposit. Waiting for the ${network} network to confirm it (usually about ${eta}).`,
    confirmingSlow: (network: string, range: string) => `${network} confirmations take ${range}. You can close this page.`,
    /** amountIn is formatted with the symbol; betWith is the bet token symbol. */
    converting: (amountIn: string, network: string, betWith: string) => `Converting ${amountIn} (${network}) to ${betWith} for betting…`,
    moving: "Moving it into your betting balance…",
    short: (got: string, minIn: string, more: string, time: string) =>
      `We got ${got}, but this address needs at least ${minIn}. Send ${more} more before ${time} to the same address, or we'll return the ${got} to your account.`,
    credited: (out: string) => `${out} added to your betting balance.`,
    creditedPending: "Added. Your balance updates in a moment.",
    refundedStray: (amount: string, network: string) =>
      `We couldn't convert it, so we returned ${amount} (${network}) to your account. It's under "Not usable for bets yet".`,
    refundedBetting: (amount: string) => `We couldn't convert it, so we returned ${amount} to your betting balance.`,
    reasonPartial: "You sent less than the minimum.",
    reasonPrice: "The price moved too much while converting.",
    reasonUnknown: "The conversion didn't go through.",
    failed: "Something went wrong on the conversion side. Your money is traceable.",
    expired: "This address expired and nothing arrived. If you did send, get help.",
    checking: "We can't check right now. Your deposit is still being processed. Retrying…",
    helpCta: "Get help",
    /** What "Get help" copies to the clipboard. */
    helpText: (p: { depositAddress: string; memo: string | null; correlationId: string | null; time: string }) =>
      [`Deposit address: ${p.depositAddress}`, p.memo ? `Memo: ${p.memo}` : null, `Reference: ${p.correlationId ?? "none"}`, `Time: ${p.time}`]
        .filter(Boolean)
        .join("\n"),
    betCta: "Place a bet",
    backCta: "Back to your bet",
  },

  cashOut: {
    title: "Cash out",
    step1Title: "What do you want to cash out?",
    max: "Max",
    locked: (amount: string) => `${amount} is in open bets and can't be cashed out.`,
    sendAsTitle: "Send as",
    popularFor: (symbol: string) => `Popular for ${symbol}`,
    addressTitle: (symbol: string, network: string) => `Your ${symbol} (${network}) address`,
    paste: "Paste",
    scan: "Scan QR",
    invalid: (network: string) => `That isn't a valid ${network} address.`,
    ownDeposit: "That's one of your deposit addresses. Use your own wallet's address.",
    contract: "That's a contract address, not a wallet.",
    memoAsk: "Is this an exchange address that needs a tag or memo?",
    memoYes: "Yes",
    memoNo: "No, it's my own wallet",
    memoBlock: "We can't add a tag or memo yet. Send to a wallet you control, then move it to the exchange.",
    exchangeNote: "Exchanges sometimes don't credit deposits from smart contracts. If unsure, send a small amount first.",
    reviewSend: "You send",
    reviewReceive: "They receive ≈",
    reviewAtLeast: "At least",
    reviewTo: "To",
    reviewFee: "Network fee",
    tooSmall: (network: string, min: string) => `Too small to send to ${network}. Minimum is ${min}.`,
    cta: "Cash out",
    sign: "Confirm in your wallet",
    signRefused: "You cancelled. Nothing was sent.",
    payloadMismatch: "We stopped this cash out because the details didn't match. Nothing was sent.",
    unsigned: "You didn't confirm this cash out.",
    confirmCta: "Confirm",
    cancelCta: "Cancel",
    sending: (out: string, shortAddr: string) => `Sending ${out} to ${shortAddr}…`,
    sent: (out: string, shortAddr: string) => `Sent: ${out} is on its way to ${shortAddr}.`,
    refunded: (amount: string) => `We couldn't send it. ${amount} is back in your betting balance.`,
    nearTitle: "Cash out to my NEAR account",
    nearNoGas: (min: string, symbol: string) => `Your NEAR account needs ${min} to receive ${symbol}. Use "Send as ${symbol} · NEAR" instead.`,
  },

  convert: {
    title: (amount: string, network: string) => `Convert ${amount} (${network})`,
    youGet: (out: string, eta: string) => `You'll get ≈ ${out} · about ${eta}`,
    done: (out: string) => `${out} added to your betting balance.`,
  },

  common: {
    workerDown: "Adding money and cashing out are unavailable right now. Your balances are safe.",
    rateLimited: "Too many tries. Wait a minute and try again.",
    testnetFund: "This is a test network, so test NEAR is free.",
    testnetFundCta: "Get test NEAR",
  },
} as const;

/** Words that must never appear in user copy. */
export const BANNED_WORDS = ["intents", "1click", "poa", "omft", "solver", "bridge", "quote", "wallet page", "withdraw"] as const;

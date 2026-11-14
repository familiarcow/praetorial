// DOCS2 EXTENSION: case studies on the Hackathon page. Data only. Every stake, amount, hash and outcome here was checked against the
// repo's run evidence (services/e2e/**, spikes/cs1) AND read-only RPC tx status (spikes/docs2/CASES-VERIFIED.md, test-checked: every
// hash below must be in it). Testnet cases are rehearsals, always labelled so. DOCS3 adds the mainnet cases (the smoke run and the
// hackathon self-bet) with network "mainnet"; orderedCases shows those first. A case with no tx is never shown.
import type { NetworkId } from "./networkSelect";

export interface CaseTx { label: string; hash: string }
export interface CaseStudy {
  id: string;
  network: NetworkId;
  title: string;
  /** UTC date of the run, YYYY-MM-DD. */
  date: string;
  betIds: number[];
  /** Human stake, e.g. "1 USDC per side" (test money on testnet); null when not shown. */
  stake: string | null;
  outcome: string;
  happened: string;
  proves: string;
  txs: CaseTx[];
}

export const caseLabel = (c: Pick<CaseStudy, "network">): string => (c.network === "testnet" ? "Testnet rehearsal" : "Mainnet");

/** Cases that may be shown (at least one tx), mainnet first, otherwise in the data's order. */
export function orderedCases(list: readonly CaseStudy[] = CASE_STUDIES): CaseStudy[] {
  const shown = list.filter((c) => c.txs.length > 0);
  return [...shown.filter((c) => c.network === "mainnet"), ...shown.filter((c) => c.network !== "mainnet")];
}

/** Generated once from spikes/docs2/cases.verified.json (the verified set); edit here from now on. */
export const CASE_STUDIES: CaseStudy[] = [
  {
    id: "btc-both-venues-yes",
    network: "testnet",
    title: "BTC high on both Coinbase and Bitstamp in the same 5 minutes: YES",
    date: "2026-11-08",
    betIds: [
      1
    ],
    stake: "1 USDC per side (test USDC)",
    outcome: "YES",
    happened: "The maker bet that Bitcoin's 1-minute high would reach $75,948 on both Coinbase and Bitstamp inside the same 5-minute window before 06:00 UTC on 7 Nov 2026 (a window already in the past). The resolver fetched both exchanges' candles, two AI models each quoted a qualifying candle from both venues, and the signed result was YES. After the one-hour settlement window the bet was finalized and the maker received 1.98 USDC (the 2 USDC pot minus the 1% fee).",
    proves: "A multi-condition price sheet (two venues, same window) is resolved from real exchange data with quoted evidence, signed, and paid out exactly.",
    txs: [
      {
        label: "open",
        hash: "ESEpUZRCj7djC7xUmFBUfCyDyKQWDfdBRFdMsRWYAS9N"
      },
      {
        label: "take",
        hash: "GEK1mW2WkbMnpXBkPGjWVVcEZE3aa7FugJcvkEi3iZj4"
      },
      {
        label: "request_resolution",
        hash: "9wr6cjWRDtr28c8wM7EF8gDgepbXZdFd7hWmmPzEqM3A"
      },
      {
        label: "submit_outcome",
        hash: "7hXdtNGAG2TP5vNZ3TDGqi82kyNntSRYWTUaYvW8qvxD"
      },
      {
        label: "finalize",
        hash: "Bq15gqfX8Ku83Nhbu169ugvHAabYb9RSCGC1TF98q2Pk"
      }
    ]
  },
  {
    id: "btc-one-venue-no",
    network: "testnet",
    title: "Same BTC sheet, level reached on only one exchange: NO",
    date: "2026-11-08",
    betIds: [
      2
    ],
    stake: "1 USDC per side (test USDC)",
    outcome: "NO",
    happened: "The same sheet with the level set to $75,951, a price Bitstamp reached but Coinbase did not (Coinbase peaked at $75,950). Both AI models ruled the condition not met, the signed result was NO, and the taker received 1.98 USDC at finalize.",
    proves: "The judge does not round a near miss into a win: one venue alone does not satisfy a both-venues condition.",
    txs: [
      {
        label: "open",
        hash: "3shnWVupqqLvPBAnjddmLxE79NiftTou4TPbRRRMZZHJ"
      },
      {
        label: "take",
        hash: "2ynq9mB5TbNmmQbKnAX3oWztcy2a2dZYvGYMo8ALrjLa"
      },
      {
        label: "request_resolution",
        hash: "8MTFoQPk4h8Rsy7w1paRUvVmaZRSeys8s5VmPnQfBi31"
      },
      {
        label: "submit_outcome",
        hash: "HbHwJ2Qa3dx777JQC5TwTsg9q6nCNTBuS5sofEvETozk"
      },
      {
        label: "finalize",
        hash: "FMT1dzDc4See83Ag3EdoUKnQNuCDf9doNogKFp1bAM9y"
      }
    ]
  },
  {
    id: "btc-one-venue-no-code-decided",
    network: "testnet",
    title: "One-venue BTC sheet decided by code, AI only audits: NO",
    date: "2026-11-08",
    betIds: [
      1
    ],
    stake: "1 USDC per side (test USDC)",
    outcome: "NO",
    happened: "The one-venue sheet was run again on a fresh escrow with a newer resolver. With complete 1-minute candles from Coinbase and Bitstamp (120 of 120 each), the code itself decided NO and a single AI call only audited that decision (it agreed). The resolver run took about 6.6 seconds, and the taker received 1.98 USDC at finalize.",
    proves: "When the price data is complete, the outcome is computed by code, not chosen by a model; the AI can only agree or flag.",
    txs: [
      {
        label: "open",
        hash: "DfLEvcMWLLWckaCX3ocPSrqriSkD7KC64x3Wzzgd2L2Q"
      },
      {
        label: "take",
        hash: "2uFLw11E1Cp24Lmm4u7zTz9w1fi2vtA3zhaRiK78tdTq"
      },
      {
        label: "request_resolution",
        hash: "GmjvD4Sa1jcrhPwhVX6kWqwmj7ZJnrg33fqLJyYT8Wgn"
      },
      {
        label: "submit_outcome",
        hash: "9o8gktL2Beu5N3CbHAcQPqRmfoubo3uz8USeK1bdHLNE"
      },
      {
        label: "finalize",
        hash: "8DgRHSiAAyx5nWzkFmHjQpnwsBaXsGBb7gTGCxkExif2"
      }
    ]
  },
  {
    id: "btc-touch-75200-no",
    network: "testnet",
    title: "BTC touches $75,200 within six hours: NO, paid in wNEAR",
    date: "2026-11-10",
    betIds: [
      18
    ],
    stake: "3 wNEAR per side (testnet wNEAR)",
    outcome: "NO",
    happened: "A bet built in the web app: Bitcoin trades at or above $75,200 between 04:48 and 10:48 UTC on 10 Nov 2026, opened and taken through gasless relayed transactions. The keeper requested the result at 10:49 UTC; the resolver found complete 1-minute candles on Coinbase, Bitstamp and Kraken with none reaching $75,200, so the code decided NO and a single AI audit agreed; the result was signed NO. The signed result was submitted, and after the settlement window the keeper finalized: the taker received about 5.7283 wNEAR (both stakes minus fees).",
    proves: "An AI-template bet in a non-USD asset settles end to end from real price data, with the payout split exactly between winner and fee account.",
    txs: [
      {
        label: "open (relayed)",
        hash: "GtURKaDMyR7q6DkhDG6LD3cQi3hCtT8cggvmVe9YsMvG"
      },
      {
        label: "take (relayed, invite link)",
        hash: "9a4F9pfPopervAJQehwvqXe3EiT1vnwXq2UL4sdtDPCs"
      },
      {
        label: "request_resolution",
        hash: "8Xh3N5dsZsNdKcP9bKuWhVWnuGe7a7zxcNgiDHtU9MDU"
      },
      {
        label: "submit_outcome",
        hash: "ABdWDYZLvTxGWLfjB5fyAifxG5MGN7FBx8yUGoeyT7Vr"
      },
      {
        label: "finalize",
        hash: "EkMbnyrDyr6s6Nh3iz6JFYdZ7vyLTHeSCmPvx8Wn8Fxv"
      }
    ]
  },
  {
    id: "fail-safe-void-series",
    network: "testnet",
    title: "Five failures, five signed VOIDs, exact refunds",
    date: "2026-11-06",
    betIds: [
      1
    ],
    stake: "10 USDC per side (test USDC)",
    outcome: "VOID (attempts 2-6); attempt 1 unwound by a 50/50 mutual settle",
    happened: "On 6 Nov 2026 the same BTC sheet (a past October 2025 window, hourly candles) was run six times on one escrow name that was redeployed between attempts. In attempt 1 the compute network rejected the escrow's request format, the bet stayed waiting with no outcome, and the two sides later unwound it by a 50/50 mutual settlement. In attempts 2 to 6 something different broke each time (an exchange page failed to load, a genuine gap in Coinbase's own data, a missing model setting, a model returning an empty answer, a dropped connection to the AI service); each time the resolver signed VOID instead of guessing, and finalize refunded exactly 10 USDC to each side.",
    proves: "Failures fail closed: when evidence or the AI is unavailable the result is a signed VOID with exact refunds, never a guessed winner.",
    txs: [
      {
        label: "attempt 1: open refused (settlement period under 1 hour, deposit returned)",
        hash: "3G3H4zqpTN6o8zUSEmCBZj5H9hcCNRwMUvNZDqMKyeAY"
      },
      {
        label: "attempt 1: open",
        hash: "8miLQLZVJA49tKKfEHVq38cw7nPPuixsk1agG69hBgpn"
      },
      {
        label: "attempt 1: take",
        hash: "BzKNgPYHRJbYAUkrRoNuTmfQVQiVLtzkv9VNbVVyxvYz"
      },
      {
        label: "attempt 1: request_resolution (compute call rejected, bet left waiting)",
        hash: "6U8HN1hWiESqhfVgZFna3MMCHcVMYB438EoLu9jCnKEJ"
      },
      {
        label: "attempt 1: mutual_settle (maker)",
        hash: "CZv3hfUxCqjp7TfUmMXZzmoxJDXHBDQExfsABgc7L7Yw"
      },
      {
        label: "attempt 1: mutual_settle (taker, pays out 50/50)",
        hash: "3SZ4x8Nrt1VBUA2fcs619AqvkUfsbGpkj7rgtMM1sHUH"
      },
      {
        label: "attempt 2: open",
        hash: "CBL4HKLYWJmf6rF4NNZMrdd1m1TLFq8tj9x11RvUbqGY"
      },
      {
        label: "attempt 2: take",
        hash: "D8qENQU7LoeuVsqiMwJqzFaLHTbskHS4zC7QCmZyULTU"
      },
      {
        label: "attempt 2: request_resolution",
        hash: "H2QUZSvFme65vYekU3UMKP7cs1NiVRLfYqiRfzaREnMK"
      },
      {
        label: "attempt 2: submit_outcome (signed VOID)",
        hash: "HTa3fvXyr6SWdxnBgURvyRmtDpsKs2cZFJUBV3w38sH3"
      },
      {
        label: "attempt 2: finalize (refunds)",
        hash: "4hKJkMaMd5j5GuQEg6XyJzQqBbxiXY24nsKiMUorkj5r"
      },
      {
        label: "attempt 3: open",
        hash: "G9jgEPuFDDPsfXMx2jXNWSPVPZjPYPJWU1TL5X7q3XrN"
      },
      {
        label: "attempt 3: take",
        hash: "61TpCq4Dve8RukcyhiNvyLVHs8HMkRRqNw3uacK8x66g"
      },
      {
        label: "attempt 3: request_resolution",
        hash: "GH8AXxPm9KYGL8v2tTiNb19QTMvxbtF2iMRpFB6G3ewm"
      },
      {
        label: "attempt 3: submit_outcome (signed VOID)",
        hash: "2ULysccBa6jKiGQpCiHbMF91VXniZJFaFEoTLzFbdxy3"
      },
      {
        label: "attempt 3: finalize (refunds)",
        hash: "92dvUhfpvKJGUDAXnCcWaeZH6CSBaew8H9MdgZimwGjQ"
      },
      {
        label: "attempt 4: open",
        hash: "FhMCDJoNVXQ13RKmqb5HgysZqNdAysvjBKVdzP9s5D2x"
      },
      {
        label: "attempt 4: take",
        hash: "F4DV8MDFC9pTSrCJ5Tu2QvMmZhX461GZXeWcGkfHWFwj"
      },
      {
        label: "attempt 4: request_resolution",
        hash: "GWscpAfnAkaNADVMcZGJwRoq1sX9QHxifDroAYn53mEA"
      },
      {
        label: "attempt 4: submit_outcome (signed VOID)",
        hash: "BdnGmyFFUeCdJBuhgz9Aj1CVC89hd7EzkjB23qiBmyB4"
      },
      {
        label: "attempt 4: finalize (refunds)",
        hash: "qqS5QxAjKDQGqwdZm67aFBt4qbfUmQdmdEfCjyeMTSD"
      },
      {
        label: "attempt 5: open",
        hash: "8vX83mPfeV7FSBDAtmuHxJYgv4ddwVfaNJhgdLtCLHMb"
      },
      {
        label: "attempt 5: take",
        hash: "8G9QE8MCnc4TcvxonYepVpF4SvPLwtHEaxaiQdREitaW"
      },
      {
        label: "attempt 5: request_resolution sent too early (rejected, nothing spent)",
        hash: "kcPzKk2z8XCtyysRsuy9kXsnBZqFapxVed7qwUrNYrj"
      },
      {
        label: "attempt 5: request_resolution",
        hash: "HeHAeDr5s1adGoT1eKWxqGD22U3voKsQcAonDSb9C885"
      },
      {
        label: "attempt 5: submit_outcome (signed VOID)",
        hash: "DJfmoh1sG8ySVrvrvEXGNvxCaFbtwxin8kqwj3k8DfV2"
      },
      {
        label: "attempt 5: finalize (refunds)",
        hash: "GXbJnf33hr7ZMqAeCp8YDr8mXXTFqytroNREL9gR8YVF"
      },
      {
        label: "attempt 6: open",
        hash: "na4wNvSRkXcXiZBVSm9SnNmrqLkbsmPpk8tAk1478ZR"
      },
      {
        label: "attempt 6: take",
        hash: "Hw2abMMQhbiWAc3DMvbJJJ9FnZFg6hTLbSgcjALqqf4H"
      },
      {
        label: "attempt 6: request_resolution",
        hash: "HzL3FcPDUzMEmPUF7vum6yxntGrwaniLpSvcQdmm7FwS"
      },
      {
        label: "attempt 6: submit_outcome (signed VOID)",
        hash: "62iunA47NrfL8obVwRxfpZu4Km2DUNecBny48T5FygRP"
      },
      {
        label: "attempt 6: finalize (refunds)",
        hash: "6vrWzt9TjNvZj4B2x1op5yTavt1wm7vGr62C64fDxMhZ"
      }
    ]
  },
  {
    id: "knyc-weather-void",
    network: "testnet",
    title: "Central Park daily high at least 70F: two fail-safe VOIDs",
    date: "2026-11-07",
    betIds: [
      1,
      2
    ],
    stake: "1 USDC per side (test USDC)",
    outcome: "VOID (both bets)",
    happened: "Two bets on whether the official Central Park (KNYC) high on 5 Nov 2026 was 70F or more, read from the National Weather Service climate report (the report said 72F). In bet 1 the AI key had been stored under the wrong account, so no model was called and the resolver signed VOID. In bet 2 one of the two models returned HTTP 400 errors (most likely a wrong model id; not confirmed) while the other quoted 'MAXIMUM 72'; with one model unusable the resolver signed VOID rather than NO. Both bets were finalized with 1 USDC refunded to each side.",
    proves: "Configuration mistakes fail safe: a missing or broken AI judge produces VOID and refunds, not a wrong answer.",
    txs: [
      {
        label: "bet 1: open",
        hash: "7rRBaqCXGUeWVxw5mLNk7Q4oNBq2Vv7Yf9gQFFfQTH1k"
      },
      {
        label: "bet 1: take",
        hash: "96svmDTQPd2CFFRZ8w56ejh8ji7YLrSBiGe5kyjG2DE9"
      },
      {
        label: "bet 1: request_resolution",
        hash: "EmsrceCtbyjxBd2iE4BgGX5MD9VHFgQta1zbAWny3Gpd"
      },
      {
        label: "bet 1: submit_outcome (signed VOID)",
        hash: "7Xj7Gpn1Gd7FiV8YdZHE2nNrvfo13SxQMmNwrMNy9ppL"
      },
      {
        label: "bet 2: open",
        hash: "9jxQe421uLrq8SoRfjF35XiYy81HFBJWCHPMddT4VMuN"
      },
      {
        label: "bet 2: take",
        hash: "HCrpYsAo8cqNm9hbB3s5tQmhejNKEmeYR4GTXhMpfFjZ"
      },
      {
        label: "bet 2: request_resolution",
        hash: "RxsgsWYCacvQoEBFKHJLehRTS4HAg8hpb59w3pKtXir"
      },
      {
        label: "bet 2: submit_outcome (signed VOID)",
        hash: "3Fk45PYFXqjLNk1PkxZxwtz7ZMmBQ1d2ww3WzLg1sRRd"
      },
      {
        label: "bet 1: finalize (refunds)",
        hash: "AsBnfX8UUBVLEbTLHeh4ERbQCNSiaFKQ8Dx4EqEbjVwU"
      },
      {
        label: "bet 2: finalize (refunds)",
        hash: "8MKNnVYuh7jq13xpr12CfNpuDoenMu4b7neFJfGiUCzP"
      }
    ]
  },
  {
    id: "knyc-weather-yes",
    network: "testnet",
    title: "Central Park daily high at least 70F: YES",
    date: "2026-11-07",
    betIds: [
      1
    ],
    stake: "1 USDC per side (test USDC)",
    outcome: "YES",
    happened: "The same weather question on a fresh escrow with both fixes in place. Both AI models answered 'met', quoting the climate report line 'YESTERDAY MAXIMUM 72', and the resolver signed YES. A first request sent before the funding deadline was rejected at no cost. After the settlement window the maker received 1.98 USDC.",
    proves: "A weather bet resolves YES from the official NWS text, with both models quoting the same line.",
    txs: [
      {
        label: "open",
        hash: "1YzMF88PbhF6d9bL8z77qsLCcwjYrTqUZ2SSfNtGuM6"
      },
      {
        label: "take",
        hash: "GZx661W5vrxAAC72bwDQ56d2W16RkVHNzaLFBhwKXkfj"
      },
      {
        label: "request_resolution sent too early (rejected)",
        hash: "23khKvNVWRQ7Q2zFakEXfAPftqbrSrooWZkg2f6pHrNq"
      },
      {
        label: "request_resolution",
        hash: "Cc9de2MwGHthBaMoBpSRN1yNoty5WfQJhRvRa6Ao5Quq"
      },
      {
        label: "submit_outcome",
        hash: "6MDRMMho5N18xGHFAH1nVrzzjUXe7SWEHL343mbPv3r4"
      },
      {
        label: "finalize",
        hash: "3GqTf4funbFVN45jWcp9sAAKMVhhBBCvRA54yEnqXU37"
      }
    ]
  },
  {
    id: "early-request-void",
    network: "testnet",
    title: "Result requested too early: signed VOID, both refunded",
    date: "2026-11-07",
    betIds: [
      1
    ],
    stake: "1 USDC per side (test USDC)",
    outcome: "VOID",
    happened: "The maker bet that Bitcoin's 1-minute close at 18:38 UTC on 7 Nov 2026 would be above $70,000. The result was requested at 18:39 UTC, before the earliest allowed time (the target minute plus 5 minutes). The resolver refused to read prices that early and signed VOID; after the settlement window both sides were refunded 1 USDC.",
    proves: "A premature request cannot produce a winner: the resolver enforces its own timing rule and fails to VOID. (This early-request handling has since been changed.)",
    txs: [
      {
        label: "open",
        hash: "A5sXF2f8bdosiUmLFwQhyg8cZi6XrcfhHTfaRBjuRhyB"
      },
      {
        label: "take",
        hash: "EnHybVBfHmKqzzTAdXZGunZxjZSJbY1yXNgaSGcNDozb"
      },
      {
        label: "request_resolution",
        hash: "9jAeCBxWQey6qH7v7DepCK6QnprDxKv4p2JXDG2jdU4D"
      },
      {
        label: "submit_outcome (signed VOID)",
        hash: "6HZKRKjmRFum1nnnKPnDDqR1tJZybXfvgUKqas15Tr5X"
      },
      {
        label: "finalize (refunds)",
        hash: "CRtqenLXb5xxANvj2KHPBtAgwLqgCCg2htt6Ar8FTzBV"
      }
    ]
  },
  {
    id: "challenged-btc-close-rejudged",
    network: "testnet",
    title: "Challenged BTC bet: AI re-judge confirms YES",
    date: "2026-11-12",
    betIds: [
      49
    ],
    stake: "20 USDC per side (test USDC)",
    outcome: "YES",
    happened: "The maker bet that Bitcoin's close at 20:30 UTC on 11 Nov 2026 would be at or above $74,400. The first ruling was YES (median close of Coinbase, Bitstamp and Kraken: $74,453.48). The taker challenged with a 5.005 USDC bond and paid for a second AI run; while that challenge was open the escrow refused every finalize attempt. The re-judge also ruled YES, and at finalize the maker received 44.00 USDC.",
    proves: "A challenge freezes settlement until a fresh judge run rules, and a losing challenge costs the challenger the bond.",
    txs: [
      {
        label: "open",
        hash: "3FtMzC9DoXPPGR8rbPLwLDMZAXy19Fgg5FYqL6G3qbDk"
      },
      {
        label: "take",
        hash: "7efBWmGaEkYfh5MNgmpETubm7th2cZbmckAV4X6L6N3P"
      },
      {
        label: "request_resolution (compute run failed, nothing decided)",
        hash: "G46nXFbipCyvY1dkkKNsUn4s8pJX8ZWjg5Wo5RiRUA39"
      },
      {
        label: "request_resolution",
        hash: "HzwRD7YhJJdckHe99kdTAtmhCjea56ZtwNNLwtG2pHcz"
      },
      {
        label: "submit_outcome (first ruling YES)",
        hash: "BEZLGN6Xi76fCiYyKNQrv3izZpFJYeV3v7e8NmW1jo3J"
      },
      {
        label: "challenge bond (5.005 USDC)",
        hash: "4N3EanAwrJ4yStku1fwovW1UeVC5aTfyHnuHyGVHjwKW"
      },
      {
        label: "request_resolution for the challenge round (paid by challenger)",
        hash: "9SbiLsizpBHSGnnragbY5Z8porbzpnZtWggaYfKPLG6j"
      },
      {
        label: "finalize refused (challenge round pending a ruling)",
        hash: "7bCmfPymqTzkuuzs4ddTb6YRui2SEiasusNSXejctRw"
      },
      {
        label: "finalize refused (challenge round pending a ruling)",
        hash: "fJ7LNwZAHHydz61wee2B66GSQdCTgPv3hPEWPm8PdBS"
      },
      {
        label: "finalize refused (challenge round pending a ruling)",
        hash: "FEWawn7qeGn3583zoHtxpW9z7Q7MkvP7XWRnLWNaFqP2"
      },
      {
        label: "finalize refused (challenge round pending a ruling)",
        hash: "9f3P45RCVK6Df6wnhe4992ZNSQHBM4pkCv37hhT51fdq"
      },
      {
        label: "finalize refused (challenge round pending a ruling)",
        hash: "96Lyg7qAJqG2HQZU3BDqX5gyhWdV8eb7yUGd2No86TpZ"
      },
      {
        label: "finalize refused (challenge round pending a ruling)",
        hash: "83MzTgWDHDfeKYbuUghZ26UEXDmg6fCFwrTd1ZU6fhC2"
      },
      {
        label: "finalize refused (challenge round pending a ruling)",
        hash: "AoroPXs2aNggLg17ASab8jmUu3xyPNKfS9JVZk1k2i7s"
      },
      {
        label: "submit_outcome (re-judge ruling YES)",
        hash: "AXvXrG32NxybxRhrxCWBBVCipWG99PhvDsN8t5WqvJ7m"
      },
      {
        label: "finalize",
        hash: "3hJouvbQA5vQQGxX1FazaNUgRmxS3CbyGpv63CXJynaK"
      }
    ]
  },
  {
    id: "nhl-rangers-flames-yes",
    network: "testnet",
    title: "NHL: Rangers beat the Flames, paid in wNEAR",
    date: "2026-11-12",
    betIds: [
      51
    ],
    stake: "3 wNEAR per side (testnet wNEAR)",
    outcome: "YES",
    happened: "The maker bet that the New York Rangers would beat the Calgary Flames on 11 Nov 2026. The resolver read the league's own game feed and ESPN (final score Rangers 3, Flames 1) and ruled YES; a code check decided the winner and the AI audit agreed on a re-run. Nobody challenged, and at finalize the maker received about 5.7283 wNEAR.",
    proves: "Sports results are settled from the league's official feed cross-checked with a second source.",
    txs: [
      {
        label: "open",
        hash: "5eAKRi31QSBNnTT9UNpgDfekGYN6CDNJxXA3jJaQUmWh"
      },
      {
        label: "take",
        hash: "4fqyezhrBFWyafRuKrsqQL4x9wLztUwghQ6XcahEGwcX"
      },
      {
        label: "request_resolution",
        hash: "Hx4j44XKf53y3cqGvduoKBFFJe9VWYj7jz7ED8reHzxW"
      },
      {
        label: "submit_outcome",
        hash: "7aNpEkKGxNENeZiTvVkZnxwp5djUXAKVenQuhcb8S43x"
      },
      {
        label: "finalize",
        hash: "AWuw15pMesnizXokiEdTwejtESBmJmaNhyeFhymJgLR"
      }
    ]
  },
  {
    id: "noaa-kp-index-no",
    network: "testnet",
    title: "NOAA planetary Kp index at least 2: NO",
    date: "2026-11-12",
    betIds: [
      54
    ],
    stake: "15 USDC per side (test USDC)",
    outcome: "NO",
    happened: "The maker bet that NOAA's planetary Kp index for 21:00-24:00 UTC on 11 Nov 2026 would be 2 or higher. Two AI models both quoted NOAA's published row (Kp 1.33) and noted GFZ Potsdam's 1.0, and ruled NO. At finalize the taker received 29.00 USDC.",
    proves: "Two independent models must quote the same official data row; the result is not limited to prices or sports.",
    txs: [
      {
        label: "open",
        hash: "BYiUTbeTrB3UsMcvD35s8mCbFEikLQQcnfy89jZUGdmk"
      },
      {
        label: "take",
        hash: "4m3pjFNWWa4btqNbTg3yy5PH41ojg57ut9UPiPVHm1jZ"
      },
      {
        label: "request_resolution",
        hash: "9wtoUgtdtikT2ryHPyJJyRmAArqbPgvmbuoLikb7fY65"
      },
      {
        label: "submit_outcome",
        hash: "475L2LnnHzJhhtmWUJr2Lt1gxKt727tD5rVCvhBHTcX8"
      },
      {
        label: "finalize",
        hash: "J9nZnYBeivSPHXQZAZwDAUu78xRgGkrx2fYJPnSwJ5sN"
      }
    ]
  },
  {
    id: "human-referee-knicks-cavaliers-no",
    network: "testnet",
    title: "Human referee rules an NBA game: NO",
    date: "2026-11-12",
    betIds: [
      53
    ],
    stake: "10 USDC per side (test USDC)",
    outcome: "NO",
    happened: "The maker bet that the Knicks would beat the Cavaliers on 11 Nov 2026 and named a human referee instead of the AI. Cleveland won; the referee ruled NO, and that single ruling paid the taker 19.00 USDC in the same transaction.",
    proves: "Bets can be decided by a named person instead of the AI, and the escrow pays out on that person's signed ruling.",
    txs: [
      {
        label: "open",
        hash: "JEJkDC6AMp62doWy3yvt5qRenVjw2dPCD34Y7PkAusNR"
      },
      {
        label: "take",
        hash: "CvDgmjPU6NMhBjMTP5qtGAUk3bJUviiLbVSHvibak2jM"
      },
      {
        label: "referee_rule NO (pays out)",
        hash: "DurcUMBCHfeGBH3X2duvEDwz8q4dcXbqeEtCvy3DDATQ"
      }
    ]
  }
];

// DOCS2: what has actually run on MAINNET, per claim on the Hackathon page (cards a-h) and the Trust page. Data only: after the
// mainnet smoke run and the hackathon self-bet, DOCS3 edits this file (status, txs, betIds) and the pages follow.
// RULE: a claim is "proven" or "partial" only with at least one mainnet tx hash or bet id (effectiveStatus enforces it at render;
// tests/docs2.unit.test.ts also checks that every hash here is chain-checked in spikes/docs2/CLAIMS.md).
import type { NetworkId } from "./networkSelect";

export type EvidenceStatus = "proven" | "partial" | "in-progress";
export interface EvidenceTx { hash: string; label: string }
export interface Evidence {
  status: EvidenceStatus;
  /** Mainnet transactions that show it (linked to nearblocks.io). */
  txs: EvidenceTx[];
  /** Mainnet bet ids that show it. */
  betIds: number[];
  /** What the txs / bets show, in one or two sentences. */
  shows: string;
  /** What has not run on mainnet yet, and which run will prove it. Required unless proven. */
  pending?: string;
}

/** The latest read (DOCS5, spikes/docs5/REPORT.md; DOCS2's was bet_count 0 at block 224306325): public RPC, finality final. */
export const MAINNET_STATUS = { betCount: 2, checkedAt: "14 November 2026, 09:17 ET", block: 224525411, blockText: (224525411).toLocaleString("en-US") } as const;

export const CLAIM_IDS = ["judge", "signed-keys", "immutable", "reproducible", "failsafe", "disputes", "intents", "verifier"] as const;
export type ClaimId = (typeof CLAIM_IDS)[number];

const PENDING_RUN = "the hackathon bet (mainnet bet 2, ruled after the winners are announced) or a later mainnet bet";
/** Mainnet bet 1, in one sentence (its txs: README "Bets Praetorial has settled", docs/BETS.md; scripts/verify-bet.mjs --network mainnet 1 = 12 PASS). */
const BET1 = "Mainnet bet 1 (BTC 1-minute close at or above $68,350 at 2026-11-13 23:59 UTC) settled: the judge read Coinbase, Bitstamp and Kraken, code decided NO from the median (68,252.9), the checking model agreed, the escrow accepted the signed ruling, and the YES side conceded during the challenge window.";

/** Transactions, all on mainnet, all checked read-only (spikes/docs2/CLAIMS.md "Mainnet transactions"). */
export const TX = {
  deploy: { hash: "9gFoypqaFzHEnUmkecG6NarvzoH8fdg8Bn2TPfy34NpX", label: "Deploy the escrow code and call new()" },
  deleteKey: { hash: "ACkj5srVv2nav4iUuszyefkEGtonjQJVfusbRAS36UT3", label: "Delete the escrow's last access key" },
  attestKeyRun: { hash: "FF7ta6qDfBEN4ivby1VQ5Nyyfj9qgxvjxuveFWgUH3bP", label: "Judge program reports the attest key (before deploy)" },
  outcomeKeyRun: { hash: "68bixJNEftXehdSjrSfF9r6VSa5diPAMnFEkLFATeCAB", label: "Judge program reports the ruling key (before deploy)" },
  outcomeKeyCheck: { hash: "Dbp3M7nfrNKfyoyMunmnS5kHjacuU18NfVEqBRwgYw9m", label: "Check E4: ruling key again, after deploy" },
  attestKeyCheck: { hash: "GSeXpea6crnGu1BtZDQKwyfo63YFg5j6HBADrAYvjHoF", label: "Check E4: attest key again, after deploy" },
} as const satisfies Record<string, EvidenceTx>;

export const MAINNET_EVIDENCE: Record<ClaimId, Evidence> = {
  judge: {
    status: "partial", txs: [], betIds: [1],
    shows: BET1,
    pending: `Mainnet run pending: a custom bet decided by two models on mainnet (${PENDING_RUN}). On testnet, custom bets were ruled this way (docs/BETS.md).`,
  },
  "signed-keys": {
    status: "proven",
    txs: [TX.attestKeyRun, TX.outcomeKeyRun, TX.deploy, TX.outcomeKeyCheck, TX.attestKeyCheck],
    betIds: [1],
    shows: "The pinned judge program (8791413f…) reported its ruling key when run as the escrow, and its attest key when run as the attest signer. Those are exactly the two keys the escrow pinned at deploy. We ran the same two runs again after deploy (check E4) and got the same keys. Mainnet bet 1's ruling was signed with that ruling key and accepted by the escrow.",
  },
  immutable: {
    status: "proven", txs: [TX.deploy, TX.deleteKey], betIds: [],
    shows: "The escrow's code was deployed, then its last access key was deleted two minutes later. The account has had no keys since, so nobody can change its code or move its money by hand.",
  },
  reproducible: {
    status: "proven", txs: [TX.deploy], betIds: [],
    shows: "The deploy transaction installed code whose hash equals three identical reproducible builds of the escrow's source. The judge program that OutLayer ran in the key-binding transactions hashes to the resolver's reproducible build.",
  },
  failsafe: {
    status: "in-progress", txs: [], betIds: [],
    shows: "The refund paths are in the deployed code. None has run on mainnet yet.",
    pending: `Mainnet run pending: a VOID ruling or a void_after_deadline refund on mainnet (${PENDING_RUN}). We rehearsed it on testnet; see the case studies.`,
  },
  disputes: {
    status: "in-progress", txs: [], betIds: [],
    shows: "Challenges and re-judging are in the deployed code (up to two rounds). None has run on mainnet yet.",
    pending: `Mainnet run pending: a challenged mainnet bet, with its bond transaction and the second ruling (${PENDING_RUN}). We rehearsed it on testnet; see the case studies.`,
  },
  intents: {
    status: "partial", txs: [], betIds: [1, 2],
    shows: "Mainnet bets 1 and 2 were staked from NEAR Intents balances (3 wNEAR a side, sent to the escrow as NEP-245 transfers), and bet 1 paid out to one. The mainnet site has 1Click switched on.",
    pending: "Not linked here yet: a 1Click deposit and cash-out on mainnet.",
  },
  verifier: {
    status: "partial", txs: [TX.deploy, TX.outcomeKeyCheck, TX.attestKeyCheck], betIds: [1],
    shows: "The escrow checks E1 to E4 ran against the mainnet escrow at deploy and passed: the code hash, the pinned keys and program, the program download, and the key-binding runs linked here. On mainnet bet 1, scripts/verify-bet.mjs passes all 12 of its checks (terms hash, ruling signature, program hash, escrow code and keys, every transaction).",
    pending: "Not yet checked by the verifier on mainnet: challenge bonds and payouts against balances (B5).",
  },
};

/** The status a page may show: "proven" or "partial" with no tx and no bet id is shown as "in-progress". */
export function effectiveStatus(e: Evidence): EvidenceStatus {
  if (e.status !== "in-progress" && e.txs.length === 0 && e.betIds.length === 0) return "in-progress";
  return e.status;
}

export const STATUS_LABEL: Record<EvidenceStatus, string> = {
  proven: "Proven on mainnet",
  partial: "Partly proven on mainnet",
  "in-progress": "In progress",
};

export const txUrl = (network: NetworkId, hash: string): string =>
  network === "mainnet" ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;

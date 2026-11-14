// DR0 part 2: expected payout / fee / tip per ending, re-derived from the frozen escrow rules
// (contracts/escrow/src/lib.rs: side_fee, finalize YES/NO + VOID, referee_rule, concede, void_after_deadline, pay_tips).
// Fee parameters are NOT hard-coded: min_fee_per_side / cap come from the release config (services/release/example),
// fee_bps from the contract constant PROTOCOL_FEE_BPS_V1. Single source of truth for rehearsal money assertions.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const RELEASE_ARGS = join(REPO, "services", "release", "example", "args.indicative.json");
const ESCROW_SRC = join(REPO, "contracts", "escrow", "src", "lib.rs");

export interface FeeConfig {
  feeBps: bigint;
  minFeePerSide: bigint;
  minFeeCapPerSide: bigint;
  source: { release: string; feeBps: string; asset: string };
}

/** Fee parameters for the release's USDC asset (6 decimals). Throws if the config or constant cannot be found. */
export function loadFeeConfig(): FeeConfig {
  const args = JSON.parse(readFileSync(RELEASE_ARGS, "utf8"));
  const row = (args.asset_limits as [string, Record<string, string>][]).find(([id]) => id === args.usdc_token_id);
  if (!row) throw new Error("release args: no asset_limits row for usdc_token_id");
  const m = readFileSync(ESCROW_SRC, "utf8").match(/pub const PROTOCOL_FEE_BPS_V1: u32 = (\d+);/);
  if (!m) throw new Error("PROTOCOL_FEE_BPS_V1 not found in the escrow source");
  return {
    feeBps: BigInt(m[1]),
    minFeePerSide: BigInt(row[1].min_fee_per_side),
    minFeeCapPerSide: BigInt(row[1].min_fee_cap_per_side),
    source: { release: RELEASE_ARGS, feeBps: "contracts/escrow/src/lib.rs PROTOCOL_FEE_BPS_V1", asset: row[0] },
  };
}

/** D-FEEMIN1: min(stake, max(stake*fee_bps/10000, min_fee_per_side)); same arithmetic as the contract's side_fee. */
export function sideFee(stake: bigint, feeBps: bigint, minFeePerSide: bigint): bigint {
  const pct = (stake * feeBps) / 10_000n;
  const f = pct > minFeePerSide ? pct : minFeePerSide;
  return f < stake ? f : stake;
}

export type Ending = "YES" | "NO" | "VOID" | "CONCEDE_MAKER" | "CONCEDE_TAKER" | "REFEREE_YES" | "REFEREE_NO" | "REFEREE_VOID" | "DEADLINE_REFUND";
export type Role = "maker" | "taker" | "fee" | "referee";

export interface Params {
  stakeMaker: bigint; stakeTaker: bigint;
  feeBps: bigint;
  /** the bet's own fee copies (fee_min_maker / fee_min_taker; the taker one comes from the matched taker option) */
  minFeeMaker: bigint; minFeeTaker: bigint;
  storageMaker: bigint; storageTaker: bigint;
  keepTerms: boolean;
  makerSide: "YES" | "NO";
  referee: boolean; tipMaker: boolean; tipTaker: boolean;
}
export interface Line { to: Role; side: "maker" | "taker"; amount: bigint; reason: string }
export interface Settlement { lines: Line[]; deposits: { maker: bigint; taker: bigint } }

export function expectedSettlement(ending: Ending, p: Params): Settlement {
  const fm = sideFee(p.stakeMaker, p.feeBps, p.minFeeMaker);
  const ft = sideFee(p.stakeTaker, p.feeBps, p.minFeeTaker);
  // pay_tips: only with a named referee and only on endings that call it (not the AI finalize path)
  const tipsApply = p.referee && ending !== "YES" && ending !== "NO" && ending !== "VOID";
  const tm = tipsApply && p.tipMaker ? fm : 0n; // tip = side_fee on the bettor's own stake
  const tt = tipsApply && p.tipTaker ? ft : 0n;
  const lines: Line[] = [];
  const add = (to: Role, side: "maker" | "taker", amount: bigint, reason: string) => { if (amount > 0n) lines.push({ to, side, amount, reason }); };
  const tips = () => { add("referee", "maker", tm, "referee_tip"); add("referee", "taker", tt, "referee_tip"); };
  const decisive = (winner: "maker" | "taker") => {
    add(winner, "maker", p.stakeMaker - fm - tm, "payout_winner");
    add(winner, "taker", p.stakeTaker - ft - tt, "payout_winner");
    add("fee", "maker", fm + p.storageMaker, "fee_and_storage");
    add("fee", "taker", ft + p.storageTaker, "fee_and_storage");
    tips();
  };
  const refund = (reason: string) => {
    add("maker", "maker", p.stakeMaker - tm, reason + "_maker");
    add("taker", "taker", p.stakeTaker - tt, reason + "_taker");
    if (p.keepTerms) { add("fee", "maker", p.storageMaker, "void_storage_keep_terms"); add("fee", "taker", p.storageTaker, "void_storage_keep_terms"); }
    else { add("maker", "maker", p.storageMaker, "void_storage_refund_maker"); add("taker", "taker", p.storageTaker, "void_storage_refund_taker"); }
    tips();
  };
  const makerWins = (o: "YES" | "NO") => o === p.makerSide;
  switch (ending) {
    case "YES": case "NO": decisive(makerWins(ending) ? "maker" : "taker"); break;
    case "REFEREE_YES": decisive(makerWins("YES") ? "maker" : "taker"); break;
    case "REFEREE_NO": decisive(makerWins("NO") ? "maker" : "taker"); break;
    case "CONCEDE_MAKER": decisive("taker"); break; // the conceder loses
    case "CONCEDE_TAKER": decisive("maker"); break;
    case "VOID": refund("void_refund"); break;
    case "REFEREE_VOID": refund("void_refund"); break;
    case "DEADLINE_REFUND": refund("void_deadline"); break;
  }
  return { lines, deposits: { maker: p.stakeMaker + p.storageMaker, taker: p.stakeTaker + p.storageTaker } };
}

/** Conservation (I-1 per asset): everything deposited is paid out, so the escrow holds 0 of each asset afterwards. */
export function assertEscrowDrained(s: Settlement): void {
  for (const side of ["maker", "taker"] as const) {
    const out = s.lines.filter((l) => l.side === side).reduce((a, l) => a + l.amount, 0n);
    if (out !== s.deposits[side]) throw new Error(`escrow ${side}-asset residue: deposited ${s.deposits[side]} != paid out ${out}`);
  }
}

/** Compares observed balance deltas (raw units, per role; same-asset bet) with the expected settlement. Returns mismatches. */
export function checkObserved(s: Settlement, deltas: Partial<Record<Role, bigint>>, opts: { escrowAfter: bigint }): string[] {
  const bad: string[] = [];
  for (const role of ["maker", "taker", "fee", "referee"] as Role[]) {
    const want = s.lines.filter((l) => l.to === role).reduce((a, l) => a + l.amount, 0n);
    const got = deltas[role] ?? 0n;
    if (got !== want) bad.push(`${role}: observed delta ${got} != expected ${want}`);
  }
  if (opts.escrowAfter !== 0n) bad.push(`escrow holds ${opts.escrowAfter} after the last payout, expected 0`);
  return bad;
}

// ---- DR1b (D-PM3): per-bet money check -------------------------------------------------------------------------------
// The balance-delta assertion is KEPT (never loosened) but only where it is valid: for per-run FRESH maker/taker accounts nothing
// else can move their balance, so delta == this bet's credit to the yocto. The fee account and the escrow are shared by every
// bet on the deployment, so their balance deltas are confounded over a long wait; for them the money is proven from the
// escrow's own finalize/payout receipts for THIS bet_id (intents mt_transfer calls sent by the escrow), plus is_fully_paid and
// per-bet residue 0 (deposits - receipt credits).
import { generateKeyPairSync } from "node:crypto";

export interface ReceiptCtx { escrow: string; intents: string; betId: number; token: string }
export interface ReceiptCredits { credits: Record<string, bigint>; payoutBetIds: number[] }

/** Credits to each receiver account from the escrow's mt_transfer receipts in a finalize/payout tx_status result (EXPERIMENTAL_tx_status `result`). */
export function creditsFromReceipts(tx: any, ctx: ReceiptCtx): ReceiptCredits {
  const outcomes = new Map<string, any>();
  const payoutBetIds: number[] = [];
  for (const o of tx.receipts_outcome ?? []) {
    outcomes.set(o.id, o.outcome);
    if (o.outcome.executor_id !== ctx.escrow) continue;
    for (const l of o.outcome.logs as string[]) {
      if (!l.startsWith("EVENT_JSON:")) continue;
      const ev = JSON.parse(l.slice("EVENT_JSON:".length));
      if (ev.standard !== "praetorial-escrow") continue;
      for (const d of ev.data ?? []) {
        if (typeof d.bet_id !== "number") continue;
        if (d.bet_id !== ctx.betId) throw new Error(`receipts: event ${ev.event} names bet_id ${d.bet_id}, expected ${ctx.betId}`);
        if (ev.event === "payout_done") payoutBetIds.push(d.bet_id);
      }
    }
  }
  const credits: Record<string, bigint> = {};
  for (const r of tx.receipts ?? []) {
    if (r.receiver_id !== ctx.intents || r.predecessor_id !== ctx.escrow) continue;
    const fc = r.receipt?.Action?.actions?.[0]?.FunctionCall;
    if (!fc || fc.method_name !== "mt_transfer") continue;
    const out = outcomes.get(r.receipt_id);
    if (!out || out.status?.SuccessValue === undefined) throw new Error(`receipts: mt_transfer receipt ${r.receipt_id} did not succeed (failed or missing outcome)`);
    const a = JSON.parse(Buffer.from(fc.args, "base64").toString("utf8"));
    if (a.token_id !== ctx.token) throw new Error(`receipts: mt_transfer token ${a.token_id} != bet token ${ctx.token}`);
    credits[a.receiver_id] = (credits[a.receiver_id] ?? 0n) + BigInt(a.amount);
  }
  return { credits, payoutBetIds };
}

export interface PerBetInput {
  /** role -> account that receives that role's money */
  accounts: { maker: string; taker: string; fee: string; referee?: string };
  credits: Record<string, bigint>;
  /** balance deltas of the per-run bettor accounts (omit a role to skip, e.g. a legacy run on shared accounts) */
  bettorDeltas?: { maker?: bigint; taker?: bigint };
  /** true only for accounts created for this run (balance 0 before funding) */
  fresh?: { maker?: boolean; taker?: boolean };
  isFullyPaid: boolean;
}

/** Hard assertions for one bet. Returns mismatches ([] == ok). */
export function checkPerBetMoney(s: Settlement, i: PerBetInput): string[] {
  const bad: string[] = [];
  const want = (role: Role) => s.lines.filter((l) => l.to === role).reduce((a, l) => a + l.amount, 0n);
  const acct: Record<string, string | undefined> = { maker: i.accounts.maker, taker: i.accounts.taker, fee: i.accounts.fee, referee: i.accounts.referee };
  const known = new Set<string>();
  for (const role of ["maker", "taker", "fee", "referee"] as Role[]) {
    const a = acct[role];
    const w = want(role);
    if (!a) { if (w !== 0n) bad.push(`${role}: no account given but expected ${w}`); continue; }
    known.add(a);
    const got = i.credits[a] ?? 0n;
    if (got !== w) bad.push(`${role}: receipt credit ${got} != expected ${w}`);
  }
  for (const [a, v] of Object.entries(i.credits)) if (!known.has(a) && v !== 0n) bad.push(`${a}: unexpected receipt credit ${v} (not a party of this bet)`);
  const paid = Object.values(i.credits).reduce((x, y) => x + y, 0n);
  const dep = s.deposits.maker + s.deposits.taker;
  if (paid !== dep) bad.push(`bet residue ${dep - paid}: deposits ${dep} - receipt credits ${paid} != 0`);
  if (!i.isFullyPaid) bad.push("is_fully_paid is false");
  for (const role of ["maker", "taker"] as const) {
    const d = i.bettorDeltas?.[role];
    if (d === undefined) continue;
    if (i.fresh?.[role] !== true) { bad.push(`${role}: account not fresh, balance delta is confounded by other bets (use a per-run account)`); continue; }
    if (d !== want(role)) bad.push(`${role}: balance delta ${d} != expected ${want(role)}`);
  }
  return bad;
}

/** Per-run bettor identities: new ed25519 keys -> implicit (64-hex) accounts that no earlier run or bet has touched. */
export function freshBettorAccounts(): Record<"maker" | "taker", { account: string; secretKeyPkcs8Der: Buffer }> {
  const mk = () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    return { account: raw.toString("hex"), secretKeyPkcs8Der: privateKey.export({ format: "der", type: "pkcs8" }) as Buffer };
  };
  return { maker: mk(), taker: mk() };
}

/** Call with the account's mt_balance_of BEFORE funding it: anything but 0 means the account is not fresh. */
export function assertFreshBefore(role: string, balanceBefore: bigint): void {
  if (balanceBefore !== 0n) throw new Error(`${role} account is not fresh: starting balance ${balanceBefore} != 0`);
}

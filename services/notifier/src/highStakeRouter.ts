// High-stakes Telegram routing (launch checklist: "Notifier: 2nd
// channel (Telegram) for bets >= $500"). Bets whose per-side stake is
// worth >= $500 USD-equivalent additionally fan out to Telegram, on
// top of whatever the existing (email/outbox) channel already does --
// this module never replaces or mutates that path.
//
// Praetorial has no live price feed wired into services/common as of
// this change (checked: no decimals/USD helper exists there). Rather
// than invent a live price call, USD valuation here takes an INJECTED
// AssetPriceTable -- the caller (ops config, or a test) supplies each
// asset's decimals and a USD price per whole token, exactly as the
// task instructs ("an injected price table; do not invent live
// prices"). Each side is valued in its OWN staked asset, read off the
// bet's envelope.maker_asset/taker_asset (contracts/escrow/src/lib.rs
// Envelope.maker_asset/taker_asset, mirrored on services/common's Bet
// type) -- never a single asset id applied to both sides. A
// cross-asset bet (maker_asset != taker_asset) is fully supported:
// one side can clear the $500 threshold while the other doesn't.
import type { Contact, ContactStore } from "./contactStore.js";
import type { TelegramChannel } from "./telegram.js";
import type { Notice } from "./notifier.js";
import type { Bet } from "@praetorial/common/types.js";

export interface AssetInfo {
  decimals: number;
  usdPerToken: number;
}
export type AssetPriceTable = Record<string, AssetInfo>;

export interface StakeSide {
  account: string;
  /** Raw on-chain amount, native base units, decimal string (same
   * convention as Envelope.stake_maker/stake_taker). */
  amount: string;
  assetId: string;
}

export interface HighStakeEvent {
  bet_id: number;
  /** Short human label for the event, e.g. "proposed" / "settled". No
   * personal data -- same NoticeKind vocabulary as notifier.ts. */
  event: string;
  /** Public, non-PII link to the bet (e.g. explorer/app URL). */
  link: string;
  sides: StakeSide[];
}

/** Converts a native-unit stake into USD using `table`'s decimals/price
 * for that side's asset. Throws on an asset missing from the table --
 * better to fail loudly than silently under/over-notify on an unpriced
 * asset. */
export function sideUsdValue(side: StakeSide, table: AssetPriceTable): number {
  const info = table[side.assetId];
  if (!info) throw new Error(`highStakeRouter: no price entry for asset "${side.assetId}"`);
  const raw = BigInt(side.amount);
  const whole = Number(raw) / 10 ** info.decimals;
  return whole * info.usdPerToken;
}

/** Accounts (deduped) whose OWN side of this bet is worth >= threshold
 * USD -- "stake >= $500 per side", not the combined pot, and each
 * side's own asset decimals are used (cross-asset bets are supported:
 * one side can cross the threshold while the other doesn't). A side
 * whose asset has no entry in `table` is never routed on -- it is
 * skipped and a warning is logged (bet id/event/asset only, no account
 * id) rather than throwing and losing every other side/event in the
 * same tick. */
export function highStakeAccounts(
  ev: HighStakeEvent,
  table: AssetPriceTable,
  thresholdUsd = 500,
): string[] {
  const accounts = new Set<string>();
  for (const side of ev.sides) {
    let usd: number;
    try {
      usd = sideUsdValue(side, table);
    } catch {
      console.warn(
        `highStakeRouter: no price entry for asset "${side.assetId}" (bet #${ev.bet_id}, ${ev.event}) -- skipping this side, not routed`,
      );
      continue;
    }
    if (usd >= thresholdUsd) accounts.add(side.account);
  }
  return [...accounts];
}

/** Bet id, event and link only -- no personal data, matches the
 * message-content requirement exactly. */
export function buildTelegramMessage(ev: HighStakeEvent): string {
  return `Bet #${ev.bet_id}: ${ev.event}\n${ev.link}`;
}

/** Turns the notifier's existing per-tick Notice[] + the bets it was
 * computed from into HighStakeEvent[], one per notice that still has a
 * resolvable bet (a bet that has since been pruned from `betsByContract`
 * is simply skipped -- same "alerts are a convenience" posture as the
 * rest of this file). Each side's `assetId` is read from the bet's OWN
 * `envelope.maker_asset`/`taker_asset` (mirrors the escrow contract's
 * `Envelope.maker_asset`/`taker_asset`, contracts/escrow/src/lib.rs) --
 * NOT a single asset id shared across both sides. For a same-asset bet
 * these two fields are equal, so that case is unchanged; a cross-asset
 * bet now values each side in its own asset, as it must. */
export function noticesToHighStakeEvents(
  notices: Notice[],
  betsByContract: Map<string, Map<number, Bet>>,
  linkBase: string,
): HighStakeEvent[] {
  const events: HighStakeEvent[] = [];
  for (const notice of notices) {
    const bets = betsByContract.get(notice.contract_id ?? "");
    const bet = bets?.get(notice.bet_id);
    if (!bet) continue;
    const sides: StakeSide[] = [];
    if (bet.envelope.maker) {
      sides.push({ account: bet.envelope.maker, amount: bet.envelope.stake_maker, assetId: bet.envelope.maker_asset });
    }
    if (bet.taker) {
      sides.push({ account: bet.taker, amount: bet.envelope.stake_taker, assetId: bet.envelope.taker_asset });
    }
    events.push({
      bet_id: notice.bet_id,
      event: notice.kind,
      link: `${linkBase}/${notice.bet_id}`,
      sides,
    });
  }
  return events;
}

export interface ContactLookup {
  getContact(account: string): Contact | null;
}

/** Routes every high-stake event to Telegram for every opted-in,
 * not-deleted account on its qualifying side(s). An account with no
 * stored contact, a non-telegram contact, or a deleted contact
 * (getContact returns null post-deletion, per contactStore.ts) is
 * silently skipped -- never an error, since opting out/deleting is a
 * normal, expected state. */
export async function routeHighStakeToTelegram(
  events: HighStakeEvent[],
  table: AssetPriceTable,
  contacts: ContactLookup,
  channel: TelegramChannel,
  thresholdUsd = 500,
): Promise<void> {
  for (const ev of events) {
    const accounts = highStakeAccounts(ev, table, thresholdUsd);
    if (accounts.length === 0) continue;
    const text = buildTelegramMessage(ev);
    for (const account of accounts) {
      const contact = contacts.getContact(account);
      if (!contact || contact.kind !== "telegram") continue;
      await channel.send(contact.value, text);
    }
  }
}

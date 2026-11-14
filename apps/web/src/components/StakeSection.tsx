// BET1b (UX-33 section 3): the make-a-bet Stake section.
//   You put in   [ 10        | (logo) NEAR v ]
//   They put in  [ 10        | (logo) NEAR   ]      (same token; even until edited; editing either sets the odds)
//   Min 2.74 NEAR · fee 0.14 NEAR each
// Any of the six launch tokens with an id on this network (D-ASSET1). Limits/fee are read live from the contract's asset_limit /
// protocol_fee_bps views for the chosen token (D-PARAMS1), the release table only while loading. No "$" for USDC/USDT (UX-31).
// Cross-asset taker options are gone (D-SCOPE5): the offer carries only the same-token option.
import React, { useEffect, useRef, useState } from "react";
import { InputGroup, InputGroupText } from "@astryxdesign/core/InputGroup";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Banner, Button } from "../ui";
import AssetLogo, { assetIcon } from "./AssetLogo";
import { viewFunction } from "../../lib/rpc";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { limitsFor, stakeProblem, type AssetLimitView, type StakeLimits } from "../../lib/stakeDeadlines";
import { stakeAssets, theirStakeText, oddsFor, ratioProblem, stakeLine, stakeUnits, stakeFromDraft, type StakeDraft } from "../../lib/stakeSection";

export interface Stake {
  symbol: string; setSymbol: (s: string) => void;
  stakeText: string; setStakeText: (t: string) => void;
  /** null = even (follows yours). */
  theirText: string | null; setTheirText: (t: string | null) => void;
  /** What "They put in" shows. */
  theirs: string;
  makerAmount: number; takerAmount: number;
  /** taker:maker, from the two amounts (0 while either is not a number yet). */
  odds: number;
  limits: StakeLimits;
  stakeErr: string | null; theirStakeErr: string | null;
  /** The fields CreateDraft.more keeps for this section. */
  draft: Required<StakeDraft>;
}

/** The section's state (kept by CreateOffer so drafts, Edit and copy keep it) and everything derived from it. */
export function useStake(more: StakeDraft | undefined): Stake {
  const init = useRef(stakeFromDraft(more)).current;
  const [symbol, setSymbolRaw] = useState(init.symbol);
  const [stakeText, setStakeText] = useState(init.stakeText);
  const [theirText, setTheirText] = useState<string | null>(init.theirText);
  const [limitView, setLimitView] = useState<AssetLimitView | null>(null);
  const [feeBps, setFeeBps] = useState<number | null>(null);
  const assetId = stakeAssets().find((a) => a.symbol === symbol)?.assetId ?? null;
  useEffect(() => {
    viewFunction<number | null>(ESCROW_CONTRACT_ID, "protocol_fee_bps", {}).then((v) => setFeeBps(typeof v === "number" ? v : null)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!assetId) return;
    let live = true;
    setLimitView(null);
    viewFunction<AssetLimitView | null>(ESCROW_CONTRACT_ID, "asset_limit", { asset_id: assetId }).then((v) => { if (live) setLimitView(v ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [assetId]);

  const theirs = theirStakeText(stakeText, theirText);
  const odds = oddsFor(stakeText, theirs);
  const limits = limitsFor(symbol, limitView, feeBps);
  const stakeErr = stakeProblem(symbol, stakeText, limits);
  const theirStakeErr = (() => {
    if (theirText === null) return null; // even: your own amount's check covers it
    if (!theirText.trim()) return "Enter what they put in.";
    const p = stakeProblem(symbol, theirText, limits);
    if (p) return `The other person's stake: ${p}`;
    return ratioProblem(symbol, stakeText, theirText);
  })();
  return {
    symbol, setSymbol: setSymbolRaw,
    stakeText, setStakeText, theirText, setTheirText, theirs,
    makerAmount: Number(stakeText) || 0, takerAmount: Number(theirs) || 0,
    odds, limits, stakeErr, theirStakeErr,
    draft: { stakeText, odds, stakeSymbol: symbol, theirText },
  };
}

export default function StakeSection({ stake }: { stake: Stake }) {
  const { symbol, stakeText, theirText, theirs, limits, stakeErr, theirStakeErr } = stake;
  const assets = stakeAssets();
  const line = stakeLine(limits, stakeErr ? null : stakeUnits(symbol, stakeText), theirStakeErr ? null : stakeUnits(symbol, theirs));
  return (
    <VStack gap={2} data-testid="stake-section">
      <InputGroup label="You put in">
        <TextInput
          label="Amount you put in"
          isLabelHidden
          data-testid="maker-amount"
          inputMode="decimal"
          value={stakeText}
          onChange={(v: string) => stake.setStakeText(v)}
        />
        <Selector
          label="Token"
          isLabelHidden
          data-testid="stake-asset"
          width={128}
          value={symbol}
          onChange={(v: string) => { if (v) stake.setSymbol(v); }}
          startIcon={assetIcon(symbol)}
          options={assets.map((a) => ({ value: a.symbol, label: a.symbol, icon: assetIcon(a.symbol) }))}
        />
      </InputGroup>
      {stakeErr && <Banner status="error" data-testid="stake-error">{stakeErr}</Banner>}
      <InputGroup label="They put in">
        <TextInput
          label="Amount they put in"
          isLabelHidden
          data-testid="taker-amount"
          inputMode="decimal"
          value={theirs}
          onChange={(v: string) => stake.setTheirText(v)}
        />
        <InputGroupText>
          <HStack gap={1} vAlign="center">
            <AssetLogo symbol={symbol} />
            <Text data-testid="taker-token">{symbol}</Text>
          </HStack>
        </InputGroupText>
      </InputGroup>
      {theirStakeErr && <Banner status="error" data-testid="theirstake-error">{theirStakeErr}</Banner>}
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="supporting" data-testid="stake-limits">{line}</Text>
        {theirText !== null && theirText !== stakeText && (
          <Button variant="ghost" size="sm" data-testid="stake-even" onClick={() => stake.setTheirText(null)}>Make it even</Button>
        )}
      </HStack>
    </VStack>
  );
}

import React, { useState } from "react";
import { ClickCard, Button } from "../ui";
import { BET_TYPE_CARDS, PICKER_TILES, PRICE_KINDS, type BetKind, type BetTypeCard, type PickerTile } from "../../lib/betTypePicker";
import BetTypeIcon from "./BetTypeIcon";

// S2: pick a bet type. One card per type; no preset buttons. BET1a: a small icon beside each card's title and one-line blurb;
// the example sits underneath in smaller, quieter text. TPL1 (PM 14:05, familiarcow): the main view shows ONE "Asset prices" tile
// that opens a sub-choice of the price types; `group` = "prices" opens straight on that sub-choice (Back from a price form).
const ROW: React.CSSProperties = { display: "flex", gap: "var(--spacing-3, 12px)", alignItems: "flex-start" };
const ICON: React.CSSProperties = {
  flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 40, height: 40,
  borderRadius: "var(--radius-element, 8px)", background: "var(--color-background-muted)", color: "var(--color-text-accent)",
};
const GRID: React.CSSProperties = { display: "grid", gap: "var(--spacing-2, 8px)", maxWidth: 560 };

function Card({ c, onClick }: { c: BetTypeCard | PickerTile; onClick: () => void }) {
  return (
    <ClickCard label={`${c.title}. ${c.blurb}`} data-testid={`bet-type-card-${c.id}`} onClick={onClick}>
      <span style={ROW}>
        <span style={ICON}><BetTypeIcon icon={c.icon} /></span>
        <span style={{ display: "block", minWidth: 0 }}>
          <strong style={{ display: "block" }}>{c.title}</strong>
          <span style={{ display: "block", color: "var(--color-text-primary)" }}>{c.blurb}</span>
          <small style={{ display: "block", marginTop: 2, color: "var(--color-text-secondary)" }}>{c.example}</small>
        </span>
      </span>
    </ClickCard>
  );
}

export default function BetTypeStep({ onPick, group = null }: { onPick: (id: BetKind) => void; group?: "prices" | null }) {
  const [open, setOpen] = useState<"prices" | null>(group);
  if (open === "prices") {
    return (
      <div data-testid="bet-type-prices">
        <h3>Asset prices</h3>
        <p style={{ marginTop: 0 }}>What kind of price bet? You pick the coin on the next screen.</p>
        <div style={GRID}>
          {PRICE_KINDS.map((k) => BET_TYPE_CARDS.find((c) => c.id === k)!).map((c) => <Card key={c.id} c={c} onClick={() => onPick(c.id)} />)}
        </div>
        <p><Button type="button" data-testid="bet-type-prices-back" onClick={() => setOpen(null)}>Back</Button></p>
      </div>
    );
  }
  return (
    <div data-testid="bet-type-picker">
      <h3>What do you want to bet on?</h3>
      <div style={GRID}>
        {PICKER_TILES.map((c) => <Card key={c.id} c={c} onClick={() => (c.id === "prices" ? setOpen("prices") : onPick(c.id))} />)}
      </div>
    </div>
  );
}

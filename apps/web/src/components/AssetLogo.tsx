// BET1b (UX-33 / UX-31 "use asset logo"): small round marks for the six launch tokens. Each is an SVG component, so it can be
// passed straight to Astryx `icon` / `startIcon` props (IconType = ComponentType<SVGProps>). Brand colours are the token
// issuers' own and live only here (they are logo artwork, not theme colours).
import React from "react";

type Mark = { bg: string; fg: string; glyph: string };
const MARKS: Record<string, Mark> = {
  USDC: { bg: "#2775CA", fg: "#FFFFFF", glyph: "C" },
  USDT: { bg: "#26A17B", fg: "#FFFFFF", glyph: "₮" },
  NEAR: { bg: "#000000", fg: "#FFFFFF", glyph: "N" },
  BTC: { bg: "#F7931A", fg: "#FFFFFF", glyph: "₿" },
  ETH: { bg: "#627EEA", fg: "#FFFFFF", glyph: "Ξ" },
  ZEC: { bg: "#F4B728", fg: "#1A1A1A", glyph: "Z" },
};
const FALLBACK: Mark = { bg: "#8A8A8A", fg: "#FFFFFF", glyph: "?" };

function draw(symbol: string, props: React.SVGProps<SVGSVGElement>) {
  const m = MARKS[symbol] ?? FALLBACK;
  return (
    <svg viewBox="0 0 32 32" width="1em" height="1em" aria-hidden="true" focusable="false" data-testid={`asset-logo-${symbol}`} {...props}>
      <circle cx="16" cy="16" r="16" fill={m.bg} />
      <text x="16" y="16" dy="0.36em" textAnchor="middle" fontSize="17" fontWeight="700" fontFamily="system-ui, sans-serif" fill={m.fg}>{m.glyph}</text>
    </svg>
  );
}

const cache = new Map<string, React.ComponentType<React.SVGProps<SVGSVGElement>>>();
/** A stable icon component for `symbol` (same identity on every call, so React does not remount it). */
export function assetIcon(symbol: string): React.ComponentType<React.SVGProps<SVGSVGElement>> {
  let c = cache.get(symbol);
  if (!c) {
    c = (props: React.SVGProps<SVGSVGElement>) => draw(symbol, props);
    c.displayName = `AssetLogo(${symbol})`;
    cache.set(symbol, c);
  }
  return c;
}

export default function AssetLogo({ symbol, size = "1.25em" }: { symbol: string; size?: string }) {
  return draw(symbol, { width: size, height: size, style: { flexShrink: 0, verticalAlign: "middle" } });
}

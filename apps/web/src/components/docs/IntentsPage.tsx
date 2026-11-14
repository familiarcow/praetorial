// DOCS1 page 3: the NEAR Intents integration. The token table is generated from code (lib/assets.ts ASSET_TABLE + the release asset
// limits in lib/assetLimits.generated.ts, via lib/about.ts feeRows), never typed in. Mainnet / testnet status per route is sourced
// in spikes/docs1/CLAIMS.md "Page 3".
import React from "react";
import { ASSET_TABLE, isAssetEnabled, maxStakePerSide, LAUNCH_MAX_PER_SIDE } from "../../../lib/assets";
import { feeRows } from "../../../lib/about";
import { DocLink, DocsFrame, Ext, Tag, type Status } from "./parts";
import { MAINNET, NEAR_INTENTS_DOCS, explorer } from "../../../lib/docsFacts";

export interface AssetDocRow { symbol: string; onMain: boolean; onTest: boolean; minStake: string; minFee: string; noCap: boolean }

/** One row per bet token, straight from the asset table and the release limits. */
export function assetDocRows(): AssetDocRow[] {
  const fees = new Map(feeRows(ASSET_TABLE.map((a) => a.symbol)).map((r) => [r.symbol, r]));
  return ASSET_TABLE.map((a) => ({
    symbol: a.symbol,
    onMain: isAssetEnabled(a.symbol, "mainnet"),
    onTest: isAssetEnabled(a.symbol, "testnet"),
    minStake: fees.get(a.symbol)?.minStake ?? "",
    minFee: fees.get(a.symbol)?.minFee ?? "",
    noCap: (maxStakePerSide(a.symbol) ?? LAUNCH_MAX_PER_SIDE) === LAUNCH_MAX_PER_SIDE,
  }));
}

/** Ways money gets in and out. `mainnet` / `testnet` = what the code does on that network (CLAIMS.md has the file:line for each). */
export const MONEY_ROUTES: { id: string; title: string; text: string; onMain: Status | null; onTest: Status | null; note?: string }[] = [
  { id: "balance", title: "Your betting balance", text: "Held in your own account on NEAR Intents, not by us. Stakes move from it into the escrow when you make or take a bet, and payouts and refunds go back to it.", onMain: "mainnet", onTest: "testnet", note: "Testnet uses a test copy of the Intents contract." },
  { id: "any-wallet", title: "Add money from any wallet or exchange", text: "1Click gives you a one-time deposit address for the token and network you have. It converts what you send into a bet token and credits your betting balance.", onMain: "mainnet", onTest: null, note: "1Click exists on mainnet only; the test network shows previews, never an address." },
  { id: "near-wallet", title: "Move from your own NEAR wallet", text: "Tokens already in your NEAR account (NEAR, USDC, USDT, and BTC, ETH or ZEC tokens on NEAR) move into your betting balance with one transfer.", onMain: "mainnet", onTest: "testnet" },
  { id: "cash-out-near", title: "Cash out to your NEAR wallet", text: "USDC, USDT and NEAR go from your betting balance back to your NEAR account (NEAR arrives as wrapped NEAR).", onMain: "mainnet", onTest: "testnet" },
  { id: "cash-out-chain", title: "Cash out to another chain", text: "1Click sends your tokens to an address you give on another network.", onMain: "mainnet", onTest: null },
  { id: "convert", title: "Convert between bet tokens", text: "1Click swaps one bet token for another inside your betting balance.", onMain: "mainnet", onTest: null },
  { id: "faucet", title: "Free test NEAR", text: "A test-network faucet, so you can try a bet without real money.", onMain: null, onTest: "testnet" },
];

export default function IntentsPage() {
  const rows = assetDocRows();
  const allNoCap = rows.every((r) => r.noCap);
  return (
    <DocsFrame page="intents">
      <h1>NEAR Intents</h1>
      <p className="docs-lede">Praetorial keeps your money in NEAR Intents, so you can bet in several tokens and add money from several chains, without a bridge of our own.</p>
      <p>On mainnet your balance is in <Ext href={explorer("mainnet", MAINNET.intents)}><code>{MAINNET.intents}</code></Ext>, and stakes move from it into the escrow <Ext href={explorer("mainnet", MAINNET.escrow)}><code>{MAINNET.escrow}</code></Ext> and back. The test network, where we rehearsed, uses test copies of both.</p>

      <h2 id="tokens">Tokens you can bet with</h2>
      <p>The contract supports each side using a different token; the app creates same-token bets for now. These are the bet tokens and their limits per side, read from the release config.</p>
      <table className="docs-table" data-testid="docs-asset-table">
        <thead><tr><th scope="col">Token</th><th scope="col">Mainnet</th><th scope="col">Testnet (rehearsal)</th><th scope="col">Minimum stake</th><th scope="col">Minimum fee</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} data-testid={`docs-asset-${r.symbol}`}>
              <th scope="row" data-label="Token">{r.symbol}</th>
              <td data-label="Mainnet">{r.onMain ? "Yes" : "No"}</td>
              <td data-label="Testnet">{r.onTest ? "Yes" : "No"}</td>
              <td data-label="Minimum stake">{r.minStake}</td>
              <td data-label="Minimum fee">{r.minFee}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small" data-testid="docs-asset-cap">{allNoCap
        ? "There is no maximum stake per side at launch. The fee is 1% per side, with the minimum above, and only when a bet has a winner. Limits for new bets can change only after a 24 hour public notice."
        : "Some tokens have a maximum stake per side; the bet form shows it. The fee is 1% per side, with the minimum above, and only when a bet has a winner."}</p>

      <h2 id="money">Getting money in and out</h2>
      <table className="docs-table" data-testid="docs-routes">
        <thead><tr><th scope="col">What</th><th scope="col">How</th><th scope="col">Where it works</th></tr></thead>
        <tbody>
          {MONEY_ROUTES.map((r) => (
            <tr key={r.id} data-testid={`docs-route-${r.id}`}>
              <th scope="row" data-label="What">{r.title}</th>
              <td data-label="How">{r.text}{r.note && <span className="muted"> {r.note}</span>}</td>
              <td data-label="Where it works">
                <Tag s={r.onMain && r.onTest ? "both" : r.onMain ? "mainnet" : "testnet"} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">"Mainnet" means the code turns it on for mainnet and the mainnet site is built with it (checked 12 Nov 2026). It does not mean every token and network pair has been tried with real money.</p>

      <h2 id="how">How it fits together</h2>
      <ul className="facts">
        <li><strong>One balance, many tokens.</strong> Your balance is a set of tokens in your Intents account. A bet moves the stake straight from there to the escrow contract and back, so there is no wrapped token or bridge of ours in between.</li>
        <li><strong>Login creates the account.</strong> Logging in with your email creates your own NEAR account. You sign every bet, cash-out and transfer with it; we only pay the network fee for you.</li>
        <li><strong>The escrow only takes known tokens.</strong> It takes the tokens above (the guardian can add one only after a 24 hour public notice). A wrong token sent the way the app sends stakes (a transfer with a call) is sent back; a plain transfer without a call is not.</li>
      </ul>
      <p>About 1Click and NEAR Intents: <Ext href={NEAR_INTENTS_DOCS}>the NEAR Intents docs</Ext>. How the escrow and the judge keep the result honest: <DocLink to="/docs/verification">How a result is verified</DocLink>.</p>
    </DocsFrame>
  );
}

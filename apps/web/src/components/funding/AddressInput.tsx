// F5 (FUND4 SPEC §5.1 step 3, §5.3): "Your USDT (Tron) address". A paste field with a [Paste] button, checked as you type
// (shown after 300 ms) with the funding Worker's own per-chain rules (lib/cashOut.checkAddress over lib/funding/chainAddress):
// checksum, the user's own deposit addresses, contract / system addresses. Memo chains (XRP, Stellar, TON) ask "Is this an
// exchange address that needs a tag or memo?" and BLOCK "Yes": a cash out can't add a tag, so the money would be lost.
// Every chain gets the exchange note. The address is the one raw address shown in Cash out (SM2 §2.2).
// Not built: "Scan QR" (needs a camera barcode reader the browsers we support don't all have); pasting covers it.
import React, { useEffect, useState } from "react";
import type { TokenOption } from "../../../lib/funding/types";
import { COPY } from "../../../lib/funding/copy";
import { checkAddress, memoChain, type AddressVerdict } from "../../../lib/cashOut";
import { displaySymbol } from "../../../lib/fundSheet";
import { Notice } from "../../kit";
import { Button, TextField } from "../../ui";

export type MemoAnswer = "yes" | "no" | null;

/** Whether the address step may go on: a valid address, and on a memo chain an explicit "No, it's my own wallet". */
export const addressReady = (v: AddressVerdict, dest: Pick<TokenOption, "blockchain">, memo: MemoAnswer): boolean =>
  v.state === "ok" && (!memoChain(dest) || memo === "no");

export function AddressInput({ dest, account, ownDeposits, value, onChange, memo, onMemo }: {
  dest: TokenOption; account: string; ownDeposits: readonly string[];
  value: string; onChange: (v: string) => void; memo: MemoAnswer; onMemo: (m: MemoAnswer) => void;
}) {
  const verdict = checkAddress(dest, value, { account, ownDeposits });
  // The error waits 300 ms after the last keystroke, so typing isn't shouted at; a paste is checked at once.
  const [shown, setShown] = useState<AddressVerdict>(verdict);
  useEffect(() => { const t = setTimeout(() => setShown(verdict), 300); return () => clearTimeout(t); }, [value, dest.assetId]); // eslint-disable-line react-hooks/exhaustive-deps
  const canPaste = typeof navigator !== "undefined" && !!navigator.clipboard?.readText;
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); onChange(t); setShown(checkAddress(dest, t, { account, ownDeposits })); } catch { /* permission refused: the field still takes a paste */ }
  };
  const title = COPY.cashOut.addressTitle(displaySymbol(dest), dest.networkName);
  const err = shown.state === "bad" && verdict.state === "bad" ? verdict.message : null;
  return (
    <section className="co-address" data-testid="co-address">
      <div className="co-address__row">
        <div className="co-address__field">
          <TextField label={title} value={value} autoComplete="off" spellCheck={false} data-testid="co-address-input"
            data-invalid={err ? "1" : "0"} onChange={(e) => onChange(e.target.value)} />
        </div>
        {canPaste && <Button variant="secondary" data-testid="co-address-paste" onClick={() => void paste()}>{COPY.cashOut.paste}</Button>}
      </div>
      {err && <p className="co-error" role="alert" data-testid="co-address-error">{err}</p>}
      {memoChain(dest) && verdict.state === "ok" && (
        <div className="co-memo" data-testid="co-memo">
          <p id="co-memo-q">{COPY.cashOut.memoAsk}</p>
          <div className="fund-chips" role="radiogroup" aria-labelledby="co-memo-q">
            <button type="button" role="radio" aria-checked={memo === "yes"} className="fund-chip" data-testid="co-memo-yes" onClick={() => onMemo("yes")}>{COPY.cashOut.memoYes}</button>
            <button type="button" role="radio" aria-checked={memo === "no"} className="fund-chip" data-testid="co-memo-no" onClick={() => onMemo("no")}>{COPY.cashOut.memoNo}</button>
          </div>
          {memo === "yes" && <Notice tone="bad" title={COPY.cashOut.memoBlock} data-testid="co-memo-block" />}
        </div>
      )}
      <p className="k-small k-muted" data-testid="co-exchange-note">{COPY.cashOut.exchangeNote}</p>
    </section>
  );
}

// F4 (FUND4 SPEC §4.5, familiarcow UX-37 FUND 13): step 4, the ONE-TIME deposit address. QR + the full address (monospace, Copy), the
// memo when the chain needs one (its own QR + Copy + "you must include it"), the send band, the deadline with a live countdown,
// the amber "< 10 min" line, the network warning and the exchange hint. At the deadline the address, memo and QRs are REMOVED
// ("This address has expired. Don't send to it.") and only "Get a new address" is offered. Never a permanent address.
import React, { useState } from "react";
import type { SwapRecord } from "../../../lib/funding/types";
import { COPY } from "../../../lib/funding/copy";
import { addressView } from "../../../lib/fundSheet";
import { CopyButton, Notice } from "../../kit";
import { Button, TextField } from "../../ui";
import { QrCode } from "./QrCode";

export function AddressStep({ record, now, onNewAddress, onSent, onTxHash }: {
  record: SwapRecord; now: number; onNewAddress: () => void; onSent?: () => void; onTxHash?: (hash: string) => Promise<void>;
}) {
  const v = addressView(record, now);
  const [hash, setHash] = useState("");
  const [hashState, setHashState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  if (!v.usable) {
    return (
      <Notice tone="warn" title={<span data-testid="fund-address-expired">{v.expired}</span>} data-testid="fund-address-gone"
        action={<Button variant="primary" data-testid="fund-new-address" onClick={onNewAddress}>{COPY.add.newAddressCta}</Button>} />
    );
  }
  const sendHash = async () => {
    if (!onTxHash || !hash.trim()) return;
    setHashState("sending");
    try { await onTxHash(hash.trim()); setHashState("sent"); } catch { setHashState("error"); }
  };
  return (
    <section className="fund-address" data-testid="fund-address-step">
      <p className="fund-address__head"><strong data-testid="fund-address-title">{v.title}</strong> <span className="fund-badge" data-testid="fund-network-badge">{v.networkBadge}</span></p>
      <div className="fund-address__qr">
        <QrCode value={v.address!} label={`QR code for the ${v.title.replace(/^Send /, "")} deposit address`} data-testid="fund-qr" />
        <div className="fund-address__text">
          <code className="fund-mono" data-testid="fund-address">{v.address}</code>
          <CopyButton value={v.address!} label="Copy the deposit address" data-testid="fund-copy-address" />
        </div>
      </div>
      {v.memo && (
        <div className="fund-memo" data-testid="fund-memo-block">
          <p><strong data-testid="fund-memo-warning">{v.memoWarning}</strong></p>
          <div className="fund-address__qr">
            <QrCode value={v.memo} label="QR code for the memo" size={120} data-testid="fund-memo-qr" />
            <div className="fund-address__text">
              <span className="k-small k-muted">Memo</span>
              <code className="fund-mono" data-testid="fund-memo">{v.memo}</code>
              <CopyButton value={v.memo} label="Copy the memo" data-testid="fund-copy-memo" />
            </div>
          </div>
        </div>
      )}
      <p data-testid="fund-band">{v.band}</p>
      {v.deadline && <p data-testid="fund-deadline">{v.deadline}</p>}
      {v.soon && (
        <Notice tone="warn" title={<span data-testid="fund-soon">{COPY.add.soon}</span>}
          action={<Button data-testid="fund-new-address-soon" onClick={onNewAddress}>{COPY.add.newAddressCta}</Button>} />
      )}
      <p className="fund-warning" data-testid="fund-only-this"><strong>⚠ {v.onlyThis}</strong></p>
      {v.exchange && <p className="k-small k-muted" data-testid="fund-exchange">{v.exchange}</p>}
      {onSent && <Button variant="primary" data-testid="fund-sent" onClick={onSent}>{COPY.add.sentCta}</Button>}
      {onTxHash && (
        <div className="fund-hash">
          <TextField label={COPY.add.txHash} value={hash} onChange={(e) => setHash(e.target.value)} data-testid="fund-txhash" autoComplete="off" spellCheck={false} />
          <Button size="sm" disabled={!hash.trim() || hashState === "sending"} data-testid="fund-txhash-send" onClick={() => void sendHash()}>
            {hashState === "sent" ? "Thanks, we're on it" : "Send"}
          </Button>
          {hashState === "error" && <p className="k-small" role="alert" data-testid="fund-txhash-error">We couldn't pass that on. Check the ID and try again; your deposit is tracked either way.</p>}
        </div>
      )}
    </section>
  );
}

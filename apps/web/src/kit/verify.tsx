// V1 (familiarcow 2026-11-11: "Do we have any modals for the AI judge? ... We should be able to verify the results of every action"):
//   VerifyRow      one checkable item: label (+ a check status), the value with Copy, a person (@username, the raw id under it),
//                  a link, one line on how to check it, and the exact command with Copy.
//   VerifySheet    the AI judge's Verify sheet (ConfirmSheet style: the one modal shell, a bottom sheet on phones). Sections from
//                  lib/verify.ts judgeVerify; footer: Download verification file + Close; always links to About › How to verify.
//   ActionReceipt  the proof of one Activity entry: tx hash -> NearBlocks, when, who signed, who acted, the exact amounts moved.
// Raw account ids are allowed in these views (STATES.md V1-1: @username first, the id under it): every root carries
// data-raw-ids="allowed". Data only from lib/verify.ts; nothing here reads the chain or decides anything.
import React from "react";
import { Modal } from "../modal/Modal";
import { Button } from "../ui";
import { CopyButton, HashText, RawBlock, WhenText } from "./details";
import type { ActionReceiptData, PersonRef, VerifyItemData, VerifySheetData } from "../../lib/verify";
import "./kit.css";

type Data = { [k: `data-${string}`]: unknown };

const STATUS_WORD: Record<NonNullable<VerifyItemData["status"]>, string> = { ok: "Checked", bad: "Doesn't match", info: "Info", missing: "Not available" };
const STATUS_MARK: Record<NonNullable<VerifyItemData["status"]>, string> = { ok: "✓", bad: "✕", info: "i", missing: "–" };

/** "@maya" with the raw account id under it (Verify is one of the places raw ids may appear). */
export function PersonId({ who, ...rest }: { who: PersonRef } & Data) {
  return (
    <span {...(rest as object)} className="k-personid" data-kit="PersonId">
      <span className="k-person">{who.label}</span>
      <HashText value={who.account} keep={10} label={`Copy account id of ${who.label}`} />
    </span>
  );
}

export function VerifyRow({ item, ...rest }: { item: VerifyItemData } & Data) {
  const st = item.status;
  return (
    <div {...(rest as object)} className="k-vrow" data-kit="VerifyRow" data-item={item.id} data-status={st ?? "none"} data-testid={`verify-item-${item.id}`}>
      <div className="k-vrow__head">
        <p className="k-vrow__label">{item.label}</p>
        {st && <span className="k-vstatus" data-status={st} title={item.statusText ?? STATUS_WORD[st]}><span aria-hidden="true">{STATUS_MARK[st]}</span> {item.statusText ?? STATUS_WORD[st]}</span>}
      </div>
      {item.person && <PersonId who={item.person} />}
      {item.value != null && item.value !== "" && (
        item.valueKind === "block" ? <RawBlock title="Show the exact value" text={item.value} data-testid={`verify-value-${item.id}`} />
          : item.valueKind === "text" ? <span className="k-hashrow"><span className="k-vrow__text" data-testid={`verify-value-${item.id}`}>{item.value}</span><CopyButton value={item.value} label={`Copy ${item.label}`} /></span>
          : <HashText value={item.value} keep={10} label={`Copy ${item.label}`} data-testid={`verify-value-${item.id}`} />
      )}
      {item.value == null && !item.person && !st && <span className="k-muted k-small">Not available</span>}
      {item.link && <a className="k-vrow__link" href={item.link.href} target="_blank" rel="noopener noreferrer" data-testid={`verify-link-${item.id}`}>{item.link.text} <span aria-hidden="true">↗</span></a>}
      <p className="k-vrow__how"><span className="k-muted">How to check: </span>{item.how}</p>
      {item.command && (
        <span className="k-cmd" data-testid={`verify-cmd-${item.id}`}><code>{item.command}</code><CopyButton value={item.command} label="Copy command" /></span>
      )}
    </div>
  );
}

/** The body of a Verify sheet (also drawn inline in /kit). */
export function VerifyBody({ data, ...rest }: { data: VerifySheetData } & Data) {
  return (
    <div {...(rest as object)} className="k-verify" data-kit="VerifySheet" data-mode={data.mode} data-raw-ids="allowed" data-loading={data.loading ? "1" : "0"}>
      <p className="k-verify__intro">{data.intro}</p>
      {data.loading && <p className="k-muted k-small" data-testid="verify-loading">Loading what NEAR and the indexer say…</p>}
      {data.gaps.length > 0 && (
        <div className="k-notice" data-tone="warn" data-testid="verify-gaps"><ul className="k-list">{data.gaps.map((g) => <li key={g}>{g}</li>)}</ul></div>
      )}
      {data.sections.map((s, i) => (
        <section key={s.id} className="k-vsec" data-section={s.id} data-testid={`verify-section-${s.id}`}>
          <h3 className="k-vsec__title"><span className="k-vsec__n" aria-hidden="true">{i + 1}</span>{s.title}</h3>
          {s.lead && <p className="k-muted k-small">{s.lead}</p>}
          {s.items.map((it) => <VerifyRow key={it.id} item={it} />)}
        </section>
      ))}
      <section className="k-vsec k-vsec--how" data-testid="verify-how">
        <p className="k-small">Check it all at once, without this site: download the verification file and run the free checker.</p>
        <span className="k-cmd"><code>{data.scriptCommand} praetorial-bet-file.json</code><CopyButton value={data.scriptCommand} label="Copy checker command" /></span>
        <a href={data.aboutHref} data-testid="verify-about-link">How to verify a bet, step by step</a>
      </section>
    </div>
  );
}

export interface VerifySheetProps {
  open?: boolean;
  data: VerifySheetData;
  onClose: () => void;
  onDownload?: () => void;
  downloading?: boolean;
  inline?: boolean;
}
export function VerifySheet({ open = true, data, onClose, onDownload, downloading = false, inline = false }: VerifySheetProps) {
  const footer = (
    <div className="k-actions k-actions--stack k-sheet__footer" data-kit="VerifySheet-actions">
      {onDownload && <Button data-testid="verify-download" variant="primary" disabled={downloading} onClick={onDownload}>{downloading ? "Preparing the file…" : "Download verification file"}</Button>}
      <Button data-testid="verify-close" variant="secondary" onClick={onClose}>Close</Button>
    </div>
  );
  if (inline) {
    return (
      <section className="k-card k-sheet-preview k-verify-preview" aria-label={data.title}>
        <h3 style={{ margin: 0 }}>{data.title}</h3>
        <VerifyBody data={data} />
        {footer}
      </section>
    );
  }
  return (
    <Modal isOpen={open} title={data.title} onRequestClose={onClose} footer={footer} width={600} data-testid="verify-sheet">
      <VerifyBody data={data} />
    </Modal>
  );
}

// ---------------------------------------------------------------- ActionReceipt
export function ActionReceipt({ receipt, ...rest }: { receipt: ActionReceiptData } & Data) {
  return (
    <div {...(rest as object)} className="k-receipt" data-kit="ActionReceipt" data-state={receipt.state} data-raw-ids="allowed" data-testid={`receipt-${receipt.entryId}`}>
      {receipt.txs.map((t) => {
        const sameActor = t.actor.account === t.signer.account;
        return (
          <div key={t.hash} className="k-receipt__tx" data-ok={t.ok ? "1" : "0"} data-tx={t.hash}>
            <span className="k-row"><span className="k-muted k-small">Transaction</span><HashText value={t.hash} keep={8} label="Copy transaction hash" />
              <a className="k-vrow__link" href={t.href} target="_blank" rel="noopener noreferrer" data-testid="receipt-explorer">Open on NearBlocks <span aria-hidden="true">↗</span></a></span>
            {t.when && <WhenText when={t.when} />}
            <span className="k-receipt__grid">
              <span className="k-muted k-small">{sameActor ? "Signed by" : "Done by"}</span><PersonId who={t.actor} />
              {!sameActor && <><span className="k-muted k-small">Signed and paid gas</span><PersonId who={t.signer} /></>}
              <span className="k-muted k-small">Escrow method</span><code className="k-hash">{t.method}</code>
            </span>
            {t.moved.length > 0 ? (
              <ul className="k-receipt__moves">
                {t.moved.map((m, i) => (
                  <li key={i} data-dir={m.dir}><span className="k-num">{m.amount}</span> <span className="k-muted">{m.dir === "in" ? "into the escrow from" : "paid out to"}</span> <PersonId who={m.who} /></li>
                ))}
              </ul>
            ) : <span className="k-small k-muted">No money moved in this transaction.</span>}
            {!t.ok && <span className="k-small" data-testid="receipt-refused">The escrow refused this transaction.</span>}
          </div>
        );
      })}
      {receipt.note && <p className="k-small k-muted" data-testid="receipt-note">{receipt.note}</p>}
      {(receipt.state === "unavailable" || receipt.state === "missing") && <a className="k-vrow__link" href={receipt.escrowHref} target="_blank" rel="noopener noreferrer" data-testid="receipt-escrow">The escrow's transactions on NearBlocks <span aria-hidden="true">↗</span></a>}
    </div>
  );
}

/** "Verify" on one Activity row: closed by default, opens the receipt under the row. */
export function VerifyToggle({ receipt }: { receipt: ActionReceiptData }) {
  return (
    <details className="k-vtoggle" data-testid={`verify-${receipt.entryId}`}>
      <summary>Verify</summary>
      <ActionReceipt receipt={receipt} />
    </details>
  );
}

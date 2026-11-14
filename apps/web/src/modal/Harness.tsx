// MODAL1a: DEV-ONLY fixture page mounting every container. Loaded only through the import.meta.env.DEV dynamic import in main.tsx.
import React, { useRef, useState } from "react";
import { Modal } from "./Modal";
import { Drawer } from "./Drawer";
import { ConfirmDialog } from "./ConfirmDialog";
import { FlowModal, type FlowResult } from "./FlowModal";
import { Button } from "../ui";
import type { FlowStep } from "../../lib/flowModal";
import { Amount, AssetBadge, AccountChip, StatusPill, BetSummary, TermSheetView, SourceList, SourceCheckResult, TxLink, Countdown, FeeBreakdown, RefereeChip, EmptyState, ErrorNotice, ToastProvider, useToast } from "../objects";
import { PILL_STATUSES, statusPillFor } from "../../lib/uiObjects";
import { blankCustomTermSheet } from "../../lib/termSheet";

const ASSETS: Array<[string, bigint]> = [["USDC", 1_500_000n], ["USDT", 10_000_000n], ["BTC", 12_345_678n], ["ZEC", 100_000_000n], ["ETH", 1_000_000_000_000_000_001n], ["NEAR", 1_000_000_000_000_000_000_000_001n]];

function ToastDemo() {
  const toast = useToast();
  return <Button data-testid="open-toast" onClick={() => toast({ tone: "success", text: "Link copied." })}>Show a toast</Button>;
}

/** MODAL1b: every shared object once, with fixed inputs. */
function ObjectsSection() {
  const sheet = { ...blankCustomTermSheet(), claimText: "BTC closes above 100,000 on Coinbase", sources: [{ venue: "Coinbase", pair: "BTC-USD", timezone: "UTC" }, { venue: "Kraken", pair: "XBT/USD", timezone: "UTC" }], deadlineLabel: "2027-01-01 00:00 UTC" };
  return (
    <section data-testid="objects" aria-label="Shared UI objects" style={{ display: "flex", flexDirection: "column", gap: 10, alignSelf: "stretch" }}>
      <h2 style={{ fontSize: 18 }}>Shared UI objects (MODAL1b)</h2>
      <div data-testid="obj-amounts">{ASSETS.map(([sym, u]) => <div key={sym}><AssetBadge symbol={sym} network="mainnet" /> <Amount data-testid={`amount-${sym}`} symbol={sym} units={u} /></div>)}</div>
      <div><AssetBadge data-testid="badge-btc-testnet" symbol="BTC" network="testnet" /></div>
      <div data-testid="obj-pills">{PILL_STATUSES.map((s) => <span key={s} style={{ marginRight: 6 }}><StatusPill data-testid={`pill-${s}`} status={s} /></span>)}</div>
      <p data-testid="pill-sentence">{statusPillFor("Proposed", "judge-account").sentence}</p>
      <div><AccountChip account={"a".repeat(30) + "b".repeat(34)} username="alice" /> <RefereeChip referee={null} /> <RefereeChip referee={{ account: "judge-account" }} /></div>
      <BetSummary sentence="BTC above 100k" other="vs bob" mySide="Yes" stake={<Amount symbol="USDC" units={5_000_000n} cents />} status="Taken" />
      <TermSheetView sheet={sheet} />
      <SourceList sources={sheet.sources} />
      <SourceCheckResult state="failed" checkedAtNs={null} leftMs={null} failure={{ headline: "The AI can't read one of the sources.", lines: [{ source: "kraken.com", reason: "the page didn't load" }], retry: false }} plainMessage={null} />
      <p>Time left: <Countdown data-testid="countdown-fixed" msLeft={3 * 3_600_000 + 5 * 60_000} /> / <Countdown data-testid="countdown-done" msLeft={0} /></p>
      <FeeBreakdown data-testid="fee" symbol="USDC" stakeUnits={100_000_000n} feeBps={100} minFeePerSide={250_000n} tipUnits={1_000_000n} />
      <p>Transaction: <TxLink testId="objects-tx-link" hash="HARNESSHASH1" /></p>
      <EmptyState data-testid="empty" action={<a href="/new">Make a bet</a>}>You haven't made a bet yet.</EmptyState>
      <ErrorNotice data-testid="error-notice" onRetry={() => undefined}>We can't load your bets.</ErrorNotice>
      <ToastDemo />
    </section>
  );
}

const steps: FlowStep[] = [
  { id: "amount", title: "Amount", validate: (v) => (Number(v.amount) > 0 ? null : "Enter an amount above zero.") },
  { id: "review", title: "Review" },
];

export default function Harness() {
  const [modal, setModal] = useState(false);
  const [busyModal, setBusyModal] = useState(false);
  const [busy, setBusy] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [log, setLog] = useState({ cancelled: 0, confirmed: 0 });
  const [flow, setFlow] = useState(false);
  const [mode, setMode] = useState("success");
  const release = useRef<(() => void) | null>(null);

  (window as unknown as { __harnessRelease: () => void }).__harnessRelease = () => release.current?.();

  const onSubmit = (): Promise<FlowResult> => new Promise((res) => {
    release.current = () => res(
      mode === "fail" ? { kind: "failure", reason: "The network was busy. Nothing was spent." }
      : mode === "pending" ? { kind: "pending", txHash: "HARNESSHASH1" }
      : { kind: "success", txHash: "HARNESSHASH1" });
    if (mode === "success") release.current();
  });

  return (
    <ToastProvider>
    <main data-testid="harness" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
      <h1 style={{ fontSize: 22 }}>Modal primitives (dev harness)</h1>
      <Button data-testid="open-modal" onClick={() => setModal(true)}>Open modal</Button>
      <Button data-testid="open-busy-modal" onClick={() => { setBusy(true); setBusyModal(true); }}>Open busy modal</Button>
      <Button data-testid="open-drawer" onClick={() => setDrawer(true)}>Open drawer</Button>
      <Button data-testid="open-confirm" onClick={() => setConfirm(true)}>Open confirm</Button>
      <Button data-testid="open-flow" onClick={() => setFlow(true)}>Open flow</Button>
      <label>Flow outcome{" "}
        <select data-testid="harness-mode" value={mode} onChange={(e) => setMode(e.currentTarget.value)}>
          <option value="success">success</option><option value="fail">fail</option><option value="pending">pending</option>
        </select>
      </label>
      <p data-testid="confirm-log">cancelled:{log.cancelled} confirmed:{log.confirmed}</p>

      <Modal isOpen={modal} title="Example modal" onRequestClose={() => setModal(false)}
        footer={<Button variant="primary" onClick={() => setModal(false)}>Got it</Button>}>
        <p>Plain content. <a href="#harness" style={{ textDecoration: "underline" }}>A link</a> <input aria-label="Example field" /></p>
        <p style={{ minHeight: 300 }}>Long content scrolls inside the modal, not the page.</p>
      </Modal>
      <Modal isOpen={busyModal} title="Sending" busy={busy} onRequestClose={() => setBusyModal(false)}
        footer={<Button data-testid="busy-done" onClick={() => setBusy(false)}>Finish</Button>}>
        <p>A transaction is in flight.</p>
      </Modal>
      <Drawer isOpen={drawer} title="Example drawer" onRequestClose={() => setDrawer(false)}><p>Side panel content.</p><Button onClick={() => setDrawer(false)}>Done</Button></Drawer>
      <ConfirmDialog isOpen={confirm} title="Cancel this offer?" confirmLabel="Cancel offer" cancelLabel="Keep it" destructive
        onCancel={() => { setConfirm(false); setLog((l) => ({ ...l, cancelled: l.cancelled + 1 })); }}
        onConfirm={() => { setConfirm(false); setLog((l) => ({ ...l, confirmed: l.confirmed + 1 })); }}>
        Your stake is returned to your escrow balance.
      </ConfirmDialog>
      <FlowModal isOpen={flow} title="Example flow" steps={steps} draftKey="harness" submitLabel="Send" onClose={() => setFlow(false)} onSubmit={onSubmit}
        renderStep={(st, api) => st.id === "amount"
          ? <label>Amount <input data-testid="flow-input" value={api.values.amount ?? ""} onChange={(e) => api.set("amount", e.currentTarget.value)} /></label>
          : <p>Review: send {api.values.amount}.</p>} />
      <ObjectsSection />
    </main>
    </ToastProvider>
  );
}

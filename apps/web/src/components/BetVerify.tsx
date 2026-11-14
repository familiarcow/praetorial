// V1 (familiarcow 2026-11-11: "We should be able to verify the results of every action ... users should easily be able to get all of their
// information to verify"): the bet page's Verify wiring. One hook, so BetPage only places what it returns:
//   entries   the Activity rows with their on-chain receipts (lib/verify.ts withReceipts; tx list from the indexer, refreshed when
//             the bet changes and every 2 min, since the indexer picks new transactions up within ~5 min)
//   openSheet opens the AI judge's Verify sheet (ruling card, Details › AI judge); the escrow's keys are read when it opens
//   sheet     the VerifySheet element; cta  the "Check this bet yourself" card with Download verification file
// Read-only: indexer GET + RPC views. Nothing is signed or sent.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Bet } from "../../lib/escrowAdapter";
import type { BetDetail } from "../../lib/betDetail";
import type { ActivityEntry } from "../../lib/betView";
import { fetchBetTxs, fetchChainFacts, type BetTx, type ChainFacts } from "../../lib/betTxs";
import { judgeVerify, withReceipts, verificationFile, verificationFileName, verifyRefreshKey, ABOUT_VERIFY_HREF, type VerifyCtx } from "../../lib/verify";
import { ESCROW_CONTRACT_ID, INTENTS_CONTRACT_ID } from "../../lib/config";
import { NETWORK } from "../../lib/network";
import { releaseFeeAccount, releasePins } from "../../lib/releaseConfig";
import { VerifySheet } from "../kit/verify";
import { Button } from "../ui";

const release = (): { resolverWasmHash: string; models: string[] } | null => {
  try { const p = releasePins(); return { resolverWasmHash: p.resolver_wasm_hash, models: p.models }; } catch { return null; }
};

function saveJson(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function useBetVerify({ bet, betId, detail, activity, names, me }: {
  bet: Bet | null; betId: number; detail: BetDetail | null; activity: ActivityEntry[]; names: Record<string, string | null | undefined>; me: string | null;
}) {
  const [txs, setTxs] = useState<BetTx[] | null | undefined>(undefined);
  const [facts, setFacts] = useState<ChainFacts | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const key = verifyRefreshKey(bet);
  const ctx: VerifyCtx = useMemo(() => ({ network: NETWORK.networkId, contractId: ESCROW_CONTRACT_ID, names, me, feeAccount: releaseFeeAccount(), intents: INTENTS_CONTRACT_ID }), [names, me]);

  useEffect(() => {
    if (!key) return;
    let off = false;
    const load = () => fetchBetTxs(betId).then((t) => { if (!off) setTxs(t); });
    load();
    const iv = setInterval(load, 120_000);
    return () => { off = true; clearInterval(iv); };
  }, [betId, key]);

  const loadFacts = useCallback(async (): Promise<ChainFacts | null> => {
    try { const f = await fetchChainFacts(betId); setFacts(f); return f; } catch { setFacts(null); return null; }
  }, [betId]);
  const openSheet = useCallback(() => { setOpen(true); setFacts(undefined); void loadFacts(); }, [loadFacts]);

  const download = useCallback(async () => {
    setDownloading(true); setDownloadError(null);
    try {
      const [f, t] = await Promise.all([loadFacts(), fetchBetTxs(betId)]);
      if (t) setTxs(t);
      if (!f || !f.betText) { setDownloadError("We couldn't read the bet from NEAR just now. Try again in a minute."); return; }
      saveJson(verificationFileName(betId, NETWORK.networkId), verificationFile({
        network: NETWORK.networkId, escrow: ESCROW_CONTRACT_ID, betId, betText: f.betText, keys: [f.outcomeKey, f.attestKey, f.wasmHash],
        olc: { wasm_base_url: f.wasmBaseUrl }, codeHashB58: f.codeHashB58, txs: t ?? [],
        models: { used: detail?.judge.models ?? [], judge_chain: f.judgeChain }, generatedAt: new Date().toISOString(),
      }));
    } finally { setDownloading(false); }
  }, [betId, detail, loadFacts]);

  const entries = useMemo(() => withReceipts(activity, txs, ctx), [activity, txs, ctx]);
  const data = useMemo(() => (bet && detail ? judgeVerify({ bet, detail, txs, facts, release: release(), ctx }) : null), [bet, detail, txs, facts, ctx]);

  const sheet = open && data ? <VerifySheet data={data} onClose={() => setOpen(false)} onDownload={download} downloading={downloading} /> : null;
  const cta = (
    <section className="k-card k-verify-cta" data-testid="verify-cta">
      <p><strong>Check this bet yourself</strong></p>
      <p className="k-small k-muted">Download everything that decided it: the terms, every ruling with its signature, every transaction and the program's fingerprint. Check it without this site.</p>
      <span className="k-row">
        <Button data-testid="verify-download-cta" variant="secondary" disabled={downloading} onClick={download}>{downloading ? "Preparing the file…" : "Download verification file"}</Button>
        <a href={ABOUT_VERIFY_HREF} data-testid="verify-about-cta">How to verify a bet</a>
      </span>
      {downloadError && <p className="k-small" role="alert" data-testid="verify-download-error">{downloadError}</p>}
    </section>
  );
  return { entries, openSheet, sheet, cta, txs };
}

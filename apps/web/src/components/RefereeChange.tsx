// FE10b / D-FE10B1: change the referee from the live bet page (see lib/refereeChange.ts for the contract rules).
// Mounted for every party for the bet's whole life: the result line lives here, so it survives the bet refresh
// that follows a successful change (same bug class as FE10c).
// MODAL1c4: typing the account and the preflight stay on the page; every send (change, propose, agree, switch to the AI) is confirmed in a modal
// that says what happens first. The relay (method, args, deposit 0, REFGAS1 gas) and the get_bet read-back are unchanged.
import React, { useEffect, useRef, useState } from "react";
import { Button, TextField } from "../ui";
import { getBet, type Bet } from "../../lib/escrowAdapter";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { useRelayAction } from "../../lib/useRelayAction";
import { confirmTiming } from "../../lib/openConfirm";
import { DECLINED_MESSAGE } from "../../lib/openRefusal";
import { viewTxFailure } from "../../lib/rpc";
import { releaseFeeAccount } from "../../lib/releaseConfig";
import { person, personLabel } from "../../lib/betView";
import { nameAccountsIn, lookupName } from "../../lib/betNames";
import type { UserRegistry } from "../../lib/refereeRegistry";
import {
  refereeChangeMode, validateNewReferee, buildAmendRefereeArgs, amendArgsFromJson, confirmAmend, hasPreflightableSources, proposalToAgree, plainAmendRefusal,
  STILL_CONFIRMING,
} from "../../lib/refereeChange";
import { requestSourceCheck, SourceCheckFailedError, SOURCECHECK_TIMEOUT_MS, type OpenAttestation } from "../../lib/sourceCheckClient";
import { plainPreflightFailure, type PlainFailure } from "../../lib/sourcePreflight";
import SourcePreflight, { type PreflightState } from "./SourcePreflight";
import { approvalTimeLeftMs } from "../../lib/openApproval";
import { chainClock, monotonicNow } from "../../lib/chainClock";
import { ResolutionShell, type Run } from "./ResolutionModals";
import { refereeChangeTerms, adminFlowPhase, OFFER_ADMIN_STEPS, OFFER_ADMIN_DRAFT_KEY, type RefereeTerms } from "../../lib/offerAdminFlows";
import { e2eSourceCheckTimeoutMs } from "../../lib/testHooks";

export interface RefereeChangeWallet {
  nearAddress: string;
  signRawHash: (address: string, hashHex: string) => Promise<string>;
}

export default function RefereeChange({ bet, betId, me, wallet, onRefresh, names = {}, registry = null }: {
  bet: Bet; betId: number; me: string | null; wallet: RefereeChangeWallet | null; onRefresh: () => void;
  /** B1: @usernames of the people on the bet (lib/betNames.ts); raw ids are never shown here. */
  names?: Record<string, string | null | undefined>;
  /** B1: referees are picked by Praetorial username; the registry turns "@kim" into the account. */
  registry?: UserRegistry | null;
}) {
  // a referee picked by username keeps that username on screen before the registry lookup of the bet's people catches up
  const [typed, setTyped] = useState<Record<string, string>>({});
  const label = (account: string | null) => (account ? personLabel(person(account, me, { ...names, ...typed })) : "the AI");
  /** refereeChange's messages and confirm lines name accounts; on screen they are people. */
  const nameAll = (text: string, extra: (string | null | undefined)[] = []) =>
    nameAccountsIn(text, [bet.envelope.maker, bet.taker, bet.envelope.referee?.account, ...Object.keys(names), ...Object.keys(typed), ...extra].filter((a): a is string => !!a), (a) => label(a));
  const action = useRelayAction();
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{ kind: string; message: string } | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [pf, setPf] = useState<PreflightState>("idle");
  const [pfFail, setPfFail] = useState<PlainFailure | null>(null);
  const [att, setAtt] = useState<OpenAttestation | null>(null);
  // REVIEW1 (#10): the check's age comes from chain + monotonic time, never the device clock.
  const attAt = useRef(0);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (pf !== "ok" || !att) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [pf, att]);
  const attLeft = pf === "ok" && att ? approvalTimeLeftMs({ attestation: att, requestedAtMono: attAt.current }, { mono: monotonicNow(), chainMs: chainClock.nowMs() }) : null;
  useEffect(() => { if (pf === "ok" && attLeft === 0) { setAtt(null); setPf("expired"); } }, [pf, attLeft === 0]);

  const mode = refereeChangeMode(bet, me);
  const feeAccount = releaseFeeAccount();
  // B1: a username ("kim" / "@kim") is looked up when you press the button; a raw account id still works as before.
  const isUsername = !!input.trim() && /^@?[a-z0-9_]+$/i.test(input.trim()) && !/^[0-9a-f]{64}$/.test(input.trim());
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const problems = input.trim() && !isUsername ? validateNewReferee(input, bet, feeAccount) : lookupErr ? [lookupErr] : [];
  async function submitNew() {
    const raw = input.trim();
    if (!isUsername) {
      // a raw account id still works; show it as its @username when it has one (best effort, never blocks the change)
      if (registry) { setLooking(true); const n = await lookupName(registry, raw).finally(() => setLooking(false)); if (n) setTyped((t) => ({ ...t, [raw]: n })); }
      ask(buildAmendRefereeArgs(betId, raw), raw, false); return;
    }
    if (!registry?.lookupUsername) { setLookupErr("We can't look up usernames right now. Try again later."); return; }
    setLooking(true); setLookupErr(null);
    try {
      const u = await registry.lookupUsername(raw);
      if (!u) { setLookupErr(`No one is called @${raw.replace(/^@/, "")}.`); return; }
      setTyped((t) => ({ ...t, [u.account]: u.username }));
      const p = validateNewReferee(u.account, bet, feeAccount);
      if (p.length) { setLookupErr(p[0]); return; }
      ask(buildAmendRefereeArgs(betId, u.account), u.account, false);
    } catch { setLookupErr("We can't look up usernames right now. Try again later."); }
    finally { setLooking(false); }
  }
  const agree = proposalToAgree(bet, me);
  const canSwitch = hasPreflightableSources(bet);

  // MODAL1c4: what the open confirm modal will send; null = closed. `terms` is frozen when it opens.
  const [pend, setPend] = useState<null | { args: { bet_id: number; new_referee_json: string }; expected: string | null; terms: RefereeTerms; via: "maker-alone" | "propose" }>(null);
  function ask(args: { bet_id: number; new_referee_json: string }, expected: string | null, agreeing: boolean) {
    if (!wallet || !me || (mode !== "maker-alone" && mode !== "propose")) return;
    setPend({ args, expected, via: mode, terms: refereeChangeTerms({ bet, mode, account: expected, agreeing, me }) });
  }

  /** One amend_referee call, then read the bet back: only what get_bet shows is reported as done. */
  async function send(p: NonNullable<typeof pend>): Promise<Run> {
    try { const out = await sendOnce(p); return { ...out, message: nameAll(out.message, [p.expected]) }; } finally { onRefresh(); } // the page re-reads the bet as soon as the send settles, as before
  }
  async function sendOnce(p: NonNullable<typeof pend>): Promise<Run> {
    if (!wallet || !me) return { kind: "failed", message: "Sign in first. Nothing was sent." };
    let refusedSign = false;
    const r = await action.run({
      senderId: wallet.nearAddress,
      publicKeyHexEd25519: wallet.nearAddress,
      receiverId: ESCROW_CONTRACT_ID,
      methodName: "amend_referee",
      args: p.args,
      depositYocto: "0",
      signRawHash: async (a, h) => {
        try { return await wallet.signRawHash(a, h); } catch (e) { refusedSign = true; throw e; }
      },
    });
    if (refusedSign) return { kind: "declined", message: DECLINED_MESSAGE };
    if (!r.ok) return { kind: "failed", message: "The referee change didn't go through. Nothing changed." };
    const t = confirmTiming();
    const out = await confirmAmend({
      betId, expected: p.expected, via: p.via, me,
      deps: { getBet: (id) => getBet(id), sleep: (ms) => new Promise((x) => setTimeout(x, ms)) },
      attempts: t.attempts, delayMs: t.delayMs,
    });
    if (out.kind === "pending" && r.txHash) {
      const reason = await viewTxFailure(r.txHash, me);
      if (reason) return { kind: "refused", message: `${plainAmendRefusal(reason).message}. Nothing changed.`, txHash: r.txHash };
    }
    return { ...out, txHash: r.txHash ?? null };
  }

  async function runPreflight() {
    const terms = bet.envelope.terms;
    if (!terms) return;
    setPf("checking"); setPfFail(null); setAtt(null);
    void chainClock.ensure();
    attAt.current = monotonicNow();
    try {
      const a = await requestSourceCheck(bet.envelope.terms_hash, terms, undefined, e2eSourceCheckTimeoutMs() ?? SOURCECHECK_TIMEOUT_MS, null);
      setAtt(a);
      setPf("ok");
    } catch (err) {
      setPfFail(err instanceof SourceCheckFailedError ? plainPreflightFailure(err.kind, err.sources, err.rateLimit, err.workerReason) : plainPreflightFailure("service", []));
      setPf("failed");
    }
  }

  const working = !!pend || action.status === "signing" || action.status === "relaying" || action.status === "building";
    const waiting = mode === "maker-alone" || mode === "propose";

  return (
    <div data-testid="referee-change-wrap">
      {waiting && (
        <div data-testid="referee-change-section">
          <p className="k-action__text">Change who decides</p>
          <p data-testid="referee-change-explainer" className="k-action__hint">
            {mode === "maker-alone"
              ? "Nobody has taken this bet yet, so you can change the referee yourself. It takes effect right away. Pick them by their Praetorial username."
              : "Both of you have to propose the same referee, by their Praetorial username. Nothing changes until you both do."}
          </p>

          {agree && declined !== agree.json && (
            <div data-testid="referee-agree-section">
              <p>{`${label(bet.envelope.maker === me ? bet.taker : bet.envelope.maker)} proposed ${agree.account ? label(agree.account) : "letting the AI decide"}. Agree to make it so.`}</p>
              <Button data-testid="referee-agree-btn" disabled={!wallet || working} onClick={() => ask(amendArgsFromJson(betId, agree.json), agree.account, true)}>
                {agree.account ? `Agree: ${label(agree.account)} decides` : "Agree: the AI decides"}
              </Button>
              <Button data-testid="referee-decline-btn" disabled={working} onClick={() => { setDeclined(agree.json); setResult(null); }}>No thanks</Button>
            </div>
          )}
          {agree && declined === agree.json && (
            <p data-testid="referee-change-declined">
              You said no, so nothing was sent. The proposal stays on the bet until someone proposes something else; you can propose a different referee below.
            </p>
          )}

          <TextField
            label="New referee's username"
            data-testid="referee-change-input"
            placeholder="@username"
            value={input}
            onChange={(e) => { setInput(e.currentTarget.value); setResult(null); setLookupErr(null); }}
          />
          {problems.length > 0 && <div data-testid="referee-change-problem">{problems[0]}</div>}
          <Button
            data-testid="referee-change-submit"
            disabled={!wallet || working || looking || !input.trim() || problems.length > 0}
            onClick={submitNew}
          >
            {mode === "maker-alone" ? "Change the referee" : "Propose this referee"}
          </Button>

          {canSwitch && !switchOpen && (
            <Button data-testid="switch-to-ai" disabled={working} onClick={() => setSwitchOpen(true)}>Let the AI decide instead</Button>
          )}
          {canSwitch && switchOpen && (
            <div data-testid="switch-to-ai-panel">
              <p>The AI has to be able to read your sources before it can take over. We check that first.</p>
              <SourcePreflight
                state={pf} checkedAtNs={att ? String(att.checked_at) : null} failure={pfFail} plainMessage={null}
                onCheck={runPreflight}
                onFix={() => { setSwitchOpen(false); setPf("idle"); }}
                onUsePerson={() => { setSwitchOpen(false); setPf("idle"); }}
                leftMs={attLeft}
              />
              <Button
                data-testid="switch-to-ai-confirm"
                disabled={!wallet || working || pf !== "ok" || !att || attLeft === 0}
                onClick={() => ask(buildAmendRefereeArgs(betId, null), null, false)}
              >
                {mode === "maker-alone" ? "Switch to the AI" : "Propose the AI"}
              </Button>
              <Button data-testid="switch-to-ai-cancel" disabled={working} onClick={() => { setSwitchOpen(false); setPf("idle"); setAtt(null); }}>Keep the person</Button>
            </div>
          )}
        </div>
      )}
      {pend && (
        <ResolutionShell
          kind="referee-change" title={nameAll(pend.terms.title, [pend.expected])} draftId={betId} steps={OFFER_ADMIN_STEPS} draftKey={OFFER_ADMIN_DRAFT_KEY("referee-change", betId)} phaseOf={adminFlowPhase}
          termsTestId="referee-change-terms" confirmTestId="referee-change-confirm" cancelTestId="referee-change-cancel" resultTestId={() => "referee-change-result"}
          confirmLabel={nameAll(pend.terms.confirmLabel, [pend.expected])} disabled={!wallet}
          terms={<ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>{pend.terms.lines.map((l) => <li key={l}>{nameAll(l, [pend.expected])}</li>)}</ul>}
          run={() => send(pend)}
          onClose={(last) => {
            setPend(null);
            if (last) {
              setResult(last);
              if (last.kind === "changed" || last.kind === "proposed") { setInput(""); setSwitchOpen(false); setPf("idle"); setAtt(null); }
            }
          }}
        />
      )}
      {result && !pend && <div data-testid="referee-change-result" data-kind={result.kind}>{result.message}</div>}
    </div>
  );
}

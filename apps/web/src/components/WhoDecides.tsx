import React, { useRef, useState } from "react";
import { Button, Banner, TextField, CheckField } from "../ui";
import { DECIDER_CHOICES, pickReferee, checkRegistered, accountTail, resultRowLabel, searchHint, type RegisteredUser, type UserRegistry } from "../../lib/refereeRegistry";
import { RefereeChoice, refereeAccount, isUsableAccount, validateReferee, refereeTipLine, refereeCostLine, inviteText } from "../../lib/referee";
import { stakeAmountText } from "../../lib/createFlow"; // SM2 C1-3: the lib/money rule, not toFixed

// BET1c (UX-33 section 4): Who decides. Two big choice cards (AI = default); the long blurbs live in a "?" tip.
// Picking a person shows the registry search, results, invite text and tip option (same checks and banners as before).
// Referee state stays in CreateOffer (it feeds the offer, validate() and the draft); only the search box state is local.
type RefCtx = { maker: string | null; taker: string | null; feeAccount: string | null };

const card = (selected: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 10, margin: 0, padding: "14px 12px", minHeight: 56, cursor: "pointer", fontWeight: 600,
  border: `${selected ? 2 : 1}px solid ${selected ? "var(--color-accent)" : "var(--color-border)"}`,
  borderRadius: "var(--radius-container, 12px)",
  background: selected ? "var(--color-background-muted)" : "var(--color-background-card, #fff)",
});
const small: React.CSSProperties = { fontSize: "0.85em", color: "var(--color-text-secondary)" };

export default function WhoDecides({
  referee, setReferee, onAi, refereeUsername, setRefereeUsername, tipMaker, setTipMaker, refRegErr, setRefRegErr,
  refereeRegistry, refCtx, refereeErrors, tipHuman, makerAmount, symbol,
}: {
  referee: RefereeChoice;
  setReferee: (r: RefereeChoice | ((r: RefereeChoice) => RefereeChoice)) => void;
  /** Back to the AI: CreateOffer's resetReferee (clears the person, username, tip and registry error). */
  onAi: () => void;
  refereeUsername: string | undefined;
  setRefereeUsername: (u: string | undefined) => void;
  tipMaker: boolean;
  setTipMaker: (b: boolean) => void;
  refRegErr: string | null;
  setRefRegErr: (e: string | null) => void;
  refereeRegistry: UserRegistry;
  /** maker / named taker / fee account, for validateReferee. */
  refCtx: RefCtx;
  refereeErrors: string[];
  tipHuman: string;
  makerAmount: number;
  symbol: string;
}) {
  const human = referee.mode === "human";
  const [refSearch, setRefSearch] = useState("");
  const [refHits, setRefHits] = useState<RegisteredUser[]>([]);
  const [searched, setSearched] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);
  // C1: a pick resolves the person with registry calls; switching to the AI (or a newer pick) while they run makes it stale, so a late
  // answer can never flip the bet back to a person referee.
  const pickSeq = useRef(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const clearSearch = () => { setRefSearch(""); setRefHits([]); setSearched(null); setPickError(null); setSearchError(null); };
  const picked = refereeAccount(referee);

  return (
    <div data-testid="referee-picker">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ margin: "16px 0 8px" }}>Who decides?</h3>
        <button type="button" data-testid="decider-help" aria-expanded={helpOpen} aria-controls="decider-help-text" aria-label="What's the difference?" title="What's the difference?" onClick={() => setHelpOpen(!helpOpen)}
          style={{ margin: 0, width: 28, height: 28, padding: 0, cursor: "pointer", borderRadius: "50%", font: "inherit", fontWeight: 600, background: helpOpen ? "var(--color-background-muted)" : "none", border: "1px solid var(--color-border-emphasized, var(--color-border))", color: "var(--color-text-secondary)" }}>?</button>
      </div>
      {helpOpen && (
        <div id="decider-help-text" data-testid="decider-help-text" role="note" style={{ maxWidth: 560, margin: "0 0 10px", padding: "8px 12px", background: "var(--color-background-muted)", borderRadius: "var(--radius-element, 8px)", ...small }}>
          {DECIDER_CHOICES.map((c) => <p key={c.kind} style={{ margin: "4px 0", ...small }}><strong>{c.label}.</strong> {c.blurb}</p>)}
        </div>
      )}
      <div role="radiogroup" aria-label="Who decides?" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 560 }}>
        <label style={card(!human)}>
          <input type="radio" name="decider" data-testid="decider-ai" checked={!human} onChange={() => { pickSeq.current++; clearSearch(); onAi(); }} />
          {DECIDER_CHOICES[0].label}
        </label>
        <label style={card(human)}>
          <input type="radio" name="decider" data-testid="decider-person" checked={human} onChange={() => setReferee((r) => ({ mode: "human", referee: r.referee }))} />
          {DECIDER_CHOICES[1].label}
        </label>
      </div>
      {human && (<>
      {picked === null && (<>
        <TextField
            label="Find a person by username"
            data-testid="referee-search"
            placeholder="Find a person by username"
            value={refSearch}
            onChange={async (e) => {
              const q = e.target.value;
              setRefSearch(q);
              setPickError(null);
              setSearchError(null);
              const seq = ++searchSeq.current;
              if (!q.trim()) { setRefHits([]); setSearched(null); return; }
              try {
                const hits = await (refereeRegistry.searchStrict ?? refereeRegistry.search).call(refereeRegistry, q);
                if (seq !== searchSeq.current) return;
                setRefHits(hits);
                setSearched(q);
              } catch {
                if (seq !== searchSeq.current) return;
                setRefHits([]);
                setSearched(null);
                setSearchError("We can't search right now. Try again, or pick the AI.");
              }
            }}
          />
        {!refSearch.trim() && <p data-testid="referee-search-hint" style={small}>{searchHint("")}</p>}
        {refHits.length > 0 && (
          <ul data-testid="referee-results">
            {refHits.map((u, i) => (
              <li key={u.account + u.username}>
                <Button
                  type="button"
                  data-testid={`referee-result-${i}`}
                  onClick={async () => {
                    const seq = ++pickSeq.current;
                    const first = pickReferee(u);
                    const errs = validateReferee(first.choice, refCtx);
                    if (errs.length) { setPickError(errs[0]); return; }
                    // FE4b (D-FE4b): the search only exposes an account tail for implicit ids; resolve the FULL account id by exact username.
                    let full: RegisteredUser | null = null;
                    try { full = refereeRegistry.lookupUsername ? await refereeRegistry.lookupUsername(u.username) : (isUsableAccount(u.account) ? u : null); } catch { full = null; }
                    if (seq !== pickSeq.current) return;
                    if (!full || !isUsableAccount(full.account)) { setPickError("We couldn't look that person up. Try again, pick someone else, or pick the AI."); return; }
                    const finalPick = pickReferee(full);
                    const errs2 = validateReferee(finalPick.choice, refCtx);
                    if (errs2.length) { setPickError(errs2[0]); return; }
                    setPickError(null);
                    const regErr = await checkRegistered(refereeRegistry, finalPick.choice);
                    if (seq !== pickSeq.current) return;
                    setRefRegErr(regErr);
                    setReferee(finalPick.choice);
                    setRefereeUsername(finalPick.username);
                    setRefSearch("");
                    setRefHits([]);
                    setSearched(null);
                  }}
                >
                  {resultRowLabel(u)} -- Select
                </Button>
              </li>
            ))}
          </ul>
        )}
        {searchError && <Banner status="error" data-testid="referee-search-error">{searchError}</Banner>}
        {!searchError && refSearch.trim() && searched === refSearch && refHits.length === 0 && (<>
          <p data-testid="referee-no-results">{searchHint(refSearch)}</p>
          <p data-testid="referee-invite-text">
            Not on Praetorial yet? Send them an invite link. Once they've joined, you can pick them.{" "}
            <span>{inviteText(typeof window !== "undefined" ? window.location.origin : "")} -- ask them to join Praetorial.</span>{" "}
            <Button type="button" data-testid="referee-invite-copy" onClick={() => { try { void navigator.clipboard?.writeText(inviteText(window.location.origin)); } catch { /* clipboard not available */ } }}>Copy invite link</Button>
          </p>
        </>)}
        <p data-testid="referee-block-hint" style={small}>Pick someone, or switch back to the AI.</p>
      </>)}
      {pickError && <Banner status="error" data-testid="referee-pick-error">{pickError}</Banner>}
      {picked !== null && (
        <div data-testid="referee-selected">
          {refereeUsername ? `@${refereeUsername}${accountTail(picked) !== picked ? ` (${accountTail(picked)})` : ""}` : accountTail(picked)} {"—"} referee{" "}
          <Button type="button" data-testid="referee-change" onClick={() => { setReferee({ mode: "human" }); setRefereeUsername(undefined); setRefRegErr(null); setTipMaker(false); setPickError(null); }}>Change</Button>{" "}
          <Button type="button" data-testid="referee-clear" onClick={() => { setReferee({ mode: "human" }); setRefereeUsername(undefined); clearSearch(); setRefRegErr(null); setTipMaker(false); }}>Clear</Button>
        </div>
      )}
      <p data-testid="referee-agree-text" style={small}>
        {refereeUsername ? `@${refereeUsername}` : "The person you pick"} doesn't have to accept. You and the other person both agree to them: you by naming them now, the other person by taking the bet.
      </p>
      {picked !== null && (<>
        <CheckField data-testid="tip-maker-checkbox" label="Tip the referee" checked={tipMaker} onChange={(e) => setTipMaker(e.currentTarget.checked)} />
        <p data-testid="referee-tip-line" style={small}>{refereeTipLine(tipHuman, symbol)}</p>
        <p data-testid="referee-cost-line">{refereeCostLine({ tipOn: tipMaker, stake: stakeAmountText(symbol, makerAmount), tip: tipHuman, symbol })}</p>
      </>)}
      </>)}
      {refRegErr && <Banner status="error" data-testid="referee-registered-error">{refRegErr}</Banner>}
      {refereeErrors.length > 0 && (
        <Banner status="error" data-testid="referee-errors">
          {refereeErrors.map((e, i) => (
            <div key={i} data-testid={`referee-error-${i}`}>{e}</div>
          ))}
        </Banner>
      )}
    </div>
  );
}

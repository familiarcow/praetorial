import React, { useState } from "react";
import { Button, Banner, TextField } from "../ui";
import { plainProblem } from "../../lib/plainErrors";
import { pastFillKeys, DUPLICATE_MESSAGES } from "../../lib/duplicateBet";
import { betSentence, fillProblems, guidedFieldsFor, typedSheetFor, localTimeLabel, BET_TYPE_CARDS, type FillState } from "../../lib/betTypePicker";
import { AssetPicker, CityPicker } from "./PricePickers";
import { outperformVenuesText } from "../../lib/outperformSheet";
import { deciderLine } from "../../lib/assetPriceSheet";
import BetDetails from "./BetDetails";
import GamePicker from "./GamePicker";

const PAST_STYLE = { outline: "2px solid #d97706", background: "#fffbeb" } as const;

// S3: fill in the bet. The 4 typed bets use GUIDED_FIELDS; "any page" uses the custom builder. Next is blocked while the existing lint
// reports anything, and the lint's own message is shown right here. BET1a: "any page" Details is BetDetails (claim + deadline +
// 2 links, the rest under More options); whether a person decides is asked once, on the Who-decides step (fill.human mirrors it).
export default function FillStep({ fill, onChange, onBack, onNext, copied = false }: {
  /** FE15: the form was copied from an old bet: dates now in the past are highlighted. */
  copied?: boolean;
  fill: FillState;
  onChange: (f: FillState) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  // FE3b Q2: problems are shown only after a field loses focus or Next is tried; the lint itself and the Next block are unchanged.
  const [shown, setShown] = useState(false);
  const blur = () => setShown(true);
  const problems = fillProblems(fill, Date.now());
  const past = copied ? pastFillKeys(fill, Date.now()) : [];
  const card = BET_TYPE_CARDS.find((c) => c.id === fill.typeId)!;
  const sentence = betSentence(fill);
  const setGuided = (k: string, v: string) => { onChange({ ...fill, guided: { ...fill.guided, [k]: v } }); };
  const [focusTick, setFocusTick] = useState(0);
  const local = (v: string) => { const l = localTimeLabel(v); return l ? l : null; };

  return (
    // TPL2: browsing games is not "leaving a field": only the hand-entry fields under Details show problems on blur (Next always does).
    <div data-testid="fill-step" onBlur={(e) => { if (fill.typeId === "game_winner" && !(e.target as HTMLElement).closest?.('[data-testid="game-details"]')) return; blur(); }}>
      <h3>{card.title}</h3>
      {past.length > 0 && <Banner status="warning" role="alert" data-testid="past-dates-note">{DUPLICATE_MESSAGES.pastDates}</Banner>}
      {fill.typeId === "game_winner" && <GamePicker guided={fill.guided} onChange={(g) => onChange({ ...fill, guided: g })} />}
      {fill.typeId !== "custom" && fill.typeId !== "game_winner" && (
        <div data-testid="guided-fields">
          {(fill.typeId === "btc_close_at_t" || fill.typeId === "btc_touch") && (
            <AssetPicker asset={fill.asset} onPick={(a) => onChange({ ...fill, asset: a })} />
          )}
          {fill.typeId === "outperform" && (
            <div data-testid="outperform-coins">
              <AssetPicker tid="asset-a" label="This coin does better" asset={fill.asset} perCoinLines={false} onPick={(a) => onChange({ ...fill, asset: a })} />
              <AssetPicker tid="asset-b" label="than this coin" asset={fill.assetB} perCoinLines={false} onPick={(a) => onChange({ ...fill, assetB: a })} />
              {fill.asset && fill.assetB && <small data-testid="outperform-venues" style={{ display: "block" }}>{outperformVenuesText(fill.asset, fill.assetB)}</small>}
              <small data-testid="outperform-decider" style={{ display: "block" }}>{outperformDecider(fill)}</small>
            </div>
          )}
          {guidedFieldsFor(fill).map((g) => g.key === "station" ? (
            <CityPicker key={g.key} value={fill.guided.station ?? ""} onChange={(v) => setGuided("station", v)} />
          ) : (
            <label key={g.key} style={{ display: "block", margin: "6px 0" }}>
              {g.label}{" "}
              {g.kind === "select" ? (
                <select data-testid={`guided-${g.key}`} value={fill.guided[g.key] ?? ""} onChange={(e) => setGuided(g.key, e.target.value)}>
                  <option value="">choose...</option>
                  {g.options!.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                </select>
              ) : (
                <TextField
                  label={g.label}
                  hideLabel
                  data-testid={`guided-${g.key}`}
                  data-past={past.includes(g.key) ? "true" : undefined}
                  style={past.includes(g.key) ? PAST_STYLE : undefined}
                  type={g.kind === "datetime" ? "datetime-local" : g.kind === "date" ? "date" : "text"}
                  inputMode={g.kind === "number" ? "numeric" : undefined}
                  placeholder={g.placeholder}
                  value={fill.guided[g.key] ?? ""}
                  onChange={(e) => setGuided(g.key, e.target.value)}
                />
              )}
              {g.kind === "datetime" && local(fill.guided[g.key] ?? "") && <small data-testid={`guided-${g.key}-local`} style={{ display: "block" }}>{local(fill.guided[g.key] ?? "")}</small>}
              {g.help && <small style={{ display: "block" }}>{g.help}</small>}
            </label>
          ))}
        </div>
      )}

      {fill.typeId === "custom" && (
        <BetDetails form={fill.custom} human={fill.human} problems={problems} showProblems={shown} past={past} focusTick={focusTick} onChange={(c) => onChange({ ...fill, custom: c })}
          onAiFill={(c) => { onChange({ ...fill, custom: c }); setShown(true); }} />
      )}

      {sentence && <p data-testid="fill-sentence">{sentence}</p>}
      {shown && problems.length > 0 && (
        <Banner status="error" data-testid="fill-error">
          {problems.map((m, i) => { const pp = plainProblem(m); return (
            <div key={i} data-testid={`fill-error-${i}`}>
              {pp.text}
              <details data-testid={`fill-error-details-${i}`} style={{ fontSize: "0.8em" }}><summary>Details</summary>{pp.raw}</details>
            </div>
          ); })}
        </Banner>
      )}
      <div>
        <Button type="button" data-testid="fill-back" onClick={onBack}>Back</Button>{" "}
        <Button type="button" data-testid="fill-next" aria-disabled={problems.length > 0} onClick={() => { if (problems.length > 0) { setShown(true); setFocusTick((t) => t + 1); return; } onNext(); }}>Next</Button>
      </div>
    </div>
  );
}

// "Decided by the AI judge reading ..." for the pair as soon as both coins are chosen (the same words the review card gives the sheet).
function outperformDecider(fill: FillState): string {
  try { return deciderLine(typedSheetFor(fill, Date.now())) ?? "Decided by the AI judge"; } catch { return "Decided by the AI judge"; }
}

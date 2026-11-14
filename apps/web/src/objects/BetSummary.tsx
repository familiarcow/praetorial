import React from "react";
import { StatusPill } from "./StatusPill";

/** One bet as a row: the claim sentence, the other side, my side and stake, status, next date, result. Keeps the mybet-* test ids. */
export function BetSummary({ sentence, other, mySide, stake, status, referee, chip, next, result, actions }: {
  sentence: string; other: string; mySide?: string | null; stake?: React.ReactNode; status: string; referee?: string | null; chip?: { id: string; label: string }; next?: string | null; result?: string | null; actions?: React.ReactNode;
}) {
  return (
    <>
      <span data-testid="mybet-sentence">{sentence}</span>{" "}
      <span data-testid="mybet-other">{other}</span>{" "}
      {mySide && <span data-testid="mybet-side">{mySide}</span>}{" "}
      {stake != null && <span data-testid="mybet-stake">{stake}</span>}{" "}
      <StatusPill data-testid="mybet-chip" status={status} referee={referee} chip={chip} />
      {next && <> <span data-testid="mybet-next">{next}</span></>}
      {result && <> <span data-testid="mybet-result">{result}</span></>}{" "}
      {actions}
    </>
  );
}

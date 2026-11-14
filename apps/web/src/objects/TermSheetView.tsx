import React from "react";
import type { TermSheet } from "../../lib/termSheet";
import { SourceList } from "./SourceList";

/** Read-only view of a structured term sheet: claim, sources, deadline, what happens if sources fail. */
export function TermSheetView({ sheet, ...rest }: { sheet: TermSheet; [k: `data-${string}`]: unknown }) {
  return (
    <section {...(rest as object)}>
      <p data-testid="termsheet-claim">{sheet.claimText}</p>
      <h4>Sources</h4>
      <SourceList sources={sheet.sources} />
      {sheet.deadlineLabel && <p data-testid="termsheet-deadline">Deadline: {sheet.deadlineLabel}</p>}
      <p data-testid="termsheet-void">{sheet.voidPolicy}</p>
    </section>
  );
}

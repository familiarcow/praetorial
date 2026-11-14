import React from "react";
import { refereeChipFor } from "../../lib/uiObjects";
import { AccountChip } from "./AccountChip";

export function RefereeChip({ referee, ...rest }: { referee: { account: string } | null | undefined; [k: `data-${string}`]: unknown }) {
  const c = refereeChipFor(referee);
  return <span {...(rest as object)} data-referee={c.kind}>{c.kind === "ai" ? c.label : <>Referee: <AccountChip account={c.label} /></>}</span>;
}

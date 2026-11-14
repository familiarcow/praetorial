import React from "react";
import { shortAccount } from "../../lib/uiObjects";

/** An account (optionally with its @username). Long implicit ids are shortened; the full id is the tooltip. */
export function AccountChip({ account, username, ...rest }: { account: string; username?: string; [k: `data-${string}`]: unknown }) {
  return <span {...(rest as object)} title={account} style={{ fontFamily: "monospace" }}>{username ? `@${username} ` : ""}{shortAccount(account)}</span>;
}

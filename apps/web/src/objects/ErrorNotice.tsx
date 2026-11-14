import React from "react";
import { Button } from "../ui";

/** Inline plain-words error (role=alert) with an optional Retry. */
export function ErrorNotice({ children, onRetry, retryTestId, ...rest }: { children: React.ReactNode; onRetry?: () => void; retryTestId?: string; [k: `data-${string}`]: unknown }) {
  return <p {...(rest as object)} role="alert">{children}{onRetry ? <> <Button data-testid={retryTestId ?? "error-retry"} onClick={onRetry}>Retry</Button></> : null}</p>;
}

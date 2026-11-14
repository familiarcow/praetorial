import React from "react";
import { Notice } from "../kit/blocks";
import { Button } from "../ui";
import { pageNotice } from "../../lib/pageNotice";

// The app-state notice (S18 + A1, UIR1 §3.10): ONE kit Notice (page variant) at a time, picked by lib/pageNotice
// (shutdown > out-of-date > offline > paused > busy > connection). The paused line is inside it; nothing repeats it under the nav.
// `id="page-notice"` lets a control the notice disables (the nav's Create bet) point at it with aria-describedby.
export const PAGE_NOTICE_ID = "page-notice";
export default function StatusBanner({ paused, shutdown, offline = false, busySeconds = 0, outOfDate = false, viewFailed = false }: { paused: boolean; shutdown: boolean; offline?: boolean; busySeconds?: number; outOfDate?: boolean; viewFailed?: boolean }) {
  const n = pageNotice({ paused, shutdown, offline, busySeconds, outOfDate, viewFailed });
  if (!n) return null;
  return (
    <Notice variant="page" tone={n.tone} title={n.text} data-testid={`banner-${n.kind}`} data-page-notice={n.kind} {...({ id: PAGE_NOTICE_ID } as object)}
      action={n.fix === "reload" ? <Button data-testid="page-notice-reload" onClick={() => window.location.reload()}>Refresh</Button> : undefined} />
  );
}

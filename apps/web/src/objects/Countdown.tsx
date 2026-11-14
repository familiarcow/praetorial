import React, { useEffect, useState } from "react";
import { countdownText } from "../../lib/uiObjects";
import { formatTimeLeft } from "../../lib/sourcePreflight";

/** Time left. Pass `targetMs` (ticks every second) or a fixed `msLeft` from the caller's own clock. `clock` forces M:SS. */
export function Countdown({ targetMs, msLeft, clock, suffix, ...rest }: { targetMs?: number; msLeft?: number; clock?: boolean; suffix?: string; [k: `data-${string}`]: unknown }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (targetMs === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [targetMs]);
  const left = msLeft ?? (targetMs ?? 0) - now;
  const c = countdownText(now + left, now);
  return <span {...(rest as object)} data-expired={c.expired ? "1" : "0"}>{clock ? formatTimeLeft(left) : c.text}{suffix ?? ""}</span>;
}

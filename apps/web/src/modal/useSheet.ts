import { useEffect, useState } from "react";

/** Mobile bottom-sheet breakpoint (MODAL1a): <= 480px CSS px. */
export const SHEET_MAX_WIDTH = 480;
const QUERY = `(max-width: ${SHEET_MAX_WIDTH}px)`;

export function useIsSheet(): boolean {
  const [sheet, setSheet] = useState(() => typeof window !== "undefined" && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setSheet(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return sheet;
}

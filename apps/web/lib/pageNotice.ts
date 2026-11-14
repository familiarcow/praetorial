// A1 (UIR1 §3.10): the app-state notice at the top of every page (and inside the login card). ONE at a time, by priority:
// shutdown > out-of-date > offline > paused > busy > connection. The paused line lives inside it (no second "create disabled" note).
// Wording: lib/globalStates COPY / globalBanners (unchanged); this only picks the one to show and its tone. Pure (tsx --test).
import { globalBanners, type GlobalBanner } from "./globalStates";

export const PAGE_NOTICE_ORDER: GlobalBanner["kind"][] = ["shutdown", "out-of-date", "offline", "paused", "busy", "connection"];
export type PageNoticeTone = "bad" | "warn" | "info";
export interface PageNotice { kind: GlobalBanner["kind"]; text: string; tone: PageNoticeTone; fix: "reload" | null }

const TONE: Record<GlobalBanner["kind"], PageNoticeTone> = {
  shutdown: "bad", "out-of-date": "warn", offline: "warn", paused: "warn", busy: "info", connection: "info",
};

export function pageNotice(s: { paused: boolean; shutdown: boolean; offline: boolean; busySeconds?: number; outOfDate?: boolean; viewFailed?: boolean }): PageNotice | null {
  const all = globalBanners(s);
  for (const kind of PAGE_NOTICE_ORDER) {
    const b = all.find((x) => x.kind === kind);
    if (b) return { kind, text: b.text, tone: TONE[kind], fix: kind === "out-of-date" ? "reload" : null };
  }
  return null;
}

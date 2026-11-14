// TFIX2: the app's top-level error boundary (main.tsx wraps EVERYTHING in it, Privy and the theme included). Any render error shows
// "Something went wrong. Reload" with a Reload button and, on a bet page, the bet's link, and is logged to the console -- never the
// white page familiarcow got right after taking mainnet bet #1 (2026-11-13). It sits outside <Theme>, so it uses plain elements styled by
// styles.css (.crash-screen, token vars with fallbacks) and no kit component that could itself depend on what just failed.
import React from "react";
import { CRASH_COPY, crashBetLink, crashLogLine } from "../lib/crashScreen";

interface State { error: unknown | null }

export class CrashBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error(crashLogLine(error, info.componentStack), error);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    const bet = typeof window !== "undefined" ? crashBetLink(window.location.pathname, window.location.search) : null;
    return (
      <main className="crash-screen" data-testid="crash-screen" role="alert">
        <h1>{CRASH_COPY.title}</h1>
        <p>{CRASH_COPY.body}</p>
        <p className="crash-screen__actions">
          <button type="button" data-testid="crash-reload" onClick={() => window.location.reload()}>{CRASH_COPY.reload}</button>
          {bet && <a data-testid="crash-bet-link" href={bet.href}>{bet.label}</a>}
        </p>
      </main>
    );
  }
}

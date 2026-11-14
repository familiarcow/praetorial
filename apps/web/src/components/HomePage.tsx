// NAV1 (UX-31 Home): familiarcow: "[Home] - My Bets section - Explore Bets section to see all bets that others have posted that are not
// accepted yet - In progress bets to see bets that are currently accepted". Three clearly titled sections, in that order.
// H1 (familiarcow UX-37 #2/#3/#4): My Bets has "Needs you" first and Settled collapsed; In progress is other people's bets only; no
// Duplicate on Home cards (it lives in the bet page's More actions).
// SET1 (PM 2026-11-14): a 4th public section, Settled (everyone's finished bets, mine too), after In progress; guests see it as well.
import React from "react";
import MyBets from "./MyBets";
import BrowsePage from "./BrowsePage";
import InProgressBets from "./InProgressBets";
import SettledBets from "./SettledBets";

// GUEST1: a guest sees the public lists only (open + recent bets); no My Bets, nothing that needs an account.
export default function HomePage({ me, navigate, onCreate, createDisabled, guest = false }: {
  me: string | null; navigate: (to: string) => void; onCreate: () => void; createDisabled: boolean; guest?: boolean;
}) {
  return (
    <div data-testid="home" className="home">
      {guest ? null : me ? <MyBets me={me} navigate={navigate} onCreate={onCreate} createDisabled={createDisabled} /> : (
        <section data-testid="my-bets" aria-labelledby="my-bets-title">
          <h2 id="my-bets-title">My Bets</h2>
          <p data-testid="mybets-wallet-pending">Your account is being set up. Your bets will show here in a moment.</p>
        </section>
      )}
      <BrowsePage myAccountId={me} navigate={navigate} />
      <InProgressBets me={me} navigate={navigate} guest={guest} />
      <SettledBets me={me} navigate={navigate} />
    </div>
  );
}

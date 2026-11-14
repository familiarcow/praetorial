// DOCS1: the Docs section (replaced About). One URL per page (lib/docs.ts DOCS_PAGES); public, so it renders logged out too:
// logged out it gets a slim header (brand + Log in) instead of the app nav. Pages are static apart from the judge-models row.
import React, { useEffect } from "react";
import type { DocsPageId } from "../../../lib/docs";
import { DOCS_PAGES } from "../../../lib/docs";
import { Brand } from "../BrandMark";
import { DocsNav } from "./parts";
import WhatPage from "./WhatPage";
import VerificationPage from "./VerificationPage";
import IntentsPage from "./IntentsPage";
import TrustPage from "./TrustPage";
import HackathonPage from "./HackathonPage";

const PAGES: Record<DocsPageId, () => React.ReactElement> = {
  what: WhatPage, verification: VerificationPage, intents: IntentsPage, trust: TrustPage, hackathon: HackathonPage,
};

export default function DocsPage({ page, navigate, loggedOut }: { page: DocsPageId; navigate: (to: string) => void; loggedOut: boolean }) {
  const Page = PAGES[page];
  useEffect(() => {
    const title = DOCS_PAGES.find((p) => p.id === page)!.title;
    document.title = `${title} · Praetorial docs`;
    return () => { document.title = "Praetorial"; };
  }, [page]);
  return (
    <DocsNav.Provider value={navigate}>
      {loggedOut && (
        <header className="docs-public-head" data-testid="docs-public-head">
          <a href="/" className="brand" data-testid="docs-home" aria-label="Praetorial, home"><Brand /></a>
          <a href="/" className="docs-login" data-testid="docs-login">Log in</a>
        </header>
      )}
      <Page />
    </DocsNav.Provider>
  );
}

// DOCS1: small shared pieces of the Docs pages: a command block (copyable, tagged with its CLAIMS.md id), a status tag, an in-app
// link that keeps the single-page router (and scrolls to a #section), and the page frame with the Docs sub-nav.
import React, { createContext, useContext } from "react";
import { CopyButton } from "../../kit/details";
import { DOCS_PAGES, docsPath, type DocsPageId } from "../../../lib/docs";
import { docsCommand } from "../../../lib/docsFacts";

/** The app's navigate(to) (src/router.tsx), so in-docs links don't reload the page. */
export const DocsNav = createContext<(to: string) => void>((to) => { window.location.assign(to); });

/** An in-app link: a real <a href> (works without JS, middle-click opens a tab), routed in place on a plain click. */
type AnchorRest = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> & { [k: `data-${string}`]: string | undefined };
export function DocLink({ to, children, ...rest }: { to: string; children: React.ReactNode } & AnchorRest) {
  const navigate = useContext(DocsNav);
  return (
    <a href={to} {...rest} onClick={(e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
      const hash = new URL(to, window.location.origin).hash.slice(1);
      requestAnimationFrame(() => {
        const el = hash ? document.getElementById(hash) : null;
        if (el instanceof HTMLDetailsElement) el.open = true;
        if (el) el.scrollIntoView?.({ block: "start" }); else window.scrollTo?.(0, 0);
      });
    }}>{children}</a>
  );
}

/** An external, public page (EXTERNAL_ORIGINS in lib/docs.ts). */
export function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/** A command block. `id` is the DOCS_COMMANDS id; the same id is in spikes/docs1/CLAIMS.md with where it was checked. */
export function Cmd({ id }: { id: string }) {
  const c = docsCommand(id);
  return (
    <figure className="docs-cmd" data-testid={`cmd-${id}`} data-cmd={id}>
      <pre><code>{c.text}</code></pre>
      <CopyButton value={c.text} label="Copy command" />
    </figure>
  );
}

export type Status = "mainnet" | "testnet" | "both" | "planned" | "not-yet" | "manual" | "none" | "pending";
const STATUS_TEXT: Record<Status, string> = {
  mainnet: "Mainnet", testnet: "Testnet only", both: "Mainnet and testnet", planned: "Planned", "not-yet": "Not possible yet", manual: "By hand", none: "Not on this network",
  // DOCS2: a per-bet check that works on any mainnet bet. DOCS5: mainnet bet 1 has settled, so there is one to run it on.
  pending: "Per bet: try mainnet bet 1",
};
export function Tag({ s }: { s: Status }) {
  return <span className="docs-tag" data-status={s}>{STATUS_TEXT[s]}</span>;
}

/** The frame of every Docs page: the sub-nav (one entry per page, the current one marked), the page, and a link to the next page. */
export function DocsFrame({ page, children }: { page: DocsPageId; children: React.ReactNode }) {
  const i = DOCS_PAGES.findIndex((p) => p.id === page);
  const next = DOCS_PAGES[i + 1];
  return (
    <div className="docs" data-testid="docs-page" data-page={page}>
      <nav className="docs-nav" aria-label="Docs" data-testid="docs-nav">
        <ol>
          {DOCS_PAGES.map((p) => (
            <li key={p.id}>
              <DocLink to={docsPath(p.id)} data-testid={`docs-nav-${p.id}`} {...(p.id === page ? { "aria-current": "page" } : {})}>{p.title}</DocLink>
            </li>
          ))}
        </ol>
      </nav>
      <article className="about docs-body" data-testid={`docs-${page}`}>
        {children}
        {next && (
          <p className="docs-next"><DocLink to={docsPath(next.id)} data-testid="docs-next">Next: {next.title} ›</DocLink></p>
        )}
      </article>
    </div>
  );
}

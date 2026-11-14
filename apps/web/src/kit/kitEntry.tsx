// K0: the /kit entry. Loaded only through src/main.tsx's __PRAETORIAL_KIT__ branch (VITE_KIT=1 builds; never mainnet).
// Network mocks: the playground needs no network at all, so before anything renders every fetch / XHR / beacon / WebSocket to
// anything but this page's own static files is refused with a 503. A preview host can't reach a wallet, the relayer, the
// indexer, 1Click or any RPC from this page, whatever a component tries.
import React from "react";
import type { Root } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { brandTheme } from "../theme/brand";
import Playground from "./Playground";
import { ToastProvider } from "./Toast";
import { blockedRequest } from "../../lib/kitBuild";

function installNetworkMocks(): void {
  const w = window as any;
  if (w.__kitNetworkMocked) return;
  w.__kitNetworkMocked = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (blockedRequest(url, window.location.origin)) {
      console.warn(`[kit] blocked network request: ${url}`);
      return new Response(JSON.stringify({ error: "blocked by the /kit preview (fixtures only)" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return origFetch(input as RequestInfo, init);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const u = String(url);
    if (blockedRequest(u, window.location.origin)) throw new Error(`[kit] blocked network request: ${u}`);
    return (open as any).call(this, method, url, ...rest);
  } as typeof open;
  if (navigator.sendBeacon) navigator.sendBeacon = () => false;
  const WS = window.WebSocket;
  w.WebSocket = function (url: string | URL, protocols?: string | string[]) {
    if (blockedRequest(String(url).replace(/^ws/, "http"), window.location.origin)) throw new Error(`[kit] blocked websocket: ${url}`);
    return new WS(url, protocols);
  } as unknown as typeof WebSocket;
}

export function mountKit(root: Root): void {
  installNetworkMocks();
  root.render(<Theme theme={brandTheme()} mode="light"><ToastProvider><Playground /></ToastProvider></Theme>);
}

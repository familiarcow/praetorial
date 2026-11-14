/// <reference types="vite/client" />
import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { Buffer } from "buffer";
import { Theme } from "@astryxdesign/core/theme";
import "./styles.css";
import "./theme/brand.css";
import { applyBrand, brandTheme } from "./theme/brand";
import App from "./App";
import { CrashBoundary } from "./CrashBoundary";
import SiteFooter from "./components/SiteFooter";
import { ToastProvider } from "./kit/Toast";
import { harnessEnabled } from "../lib/modalLogic";
import { isKitPath } from "../lib/kitBuild";

// K0: "off" | "route" | "only", replaced by a string literal at build time (vite.config.ts kitDefines, lib/kitBuild.ts).
declare const __PRAETORIAL_KIT__: "off" | "route" | "only";

// lib/delegate.ts (NEP-366 SignedDelegateAction builder, used by every
// relay action: cancel/challenge/submit_exhibits/
// emergency_refund/open) calls Node's Buffer directly, same as
// @near-js/transactions itself. Browsers have no global Buffer, so
// polyfill it once here before anything else runs.
if (typeof window !== "undefined" && !(window as any).Buffer) {
  (window as any).Buffer = Buffer;
}

// App ID is public (per Privy's own docs it's safe client-side); the
// app secret never goes anywhere near the browser.
const PRIVY_APP_ID = "cmw1b5stc01q60glap4q18que";

// BRAND1: one switch (VITE_BRAND / ?brand=), src/theme/brand.ts.
applyBrand();

const root = createRoot(document.getElementById("root")!);

// MODAL1a: the modal test harness exists only in dev builds. `import.meta.env.DEV` is replaced by `false` in `vite build`,
// so this whole branch (and the dynamic import) is dead code and tree-shaken out of production. Unit-tested in flowModal.unit.test.ts.
// K0: the /kit playground. In every build without VITE_KIT=1 (always including mainnet) __PRAETORIAL_KIT__ is the literal "off",
// so this condition folds to false and Rollup drops the dynamic import and the playground chunk (tests/kitBundle.unit.test.ts).
if (__PRAETORIAL_KIT__ !== "off" && (__PRAETORIAL_KIT__ === "only" || isKitPath(window.location.pathname))) {
  import("./kit/kitEntry").then(({ mountKit }) => mountKit(root));
} else if (import.meta.env.DEV && harnessEnabled({ DEV: import.meta.env.DEV }, window.location.pathname)) {
  import("./modal/Harness").then(({ default: Harness }) => {
    root.render(<Theme theme={brandTheme()} mode="light"><Harness /></Theme>);
  });
} else {
  // TFIX2: the crash boundary is the outermost element, so a render error anywhere (Privy, the theme, the toasts, any page) shows
  // "Something went wrong. Reload" instead of a white page.
  root.render(
  <CrashBoundary>
  <PrivyProvider
    appId={PRIVY_APP_ID}
    config={{
      loginMethods: ["email"],
      appearance: { showWalletLoginFirst: false },
    }}
  >
    <Theme theme={brandTheme()} mode="light">
      <ToastProvider><App /><SiteFooter /></ToastProvider>
    </Theme>
  </PrivyProvider>
  </CrashBoundary>,
);
}

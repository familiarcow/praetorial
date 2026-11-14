import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import App from "./App";

// App ID is public (per Privy's own docs it's safe client-side); the
// app secret never goes anywhere near the browser.
const PRIVY_APP_ID = "cmw1b5stc01q60glap4q18que";

createRoot(document.getElementById("root")!).render(
  <PrivyProvider
    appId={PRIVY_APP_ID}
    config={{
      loginMethods: ["email"],
      appearance: { showWalletLoginFirst: false },
    }}
  >
    <App />
  </PrivyProvider>,
);

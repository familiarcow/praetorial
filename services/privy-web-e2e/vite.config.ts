import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal dev server for the Option-1 round-trip test app. Port fixed
// at 3000 per the task spec; Playwright drives this exact origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
  },
});

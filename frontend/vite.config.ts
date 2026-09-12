/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // We register the service worker ourselves (src/pwa.ts) so we can add
      // periodic update checks; disable the auto-injected registration to avoid
      // registering twice.
      injectRegister: null,
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Fit Track",
        short_name: "Fit Track",
        description: "Apple Watch activity and workout tracker.",
        theme_color: "#0e0f1a",
        background_color: "#0e0f1a",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        // A newly-deployed service worker should take over as soon as it installs
        // (skipWaiting) and control existing clients immediately (clientsClaim),
        // and old precaches should be dropped. Combined with the controllerchange
        // reload in src/pwa.ts, this stops installed PWAs (notably iOS) from
        // lingering on a stale shell.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // The FastAPI backend is served under /api on the same origin; never let
        // the SW navigation fallback serve the cached app shell for API requests.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api"),
            handler: "NetworkOnly",
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to the FastAPI backend during local development.
      "/api": "http://localhost:8000",
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
  },
});

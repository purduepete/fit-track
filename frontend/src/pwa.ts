import { registerSW } from "virtual:pwa-register";

// Service-worker registration with aggressive update checking (mirrors
// webinventory). The app uses `registerType: 'autoUpdate'` (see vite.config.ts),
// so once a new service worker is found it is installed, activated and the page
// reloads automatically. The catch is *when* the browser checks for a new
// worker: by default it only re-fetches sw.js on a cold navigation, and iOS PWAs
// suspend background timers, so a device can sit on a stale build. We therefore
// explicitly re-check shortly after launch, on an interval, and every time the
// app returns to the foreground (the reliable trigger on iOS).
const UPDATE_INTERVAL_MS = 60 * 1000;

// When a freshly-installed service worker takes control, reload once so the
// running page swaps to the new app shell immediately instead of lingering on
// the old bundle until the next cold start. The guard prevents reload loops.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;

    const checkForUpdate = () => {
      if (registration.installing) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      void registration.update();
    };

    setInterval(checkForUpdate, UPDATE_INTERVAL_MS);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });
    window.addEventListener("focus", checkForUpdate);
  },
});

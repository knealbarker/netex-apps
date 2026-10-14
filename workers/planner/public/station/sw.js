// The station page's service worker: only here so Chrome can install the page as a full-screen app.
// It caches nothing; every request goes to the network as usual.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

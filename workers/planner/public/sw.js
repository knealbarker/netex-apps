// Offline: each PC keeps a copy of the planner and of the plans it has read, so the day's plan still opens when the
// internet is down (read-only). Everything is fetched fresh when online; the copies are only used when the network fails.
//  - The app's own files: network first, then the saved copy.
//  - Data the plan and floor screens read (/api/me, settings, team, pieces, plan, floor): network first; a good answer is
//    saved; offline, the saved answer is served with an x-offline header (when it was saved), so the page can say so.
//  - Nothing else is saved (Review, users, changes), and nothing is ever written while offline.
const SHELL = "pp-shell-v1", DATA = "pp-data-v1";
const FILES = ["/", "/app.css", "/icon.svg", "/js/app.js", "/js/api.js", "/js/ui.js", "/js/alerts.js", "/js/engine/engine.js", "/js/plan/model.js", "/js/plan/floor.js",
  "/js/views/plan.js", "/js/views/floor.js", "/js/views/review.js", "/js/views/team.js", "/js/views/settings.js", "/js/views/users.js"];
const SAVED_API = /^\/api\/(me|settings|team|pieces|plan\/\d{4}-\d{2}-\d{2}|floor\/\d{4}-\d{2}-\d{2})$/;

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(FILES.map(async f => { try { const r = await fetch(f, { credentials: "same-origin", cache: "no-cache" }); if (r.ok && !r.redirected) await c.put(f, r); } catch { /* next time */ } }));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (![SHELL, DATA].includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("message", e => { if (e.data === "forget") e.waitUntil(caches.delete(DATA)); }); // signing out

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    if (!SAVED_API.test(url.pathname)) return;
    e.respondWith(apiFirst(req, url));
    return;
  }
  if (url.pathname.startsWith("/cdn-cgi/") || url.pathname.startsWith("/shuttlestatus") || url.pathname.startsWith("/station")) return; // pages of their own
  e.respondWith(shellFirst(req, url));
});

async function shellFirst(req, url) {
  const key = req.mode === "navigate" || url.pathname === "/index.html" ? "/" : url.pathname;
  try {
    const r = await fetch(req);
    // keep only real files (not Cloudflare's sign-in page after a redirect)
    if (r.ok && !r.redirected && r.type === "basic" && (key === "/" || !/text\/html/.test(r.headers.get("content-type") || ""))) (await caches.open(SHELL)).put(key, r.clone());
    return r;
  } catch (err) {
    const hit = await caches.match(key, { cacheName: SHELL });
    if (hit) return hit;
    throw err;
  }
}

async function apiFirst(req, url) {
  const key = url.pathname + url.search;
  try {
    const r = await fetch(req);
    if (r.ok && /application\/json/.test(r.headers.get("content-type") || "")) {
      const body = await r.clone().arrayBuffer();
      const h = new Headers(r.headers); h.set("x-saved-at", new Date().toISOString());
      (await caches.open(DATA)).put(key, new Response(body, { status: 200, headers: h }));
    }
    return r;
  } catch {
    const c = await caches.open(DATA);
    const hit = (await c.match(key)) || (url.search ? await c.match(url.pathname) : null);
    if (hit) {
      const h = new Headers(hit.headers); h.set("x-offline", hit.headers.get("x-saved-at") || "");
      return new Response(await hit.arrayBuffer(), { status: 200, headers: h });
    }
    return new Response(JSON.stringify({ error: "You're offline, and this PC hasn't saved this yet." }), { status: 503, headers: { "content-type": "application/json", "x-offline": "" } });
  }
}

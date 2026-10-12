// Talks to the Worker. Every call returns parsed JSON or throws an Error with a message fit to show people.
export class ApiError extends Error {
  constructor(status, body) { super(body?.error || `Request failed (${status}).`); this.status = status; this.body = body || {}; }
}
// Offline: the service worker (sw.js) answers with what this PC saved and an x-offline header. The app shows a bar
// and the screens go read-only until a request gets through again ("pp-net" event).
export const net = { offline: false, savedAt: null };
function setNet(offline, savedAt = null) {
  if (net.offline === offline && net.savedAt === savedAt) return;
  net.offline = offline; net.savedAt = savedAt;
  window.dispatchEvent(new CustomEvent("pp-net", { detail: { ...net } }));
}
export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  } catch {
    if (method === "GET") setNet(true, net.savedAt);
    throw new ApiError(0, { error: method === "GET" ? "Can't reach the planner. Check the internet connection." : "Can't save: the internet connection is down. Try again when it's back." });
  }
  const off = res.headers.get("x-offline");
  if (off !== null) setNet(true, off || net.savedAt); else setNet(false);
  // Access sends an HTML sign-in page when the session has run out
  const type = res.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new ApiError(401, { error: "Your sign-in has expired. Reload the page to sign in again.", reason: "expired" });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Talks to the Worker. Every call returns parsed JSON or throws an Error with a message fit to show people.
export class ApiError extends Error {
  constructor(status, body) { super(body?.error || `Request failed (${status}).`); this.status = status; this.body = body || {}; }
}
export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, { error: "Can't reach the Retail Snapshot. Check the internet connection." });
  }
  // Access sends an HTML sign-in page when the session has run out
  const type = res.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new ApiError(401, { error: "Your sign-in has expired. Reload the page to sign in again.", reason: "expired" });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

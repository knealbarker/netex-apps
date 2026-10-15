// supplies.netexcleaners.com — supply counts, shuttle lists and vendor orders.
//  /count/...  the count page on a paired store / Hub / Workshop device. Cloudflare Access lets /count through without a sign-in
//              (a Bypass application), so nothing there trusts Access: every data call needs the device's paired secret (cookie),
//              and a count needs a name from the approved list.
//  everything else: the supply manager's screens, signed in like the other apps (role in app 'supplies').
import { currentUser, verifyAccessJwt, requireRole } from "../../planner/src/auth.js";
import { listUsers, createUser, updateUser, syncAccessGroup } from "../../planner/src/users.js";
import { HttpError, json, readJson } from "../../planner/src/util.js";
import { localToday } from "./logic.js";
import * as C from "./catalog.js";
import * as N from "./counts.js";
import * as S from "./shuttle.js";
import * as O from "./orders.js";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
const withHeaders = res => { const r = new Response(res.body, res); for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v); return r; };
const ID = "([0-9A-Za-z_-]{1,40})";
const re = s => new RegExp("^" + s.replace(/:id/g, ID) + "$");

const routes = [
  ["GET", re("/api/me"), async (req, env, me) => json({ user: me, app: { id: env.APP_ID, name: "Supplies" }, today: localToday(env.TIMEZONE, env.NOW ? new Date(env.NOW) : new Date()) })],
  ["GET", re("/api/overview"), async (req, env, me) => json({ locations: await N.overview(env.DB, env) })],
  // shuttle
  ["GET", re("/api/shuttle"), async (req, env, me) => json(await S.shuttle(env.DB, env))],
  ["POST", re("/api/shuttle"), async (req, env, me) => json(await S.createShipment(env.DB, env, me, await readJson(req)), 201)],
  ["PUT", re("/api/shuttle/:id"), async (req, env, me, m) => json(await S.saveShipment(env.DB, env, me, m[1], await readJson(req)))],
  ["POST", re("/api/shuttle/:id/sent"), async (req, env, me, m) => json(await S.setShipmentStatus(env.DB, env, me, m[1], "sent"))],
  ["POST", re("/api/shuttle/:id/reopen"), async (req, env, me, m) => json(await S.setShipmentStatus(env.DB, env, me, m[1], "open"))],
  ["POST", re("/api/shuttle/:id/drop"), async (req, env, me, m) => json(await S.setShipmentStatus(env.DB, env, me, m[1], "cancelled"))],
  // vendor orders
  ["GET", re("/api/orders"), async (req, env, me) => json(await O.orders(env.DB, env))],
  ["POST", re("/api/orders"), async (req, env, me) => json(await O.placeOrder(env.DB, env, me, await readJson(req)), 201)],
  ["PATCH", re("/api/orders/:id"), async (req, env, me, m) => json(await O.updateOrder(env.DB, env, me, m[1], await readJson(req)))],
  // counts and requests
  ["GET", re("/api/counts"), async (req, env, me) => { const u = new URL(req.url); return json({ counts: await N.countHistory(env.DB, env, { locationId: u.searchParams.get("location"), limit: 100 }) }); }],
  ["GET", re("/api/counts/:id"), async (req, env, me, m) => json(await N.countDetail(env.DB, env, m[1]))],
  ["POST", re("/api/counts"), async (req, env, me) => json(await N.managerSubmit(env.DB, env, me, await readJson(req)), 201)],
  ["GET", re("/api/sheet/:id"), async (req, env, me, m) => { requireRole(me, "manager"); const loc = await C.locationOf(env.DB, env, m[1]); return json({ location: loc, items: await N.sheetFor(env.DB, env, loc) }); }],
  ["POST", re("/api/requests"), async (req, env, me) => json(await N.createRequests(env.DB, env, me, await readJson(req)), 201)],
  ["DELETE", re("/api/requests/:id"), async (req, env, me, m) => json(await N.cancelRequest(env.DB, env, me, m[1]))],
  // supply list
  ["GET", re("/api/catalog"), async (req, env, me) => json(await C.catalog(env.DB, env))],
  ["POST", re("/api/items"), async (req, env, me) => json(await C.createItem(env.DB, env, me, await readJson(req)), 201)],
  ["PATCH", re("/api/items/:id"), async (req, env, me, m) => json(await C.updateItem(env.DB, env, me, m[1], await readJson(req)))],
  ["POST", re("/api/vendors"), async (req, env, me) => json(await C.saveVendor(env.DB, env, me, null, await readJson(req)), 201)],
  ["PATCH", re("/api/vendors/:id"), async (req, env, me, m) => json(await C.saveVendor(env.DB, env, me, m[1], await readJson(req)))],
  ["PATCH", re("/api/locations/:id"), async (req, env, me, m) => json(await C.updateLocation(env.DB, env, me, m[1], await readJson(req)))],
  // who may count, and the counting devices
  ["GET", re("/api/counters"), async (req, env, me) => json({ counters: await C.counters(env.DB, env) })],
  ["POST", re("/api/counters"), async (req, env, me) => json(await C.saveCounter(env.DB, env, me, null, await readJson(req)), 201)],
  ["PATCH", re("/api/counters/:id"), async (req, env, me, m) => json(await C.saveCounter(env.DB, env, me, m[1], await readJson(req)))],
  ["GET", re("/api/devices"), async (req, env, me) => json({ devices: await N.listDevices(env.DB, env, me) })],
  ["POST", re("/api/devices"), async (req, env, me) => json(await N.createDevice(env.DB, env, me, await readJson(req)), 201)],
  ["POST", re("/api/devices/:id/code"), async (req, env, me, m) => json(await N.deviceCode(env.DB, env, me, m[1]))],
  ["DELETE", re("/api/devices/:id"), async (req, env, me, m) => json(await N.removeDevice(env.DB, env, me, m[1]))],
  // users & access (same screen and code as the other apps)
  ["GET", re("/api/users"), async (req, env, me) => json({ users: await listUsers(env.DB, env, me), groupSync: Boolean(env.CF_API_TOKEN && env.ACCESS_GROUP_ID) })],
  ["POST", re("/api/users"), async (req, env, me) => { const r = await createUser(env.DB, env, me, await readJson(req)); return json({ ...r, access: await syncAccessGroup(env.DB, env) }, 201); }],
  ["PATCH", re("/api/users/:id"), async (req, env, me, m) => { const r = await updateUser(env.DB, env, me, m[1], await readJson(req)); return json({ ...r, access: r.changed ? await syncAccessGroup(env.DB, env) : { synced: false, reason: "unchanged" } }); }],
];

function sameSite(req, url) {
  const origin = req.headers.get("origin");
  if (req.method === "GET" || req.method === "HEAD" || !origin) return;
  let host; try { host = new URL(origin).host; } catch { host = ""; }
  if (host !== (req.headers.get("host") || url.host)) throw new HttpError(403, "Not allowed from another site.");
}

/** The count page and its API (no Access sign-in; the device's own paired cookie). */
async function countPage(req, env, url) {
  const p = url.pathname, db = env.DB;
  if (!p.startsWith("/count/api/")) {
    if (p === "/count") return Response.redirect(new URL("/count/", url).toString(), 302);
    if (!["GET", "HEAD"].includes(req.method)) throw new HttpError(405, "Method not allowed.");
    return env.ASSETS.fetch(req);
  }
  sameSite(req, url);
  const route = p.slice("/count/api".length);
  const withCookie = (res, token) => { if (token) res.headers.append("set-cookie", N.setCookie(token)); return res; };
  if (route === "/pair" && req.method === "POST") {
    const r = await N.pairDevice(db, env, (await readJson(req)).code);
    return withCookie(json(await N.deviceState(db, env, r.device)), r.token);
  }
  const dev = await N.deviceOf(db, env, req);
  if (route === "/state" && req.method === "GET") {
    if (!dev) { const res = json({ paired: false }); if (N.cookieOf(req)) res.headers.append("set-cookie", N.clearCookie()); return res; }
    return withCookie(json(await N.deviceState(db, env, dev)), dev.token);
  }
  if (!dev) throw new HttpError(401, "This device isn't set up for counting. Ask the supply manager for a code.", { reason: "unpaired" });
  if (route === "/who" && req.method === "POST") return json(await N.deviceWho(db, env, dev, await readJson(req)));
  if (route === "/submit" && req.method === "POST") return json(await N.deviceSubmit(db, env, dev, await readJson(req)), 201);
  throw new HttpError(404, "Not found.");
}

export async function handle(req, env, opts = {}) {
  const url = new URL(req.url);
  const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/count/api/");
  try {
    if (url.pathname === "/count" || url.pathname.startsWith("/count/")) return await countPage(req, env, url);
    if (url.pathname.startsWith("/api/")) {
      sameSite(req, url);
      const me = await currentUser(req, env, opts);
      if (req.method !== "GET" && me.role === "viewer") throw new HttpError(403, "Viewers can look but not change anything.");
      for (const [method, rx, fn] of routes) {
        const m = url.pathname.match(rx);
        if (m && req.method === method) return await fn(req, env, me, m, opts);
      }
      const anyPath = routes.some(([, rx]) => rx.test(url.pathname));
      throw new HttpError(anyPath ? 405 : 404, anyPath ? "Method not allowed." : "Not found.");
    }
    // The page itself holds no company data; the data comes from /api, which checks the user list.
    if (!(env.DEV_EMAIL && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      const token = req.headers.get("cf-access-jwt-assertion") || (req.headers.get("cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
      await verifyAccessJwt(token, { teamDomain: env.TEAM_DOMAIN, aud: env.ACCESS_AUD, fetchImpl: opts.fetchImpl || fetch });
    }
    return await env.ASSETS.fetch(req);
  } catch (e) {
    if (e instanceof HttpError) {
      if (!isApi) return new Response(`${e.message}\n`, { status: e.status, headers: { "content-type": "text/plain; charset=utf-8" } });
      return json({ error: e.message, ...(e.extra || {}) }, e.status);
    }
    console.error(JSON.stringify({ error: String(e && e.stack || e), path: url.pathname }));
    return json({ error: "Something went wrong on our side. Try again; if it keeps happening, tell Neal." }, 500);
  }
}

export default {
  async fetch(req, env) { return withHeaders(await handle(req, env)); },
};

// Tests for people with a mobile number (text-message sign-in). Run: node workers/planner/test/users-phone.mjs
import { freshDb, fakeAccess, makeEnv } from "./harness.mjs";
import { handle } from "../src/index.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const A = await fakeAccess();
function app() {
  const { db } = freshDb(); const env = makeEnv(db);
  const call = async (method, path, { as = "neal@towncountryclean.com", body } = {}) => {
    const headers = new Headers({ "cf-access-jwt-assertion": await A.token({ email: as }) });
    if (body) headers.set("content-type", "application/json");
    const r = await handle(new Request(`https://prodplanner.netexcleaners.com/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
    return { status: r.status, body: await r.json() };
  };
  return { call };
}

await t("a manager with only a mobile number: stand-in email, phone kept, can open the planner", async () => {
  const { call } = app();
  const r = await call("POST", "/users", { body: { name: "Maria Phone", phone: "(903) 555-0101", role: "manager" } });
  eq(r.status, 201);
  const u = (await call("GET", "/users")).body.users.find(x => x.name === "Maria Phone");
  eq([u.email, u.phone, u.phoneOnly, u.role], ["19035550101@phone.netexcleaners.com", "+19035550101", true, "manager"]);
  // signing in through the text-message method gives Access that stand-in email
  const me = await call("GET", "/me", { as: "19035550101@phone.netexcleaners.com" });
  eq([me.status, me.body.user.role], [200, "manager"]);
});
await t("email and phone together; neither is refused; a number already in use is refused", async () => {
  const { call } = app();
  eq((await call("POST", "/users", { body: { name: "Both", email: "both@example.com", phone: "903-555-0102" } })).status, 201);
  eq((await call("POST", "/users", { body: { name: "Nothing" } })).status, 400);
  eq((await call("POST", "/users", { body: { name: "Bad", phone: "555-0102" } })).status, 400);
  eq((await call("POST", "/users", { body: { name: "Dup", phone: "(903) 555-0102" } })).status, 409);
  eq((await call("POST", "/users", { body: { name: "Dup2", email: "x@example.com", phone: "9035550102" } })).status, 409);
});
await t("editing: add an email later, change the number, can't remove both", async () => {
  const { call } = app();
  const id = (await call("POST", "/users", { body: { name: "Phone Only", phone: "9035550103", role: "viewer" } })).body.id;
  eq((await call("PATCH", `/users/${id}`, { body: { phone: "9035550104" } })).status, 200);
  let u = (await call("GET", "/users")).body.users.find(x => x.id === id);
  eq([u.email, u.phone], ["19035550104@phone.netexcleaners.com", "+19035550104"], "stand-in follows the new number");
  eq((await call("PATCH", `/users/${id}`, { body: { email: "phone.only@example.com" } })).status, 200);
  u = (await call("GET", "/users")).body.users.find(x => x.id === id);
  eq([u.email, u.phoneOnly], ["phone.only@example.com", false]);
  eq((await call("PATCH", `/users/${id}`, { body: { email: "", phone: "" } })).status, 400);
  eq((await call("PATCH", `/users/${id}`, { body: { email: "" } })).status, 200, "back to phone only");
  u = (await call("GET", "/users")).body.users.find(x => x.id === id);
  eq(u.email, "19035550104@phone.netexcleaners.com");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

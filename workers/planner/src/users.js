// The user list: who can sign in and what they can do in each app.
// Rules
//   - Admins and the Owner manage users. Managers and Viewers can't open the list.
//   - You can only give a role below your own (the Owner can give any role, including Owner).
//   - You can't change someone whose role is equal to or above yours (the Owner can change anyone).
//   - The last Owner can't be removed, demoted or turned off.
// Whoever is active with a role in any app is copied into the Cloudflare Access group "Netex users", so
// adding someone here is all it takes for them to be able to sign in (once the CF_API_TOKEN secret is set).
import { HttpError, ulid, nowIso, cleanEmail, cleanName, audit } from "./util.js";
import { rank, requireRole } from "./auth.js";

const ROLES = ["owner", "admin", "manager", "viewer"];

export async function listUsers(db, env, me) {
  requireRole(me, "admin");
  const { results } = await db.prepare(`
    SELECT u.id, u.email, u.display_name AS name, u.status, u.last_seen_at AS lastSeen, u.created_at AS created,
           r.role_id AS role, p.id AS personId, COALESCE(p.display_name, p.first_name || ' ' || p.last_name) AS personName
      FROM core_users u
      LEFT JOIN core_user_app_roles r ON r.user_id = u.id AND r.app_id = ?
      LEFT JOIN core_people p ON p.id = u.person_id
     WHERE u.org_id = ? AND u.deleted_at IS NULL`)
    .bind(env.APP_ID, env.ORG_ID).all();
  const order = r => (r ? rank(r) : 0);
  results.sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || order(b.role) - order(a.role) || a.name.localeCompare(b.name));
  return results.map(u => ({ ...u, canEdit: canEdit(me, u) }));
}

function canEdit(me, target) {
  if (me.role === "owner") return true;
  if (target.id === me.id) return false;
  return rank(target.role) < rank(me.role);
}
function checkGrant(me, role) {
  if (role === null) return;
  if (!ROLES.includes(role)) throw new HttpError(400, "Pick a role: Owner, Admin, Manager or Viewer.");
  if (me.role !== "owner" && rank(role) >= rank(me.role)) throw new HttpError(403, `You can only give roles below ${me.role}.`);
}
async function ownersLeft(db, env, exceptUserId) {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM core_user_app_roles r JOIN core_users u ON u.id = r.user_id
     WHERE r.app_id = ? AND r.role_id = 'owner' AND u.status = 'active' AND u.deleted_at IS NULL AND u.id <> ?`).bind(env.APP_ID, exceptUserId).first();
  return r.n;
}

export async function createUser(db, env, me, body) {
  requireRole(me, "admin");
  const email = cleanEmail(body.email);
  const name = cleanName(body.name);
  const role = body.role ?? "viewer";
  checkGrant(me, role);
  const existing = await db.prepare("SELECT id, deleted_at FROM core_users WHERE org_id=? AND lower(email)=?").bind(env.ORG_ID, email).first();
  if (existing && !existing.deleted_at) throw new HttpError(409, "Someone with that email is already on the list.");
  const id = existing ? existing.id : ulid();
  const now = nowIso();
  const stmts = [];
  if (existing) {
    stmts.push(db.prepare("UPDATE core_users SET display_name=?, status='active', deleted_at=NULL, updated_at=?, updated_by=?, rev=rev+1 WHERE id=?").bind(name, now, me.id, id));
  } else {
    stmts.push(db.prepare("INSERT INTO core_users(id, org_id, email, display_name, updated_by) VALUES(?,?,?,?,?)").bind(id, env.ORG_ID, email, name, me.id));
  }
  if (role) stmts.push(db.prepare(`INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_by, granted_at) VALUES(?,?,?,?,?)
     ON CONFLICT(user_id, app_id) DO UPDATE SET role_id=excluded.role_id, granted_by=excluded.granted_by, granted_at=excluded.granted_at`).bind(id, env.APP_ID, role, me.id, now));
  await db.batch(stmts);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_users", entityId: id, action: "create", changes: { email, name, role } });
  return { id };
}

export async function updateUser(db, env, me, id, body) {
  requireRole(me, "admin");
  const t = await db.prepare(`SELECT u.id, u.email, u.display_name AS name, u.status, r.role_id AS role FROM core_users u
      LEFT JOIN core_user_app_roles r ON r.user_id = u.id AND r.app_id = ? WHERE u.id = ? AND u.org_id = ? AND u.deleted_at IS NULL`)
    .bind(env.APP_ID, id, env.ORG_ID).first();
  if (!t) throw new HttpError(404, "That user isn't on the list.");
  if (!canEdit(me, t)) throw new HttpError(403, t.id === me.id ? "Ask another Admin or the Owner to change your own access." : "You can't change someone with the same or a higher role.");

  const changes = {};
  const name = body.name !== undefined ? cleanName(body.name) : t.name;
  if (name !== t.name) changes.name = [t.name, name];
  const status = body.status !== undefined ? body.status : t.status;
  if (!["active", "disabled"].includes(status)) throw new HttpError(400, "Status must be active or disabled.");
  if (status !== t.status) changes.status = [t.status, status];
  const role = body.role !== undefined ? body.role : t.role; // null = no access to this app
  if (role !== t.role) { checkGrant(me, role); changes.role = [t.role, role]; }

  const losesOwner = t.role === "owner" && (role !== "owner" || status !== "active");
  if (losesOwner && (await ownersLeft(db, env, t.id)) === 0) throw new HttpError(409, "There has to be at least one active Owner.");
  if (!Object.keys(changes).length) return { id, changed: false };

  const now = nowIso();
  const stmts = [db.prepare("UPDATE core_users SET display_name=?, status=?, updated_at=?, updated_by=?, rev=rev+1 WHERE id=?").bind(name, status, now, me.id, id)];
  if ("role" in changes) {
    stmts.push(role
      ? db.prepare(`INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_by, granted_at) VALUES(?,?,?,?,?)
          ON CONFLICT(user_id, app_id) DO UPDATE SET role_id=excluded.role_id, granted_by=excluded.granted_by, granted_at=excluded.granted_at`).bind(id, env.APP_ID, role, me.id, now)
      : db.prepare("DELETE FROM core_user_app_roles WHERE user_id=? AND app_id=?").bind(id, env.APP_ID));
  }
  await db.batch(stmts);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_users", entityId: id, action: "update", changes });
  return { id, changed: true };
}

// ---------- keep the Cloudflare Access group in step with the list ----------
// Needs: secret CF_API_TOKEN (Account > Access: Organizations, Identity Providers, and Groups > Edit),
//        vars ACCOUNT_ID and ACCESS_GROUP_ID. Without them the list still works; people are added to the group by hand.
export async function syncAccessGroup(db, env, fetchImpl = fetch) {
  if (!env.CF_API_TOKEN || !env.ACCESS_GROUP_ID || !env.ACCOUNT_ID) return { synced: false, reason: "not_configured" };
  const { results } = await db.prepare(`SELECT DISTINCT lower(u.email) AS email FROM core_users u JOIN core_user_app_roles r ON r.user_id = u.id
      WHERE u.org_id = ? AND u.status = 'active' AND u.deleted_at IS NULL ORDER BY 1`).bind(env.ORG_ID).all();
  const emails = results.map(r => r.email);
  if (!emails.length) return { synced: false, reason: "no_users" }; // never leave the group empty
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/access/groups/${env.ACCESS_GROUP_ID}`;
  const headers = { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" };
  try {
    const cur = await fetchImpl(url, { headers });
    const curBody = await cur.json();
    if (!cur.ok || !curBody.success) return { synced: false, reason: "cloudflare_error", detail: (curBody.errors || [])[0]?.message };
    const put = await fetchImpl(url, { method: "PUT", headers, body: JSON.stringify({ name: curBody.result.name, include: emails.map(email => ({ email: { email } })) }) });
    const putBody = await put.json();
    if (!put.ok || !putBody.success) return { synced: false, reason: "cloudflare_error", detail: (putBody.errors || [])[0]?.message };
    return { synced: true, count: emails.length };
  } catch (e) {
    return { synced: false, reason: "cloudflare_unreachable", detail: String(e.message || e) };
  }
}

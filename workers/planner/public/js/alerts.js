// Shuttle alerts on every screen (as the desktop planner did): when a deadline's pieces are all ready, and before a
// shuttle leaves with work unfinished (Settings › Shuttle alerts: first and second warning). Shown as a toast and, when
// this PC allowed it, a Windows notification. Each alert shows once per PC; the first PC to notice it also adds it to
// "Changes today". Checked every 2 minutes on work days while the planner is open.
import { api } from "./api.js";
import { SHUTTLES } from "./features.js";
import { toast } from "./ui.js";
import { buildWaves, CATS, CAT_LABEL, hm, fmtN } from "./engine/engine.js";

const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const memo = new Set();
let SET = null, setAt = 0, timer = null;

export function startAlerts() {
  if (timer || !SHUTTLES) return;
  setTimeout(check, 8000); // let the first screen load first
  timer = setInterval(check, 2 * 60 * 1000);
}

export const notifySupported = () => typeof Notification !== "undefined";
export const notifyState = () => (notifySupported() ? Notification.permission : "unsupported");
export async function askNotify() { if (!notifySupported()) return "unsupported"; try { return await Notification.requestPermission(); } catch { return Notification.permission; } }

const nowH = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };

/** The alerts due right now, from the pieces view (pure, for tests). */
export function dueAlerts(V, runs, A, now) {
  const out = [];
  if (!V.isWorkDay || !A.notify) return out;
  const D = V.days[V.today]; if (!D) return out;
  const waves = buildWaves({ ...D, isToday: true }, runs, { overdue: V.overdue });
  for (const w of waves) {
    if (w.kind === "overdue" || !w.todo || w.deadline == null) continue;
    const left = {}; for (const st of D.stores) if ((st.runId || "other") === w.id) for (const k of CATS) left[k] = (left[k] || 0) + Math.max(0, (st.q[k] || 0) - (st.done[k] || 0));
    const leftTxt = Object.entries(left).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${fmtN(v)} ${CAT_LABEL[k]}`).join(", ");
    if (w.leftTodo === 0) {
      if (w.kind !== "route" && now > w.deadline + 0.25) continue; // long gone: nothing to tell anyone
      out.push({ key: `ready:${w.id}`, kind: "ready", title: `${w.name} ready`,
        text: `${w.name} ready: ${fmtN(w.todo)} pieces, ${w.orders} orders.${w.kind === "shuttle" ? ` OK to load the ${hm(w.deadline)} shuttle.` : ""}` });
    } else if (w.kind === "shuttle") {
      const mins = (w.deadline - now) * 60;
      for (const thr of [A.warnFirst, A.warnSecond].filter(x => x > 0)) {
        if (mins <= thr && mins > thr - 12) out.push({ key: `warn${thr}:${w.id}`, kind: "warn", title: `${w.name}: ${fmtN(w.leftTodo)} not ready`,
          text: `${w.name} shuttle leaves ${hm(w.deadline)}: ${fmtN(w.leftTodo)} pieces not ready${leftTxt ? ` (${leftTxt})` : ""}.` });
      }
    }
  }
  return out;
}

async function check() {
  try {
    const h = nowH(); if (h < 3 || h > 21) return;
    if (!SET || Date.now() - setAt > 10 * 60 * 1000) { SET = await api("/settings"); setAt = Date.now(); }
    const A = SET.groups.alerts; if (!A.notify) return;
    const V = await api("/pieces");
    for (const a of dueAlerts(V, SET.runs, A, nowH())) fire(V.today, a);
  } catch { /* offline or signed out: the screens say so */ }
}

function fire(day, a) {
  const k = `alert:${day}:${a.key}`;
  if (memo.has(k) || store.get(k)) return;
  memo.add(k); store.set(k, "1");
  if (!/^#\/floor/.test(location.hash)) toast(a.text, a.kind === "ready" ? "ok" : "warn", 12000); // the Floor shows its own alert band
  if (notifyState() === "granted") { try { new Notification(a.title, { body: a.text, tag: k }); } catch { /* not allowed here */ } }
  api("/events", { method: "POST", body: { day, key: a.key, kind: a.kind, text: a.text } }).catch(() => {});
}

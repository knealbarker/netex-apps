// Sections still being moved over from the desktop planner. Each says plainly what it will do.
import { html, raw } from "../ui.js";

const SECTIONS = {
  plan: {
    title: "Plan", icon: '<path d="M4 5h16M4 12h16M4 19h10"/>',
    lead: "Tomorrow's and today's plan: who works where, how long each station runs, and whether everything gets done on time.",
    items: ["Pieces by department from SMRT, with the next day's expected total", "Waves, station times and overtime warnings", "Publish the plan to the floor screens"],
  },
  floor: {
    title: "Floor", icon: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M9 10v10"/>',
    lead: "The live view for the shop: what's running now, what's next, and anything late.",
    items: ["Station board for the shop TV (in Spanish and English)", "Late and overdue pieces, with their SMRT notes", "Works read-only from the last download when the internet is down"],
  },
  review: {
    title: "Review", icon: '<path d="M4 19V9m6 10V5m6 14v-7m4 7H3"/>',
    lead: "How the day went against the plan, and the history behind it.",
    items: ["Pieces and revenue per labor hour by day", "Follow-ups: due dates moved later, with notes saved to SMRT", "Plan history"],
  },
  team: {
    title: "Team", icon: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.9-5 5.5-5s4.9 1.8 5.5 5"/>',
    lead: "Everyone on the production team, what they're trained on and how fast they are.",
    items: ["Imported from the desktop planner's team list", "Skills and rankings per station", "Hours from Rippling each day"],
  },
  settings: {
    title: "Settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4"/>',
    lead: "Stations, run rates, wash programs and the working day.",
    items: ["Imported from the desktop planner's settings", "Changes are saved for every PC at once"],
  },
};

export function render(main, ctx, view) {
  const s = SECTIONS[view];
  main.innerHTML = html`
    <div class="page-head"><div><h1>${s.title}</h1><p>${s.lead}</p></div></div>
    <div class="card empty">
      <div class="ico"><svg viewBox="0 0 24 24" aria-hidden="true">${raw(s.icon)}</svg></div>
      <h2>Moving over from the desktop planner</h2>
      <p>This section is being rebuilt on the shared database. Keep using the desktop app for now. When it's ready it will:</p>
      <ul>${s.items.map(i => raw(html`<li>${i}</li>`))}</ul>
    </div>`;
}

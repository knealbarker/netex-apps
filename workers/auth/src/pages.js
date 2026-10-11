// The sign-in pages: plain HTML forms (no scripts), phone first, big touch targets, dark or light like the apps.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ESC[c]);

const CSS = `
:root{--bg:#0f1420;--card:#181f2e;--line:#273046;--line2:#323c55;--text:#e9edf5;--muted:#9ba4b6;--accent:#3ddc97;--ink:#06140d;--bad:#ff5c6c;--bad-soft:rgba(255,92,108,.12);--field:#141a28;color-scheme:dark}
@media (prefers-color-scheme: light){:root{--bg:#f4f6fa;--card:#fff;--line:#e1e6ef;--line2:#d3dae6;--text:#141b2b;--muted:#5d6779;--accent:#12a36b;--ink:#fff;--bad:#d83347;--bad-soft:rgba(216,51,71,.09);--field:#f7f8fb;color-scheme:light}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{width:100%;max-width:400px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;font-weight:700}
.brand svg{width:34px;height:34px;flex:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px 24px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
h1{font-size:22px;margin:0 0 6px;letter-spacing:-.01em}
.lead{color:var(--muted);margin:0 0 20px}
label{display:block;font-size:14px;font-weight:600;color:var(--muted);margin-bottom:6px}
input{width:100%;font:inherit;font-size:20px;padding:13px 14px;border-radius:12px;border:1px solid var(--line2);background:var(--field);color:var(--text);letter-spacing:.02em}
input:focus{outline:none;border-color:#4f8ff7;box-shadow:0 0 0 3px rgba(79,143,247,.2)}
input.code{font-size:28px;letter-spacing:.3em;text-align:center;font-variant-numeric:tabular-nums}
button{margin-top:16px;width:100%;font:inherit;font-weight:700;font-size:17px;padding:13px;border:0;border-radius:12px;background:var(--accent);color:var(--ink);cursor:pointer}
button:focus-visible{outline:2px solid #4f8ff7;outline-offset:2px}
.err{background:var(--bad-soft);color:var(--bad);border-radius:10px;padding:10px 12px;font-size:14px;margin:0 0 14px}
.foot{color:var(--muted);font-size:13px;margin:16px 2px 0}
.foot a{color:inherit}`;
const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#3ddc97"/><path d="M9 23V9h3.2l7.6 9.4V9H23v14h-3.2L12.2 13.6V23z" fill="#0f1420"/></svg>`;

export const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main><div class="brand">${MARK}<span>Town &amp; Country Cleaners</span></div><div class="card">${inner}</div></main></body></html>`;

export const phonePage = ({ rid, error, value }) => page("Sign in with your phone", `
  <h1>Sign in with your phone</h1>
  <p class="lead">We'll text a code to the mobile number on your account.</p>
  ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
  <form method="post" action="/send">
    <input type="hidden" name="rid" value="${esc(rid)}">
    <label for="phone">Mobile number</label>
    <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(903) 555-0123" value="${esc(value || "")}" required autofocus>
    <button type="submit">Text me a code</button>
  </form>
  <p class="foot">Have an email on your account? Go back and choose email instead.</p>`);

export const codePage = ({ rid, masked, error }) => page("Enter your code", `
  <h1>Enter your code</h1>
  <p class="lead">If ${esc(masked)} is on the user list, a text with a 6-digit code is on its way. It's good for 10 minutes.</p>
  ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
  <form method="post" action="/check">
    <input type="hidden" name="rid" value="${esc(rid)}">
    <label for="code">Code</label>
    <input id="code" class="code" name="code" type="text" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="12" required autofocus>
    <button type="submit">Sign in</button>
  </form>
  <p class="foot">No text after a minute? Check the number with your manager, or go back and start again.</p>`);

export const errorPage = msg => page("Sign-in problem", `<h1>Sign-in problem</h1><p class="lead" style="margin:0">${esc(msg)}</p>`);

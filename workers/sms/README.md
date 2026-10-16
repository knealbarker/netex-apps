# Texts (netex-sms) — sms.netexcleaners.com

One place every netexcleaners.com app sends and receives text messages. Number: **(903) 689-9487** (Twilio, Messaging Service
"Basic" `MG508b…`, on the verified A2P campaign "Account Notification"). Built Oct 16, 2026.

## How it works
- **Sending:** an app calls the `Texts` entrypoint over a service binding. Only netex-sms holds the Twilio credentials.
  Each text is saved in `sms_messages` with the sending app (`app_id`) and the app's own reference (`ref`).
- **Receiving:** Twilio posts every incoming text to `https://sms.netexcleaners.com/twilio/inbound`. The Worker checks Twilio's
  signature, saves the text and **routes** it:
  - **reply**: it answers our latest text to that phone within 7 days → that text's `app_id` and `ref`, `reply_to_id` = that text
  - **keyword**: STOP / START / HELP. Twilio answers these itself; STOP/START also set `sms_contacts.opted_out_at`
  - **unrouted**: anything else (`app_id` NULL)
  It answers Twilio with an empty response, so no automatic text goes back.
- **Email copy:** by `FORWARD_MODE` (`all` default, `unrouted`, `none`) each incoming text is emailed to `FORWARD_TO`.
- **Delivery updates:** Twilio posts to `/twilio/status`; `status` and `error_code` are kept on the outgoing row.
- **Texts page** (Admins and the Owner): every text in and out, a conversation per phone, "Send a text", "Mark done".

## Using it from another app
`wrangler.toml` of the app:
```toml
[[services]]
binding = "TEXTS"
service = "netex-sms"
entrypoint = "Texts"
```
```js
const r = await env.TEXTS.send({ app: "planner", to: "+12145550123", body: "Diana clocked in 7:42 AM (planned 7:30).", ref: "late:2026-10-16:<id>" });
// r = { ok: true, id, sid, status } or { ok: false, reason: 'opted_out'|'bad_number'|'daily_cap'|'not_set_up'|'twilio'|…, error }
const replies = await env.TEXTS.replies({ app: "planner" });      // not yet handled, oldest first: { id, phone, name, body, ref, reply_to_id, … }
await env.TEXTS.markHandled({ app: "planner", ids: replies.map(r => r.id) });
```
Apps may also read `sms_messages` directly (`direction='in' AND app_id=<app> AND handled_at IS NULL`). Safety cap:
`MAX_PER_APP_PER_DAY` (200) texts per app per 24 hours. Texts over 1,000 characters are refused.
To try it in tests without the binding, import `send`/`replies`/`markHandled` from `workers/sms/src/texts.js` with a fake fetch.

## Setup (Neal, once)
1. **Cloudflare › Workers & Pages › Create › Continue with GitHub › `knealbarker/netex-apps`**: project `netex-sms`, path
   `/workers/sms`, deploy command `npx wrangler deploy`, preview builds off, API token "netex-sync build".
2. **netex-sms › Settings › Variables and Secrets** (type Secret): `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`
   (both on Twilio Console › Account home).
   Optional, preferred for sending: a Standard API key "netex-sms" → `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`.
3. **Zero Trust › Access › Applications › Add › Self-hosted**: "Netex texts (Twilio webhooks)", domain `sms.netexcleaners.com`,
   path `twilio`, policy **Netex sign-in (public)** (Bypass). The Worker checks Twilio's signature on every request there.
4. **Twilio › Messaging › Services › Basic › Integration › Incoming messages**: "Send a webhook",
   `https://sms.netexcleaners.com/twilio/inbound`, HTTP POST. Save.
5. Text (903) 689-9487 from your phone; it shows on https://sms.netexcleaners.com and arrives by email.

## Tests
`node workers/sms/test/run.mjs` (16): signature (checked against the official twilio library), routing, retries, STOP/START,
delivery updates, sending errors and caps, forwarding modes, page API and roles.

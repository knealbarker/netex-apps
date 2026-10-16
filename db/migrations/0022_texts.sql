-- Texts (Neal, Oct 16 2026): sms.netexcleaners.com. One shared text-message service for every app.
-- Sending number (903) 689-9487 (Twilio, Messaging Service "Basic", A2P campaign "Account Notification").
-- Apps send through the netex-sms Worker (service binding, never over the internet) and read replies from sms_messages.
-- Twilio posts every incoming text to https://sms.netexcleaners.com/twilio/inbound (signature checked by the Worker).
-- Table prefix: sms_.

INSERT INTO core_apps(id, name, subdomain) VALUES ('sms', 'Texts', 'sms');
INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at)
SELECT id, 'sms', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM core_users WHERE lower(email) = 'neal@towncountryclean.com';

-- Every text in or out. Replies are routed to an app (app_id) by the conversation they answer (reply_to_id).
CREATE TABLE sms_messages (
  id            TEXT PRIMARY KEY,                     -- ulid
  org_id        TEXT NOT NULL REFERENCES core_organizations(id),
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  phone         TEXT NOT NULL,                        -- the other party, +1XXXXXXXXXX
  our_number    TEXT,                                 -- our Twilio number used, +19036899487
  body          TEXT NOT NULL DEFAULT '',
  media_count   INTEGER NOT NULL DEFAULT 0,           -- pictures attached to an incoming text (not stored)
  app_id        TEXT REFERENCES core_apps(id),        -- out: the app that sent it; in: the app it was routed to (NULL = nobody)
  ref           TEXT,                                 -- out: the sending app's own reference (e.g. 'late:2026-10-16:<person>'); in: copied from the text it answers
  reply_to_id   TEXT REFERENCES sms_messages(id),     -- in: the outgoing text this answers (latest one to that phone within 7 days)
  user_id       TEXT REFERENCES core_users(id),       -- the person with this phone on the user list, if any
  route         TEXT,                                 -- in: how it was routed: 'reply' | 'keyword' | 'unrouted'
  keyword       TEXT,                                 -- in: STOP / START / HELP etc. when the text was one
  twilio_sid    TEXT UNIQUE,                          -- SM… id from Twilio
  status        TEXT,                                 -- out: queued / sent / delivered / undelivered / failed; in: received
  error_code    INTEGER,                              -- Twilio error code when not delivered (e.g. 30034, 30007)
  sent_by       TEXT REFERENCES core_users(id),       -- out: who pressed send, when a person did
  handled_at    TEXT,                                 -- in: when the app it was routed to dealt with it (UTC)
  forwarded_at  TEXT,                                 -- in: when it was emailed to FORWARD_TO (UTC)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_sms_phone ON sms_messages(org_id, phone, created_at);
CREATE INDEX ix_sms_app_in ON sms_messages(org_id, app_id, direction, handled_at);
CREATE INDEX ix_sms_created ON sms_messages(org_id, created_at);

-- Per phone number: opted out (texted STOP) or not. Twilio blocks sends to opted-out numbers itself; this lets apps know first.
CREATE TABLE sms_contacts (
  org_id         TEXT NOT NULL REFERENCES core_organizations(id),
  phone          TEXT NOT NULL,
  opted_out_at   TEXT,                                -- NULL = can be texted
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, phone)
);

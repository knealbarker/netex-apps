-- Phone sign-in for people without email (netex-auth, auth.netexcleaners.com).
--  - core_users.phone: the person's mobile number in +1XXXXXXXXXX form. Someone with only a phone number gets a stand-in
--    email '<digits>@phone.netexcleaners.com' (that domain receives no mail), so every app keeps matching users by email.
--  - auth_*: short-lived sign-in state for the text-a-code sign-in. Codes themselves are created and checked by Twilio Verify.
ALTER TABLE core_users ADD COLUMN phone TEXT;
CREATE UNIQUE INDEX ux_users_phone ON core_users(org_id, phone) WHERE phone IS NOT NULL;

-- one sign-in attempt: what Cloudflare Access asked for, and the number once a code was sent
CREATE TABLE auth_requests (
  id            TEXT PRIMARY KEY,          -- random, also the page's form token
  client_id     TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  state         TEXT,
  nonce         TEXT,
  code_challenge TEXT,
  phone         TEXT,
  user_id       TEXT REFERENCES core_users(id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- one-time authorization codes handed to Cloudflare Access (stored as a hash, used once, valid 2 minutes)
CREATE TABLE auth_codes (
  code_hash     TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES auth_requests(id),
  user_id       TEXT NOT NULL REFERENCES core_users(id),
  expires_at    TEXT NOT NULL,
  used_at       TEXT
);

-- texts sent and codes tried, for limits (kept 7 days)
CREATE TABLE auth_events (
  id     TEXT PRIMARY KEY,
  kind   TEXT NOT NULL CHECK (kind IN ('send','check_ok','check_bad','unknown_number')),
  phone  TEXT,
  ip     TEXT,
  at     TEXT NOT NULL
);
CREATE INDEX ix_auth_events_phone ON auth_events(phone, at);
CREATE INDEX ix_auth_events_ip ON auth_events(ip, at);

-- the signing key for the sign-in tokens (made on first use)
CREATE TABLE auth_keys (
  kid          TEXT PRIMARY KEY,
  private_jwk  TEXT NOT NULL,
  public_jwk   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

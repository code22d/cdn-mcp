-- =====================================================================
-- 0002_oauth.sql — OAuth 2.1 + Dynamic Client Registration tables.
-- =====================================================================
-- Phase 11 adds OAuth so claude.ai's modern Custom Connector flow can
-- register a client and exchange an auth code for a Bearer token. The
-- "user" model is single-tenant: anyone who can reach /authorize gets a
-- token. These tables exist to enforce one-time-use auth codes and to
-- support DCR (RFC 7591) so each claude.ai add-attempt gets its own
-- client_id row.
--
-- Tokens themselves (access + refresh) are NOT stored here — they are
-- stateless signed JWTs (HMAC-SHA256, OAUTH_SIGNING_KEY secret). Only
-- short-lived auth codes need replay protection, which is what
-- oauth_auth_codes provides via the `used` flag.
-- =====================================================================

CREATE TABLE oauth_clients (
  client_id       TEXT PRIMARY KEY,    -- random UUID, returned to claude.ai
  client_name     TEXT,                -- optional, from DCR client metadata
  redirect_uris   TEXT NOT NULL,       -- JSON array of strings (RFC 7591)
  client_metadata TEXT,                -- full JSON blob from DCR (audit)
  registered_at   TEXT NOT NULL        -- ISO-8601
);

CREATE TABLE oauth_auth_codes (
  code           TEXT PRIMARY KEY,     -- random hex, ~256 bits of entropy
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,        -- pinned at /authorize time, re-checked at /token
  code_challenge TEXT NOT NULL,        -- S256(verifier), verified at /token
  scope          TEXT NOT NULL,        -- "cdn:full" in v1
  expires_at     TEXT NOT NULL,        -- ISO-8601, 60s after issuance
  used           INTEGER NOT NULL DEFAULT 0  -- 0 = unused, 1 = exchanged (replay guard)
);

CREATE INDEX idx_oauth_auth_codes_expires_at ON oauth_auth_codes(expires_at);

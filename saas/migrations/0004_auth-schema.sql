-- Initial SaaS migration 4: auth-schema.sql
-- Short-lived OAuth browser transactions. Times are Unix milliseconds.
-- State and browser binding are independent 256-bit secrets, stored as digests.
-- Only the PKCE verifier is temporarily recoverable; it is erased on claim.
CREATE TABLE auth_flows (
  state_digest TEXT PRIMARY KEY NOT NULL CHECK(length(state_digest)=64),
  browser_digest TEXT NOT NULL CHECK(length(browser_digest)=64),
  verifier TEXT CHECK(verifier IS NULL OR length(verifier)=43),
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+600000),
  consumed_at INTEGER CHECK(consumed_at IS NULL OR consumed_at>=created_at)
);
CREATE INDEX auth_flows_expiry ON auth_flows(expires_at);

-- Forward SaaS migration 21: domain-retention-schema.sql
-- Completed DNS proofs back immutable verification receipts. Keep that history
-- while allowing bounded expiry cleanup to seek only unused challenges.
CREATE INDEX release_domains_pending_expiry ON release_domain_challenges(expires_at,id)
 WHERE used_at IS NULL;
UPDATE release_meta SET version=21 WHERE version=20;

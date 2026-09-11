-- Index-only forward migration for bounded expiry cleanup. No retained memory
-- or immutable identity/audit rows are deleted by this migration.
CREATE INDEX release_ingests_expiry ON release_ingests(expires_at,id)
 WHERE ciphertext IS NOT NULL OR proposals IS NOT NULL OR state IN ('queued','review','failed');
CREATE INDEX release_exports_expiry ON release_export_sessions(expires_at,id);
CREATE INDEX release_domains_expiry ON release_domain_challenges(expires_at,id);
CREATE INDEX release_reauth_expiry ON release_reauth_challenges(expires_at,id);
CREATE INDEX release_mail_budget_day ON release_mail_budget(day,account_id);

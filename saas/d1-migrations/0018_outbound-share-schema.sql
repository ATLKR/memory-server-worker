-- Forward SaaS migration 18: outbound-share-schema.sql
-- Space managers must be able to recover every issued grant, including older
-- browser credentials and lost responses. Recent grants appear first; revoked
-- and expired records remain discoverable for explicit recovery and auditing.
CREATE INDEX release_shares_space_created ON release_shares(space_id,created_at DESC,id DESC);

UPDATE release_meta SET version=18 WHERE version=17;

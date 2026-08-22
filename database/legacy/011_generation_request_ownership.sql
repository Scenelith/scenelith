-- In self-hosted BYOK mode ownership is recorded directly. There is no Cloud
-- credit reservation table to backfill from on a fresh installation.
ALTER TABLE generations ADD COLUMN requested_by_user_id text REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX generations_requester_updated_idx ON generations(requested_by_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_documents (
  document_name text PRIMARY KEY,
  state bytea NOT NULL,
  graph jsonb NOT NULL,
  summary jsonb NOT NULL,
  revision bigint NOT NULL,
  last_update_id bigint NOT NULL DEFAULT 0,
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collaboration_document_versions (
  document_name text NOT NULL,
  revision bigint NOT NULL,
  state bytea NOT NULL,
  graph jsonb NOT NULL,
  summary jsonb NOT NULL,
  last_update_id bigint NOT NULL DEFAULT 0,
  actor_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_name, revision)
);

CREATE TABLE IF NOT EXISTS collaboration_document_updates (
  id bigserial PRIMARY KEY,
  document_name text NOT NULL,
  update_hash text NOT NULL,
  update bytea NOT NULL,
  actor_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_name, update_hash)
);

CREATE TABLE IF NOT EXISTS collaboration_projection_outbox (
  document_name text PRIMARY KEY,
  revision bigint NOT NULL,
  graph jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collaboration_updates_document_id_idx
  ON collaboration_document_updates (document_name, id);
CREATE INDEX IF NOT EXISTS collaboration_versions_created_idx
  ON collaboration_document_versions (created_at DESC);

INSERT INTO collaboration_projection_outbox (document_name, revision, graph)
  SELECT document_name, revision, graph FROM collaboration_documents
  ON CONFLICT (document_name) DO NOTHING;

CREATE OR REPLACE FUNCTION enqueue_deleted_asset_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deletion_reference text;
  deletion_reason text;
BEGIN
  FOR deletion_reference, deletion_reason IN
    SELECT OLD.storage_path, 'asset-deleted'
    UNION ALL
    SELECT OLD.thumbnail_storage_path, 'asset-thumbnail-deleted'
  LOOP
    IF deletion_reference IS NULL OR deletion_reference = '' THEN
      CONTINUE;
    END IF;
    INSERT INTO storage_deletion_jobs
      (id, workspace_id, storage_reference, reason, status, attempts, max_attempts, available_at, created_at, updated_at)
    VALUES
      ('gc_' || md5(deletion_reference || clock_timestamp()::text || random()::text), OLD.workspace_id,
       deletion_reference, deletion_reason, 'queued', 0, 12, now(), now(), now())
    ON CONFLICT (storage_reference) DO UPDATE SET
      status = CASE WHEN storage_deletion_jobs.status = 'completed' THEN 'queued' ELSE storage_deletion_jobs.status END,
      reason = excluded.reason,
      available_at = LEAST(storage_deletion_jobs.available_at, excluded.available_at),
      updated_at = excluded.updated_at;
  END LOOP;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS assets_enqueue_storage_deletion ON assets;
CREATE TRIGGER assets_enqueue_storage_deletion
AFTER DELETE ON assets
FOR EACH ROW EXECUTE FUNCTION enqueue_deleted_asset_storage();

-- Application and collaboration tables share one PostgreSQL authority. A
-- project deletion therefore retires the CRDT identity in the same database
-- transaction as the relational cascade. Dynamic statements keep the
-- application migration independently bootstrappable before collaboration
-- migrations have created their tables.
CREATE OR REPLACE FUNCTION retire_deleted_project_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_regclass('public.collaboration_document_tombstones') IS NOT NULL THEN
    EXECUTE
      'INSERT INTO collaboration_document_tombstones (document_name, reason) VALUES ($1, ''project-deleted'') ON CONFLICT (document_name) DO NOTHING'
      USING OLD.id;
  END IF;
  IF to_regclass('public.collaboration_projection_outbox') IS NOT NULL THEN
    EXECUTE 'DELETE FROM collaboration_projection_outbox WHERE document_name = $1' USING OLD.id;
  END IF;
  IF to_regclass('public.collaboration_document_updates') IS NOT NULL THEN
    EXECUTE 'DELETE FROM collaboration_document_updates WHERE document_name = $1' USING OLD.id;
  END IF;
  IF to_regclass('public.collaboration_document_versions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM collaboration_document_versions WHERE document_name = $1' USING OLD.id;
  END IF;
  IF to_regclass('public.collaboration_documents') IS NOT NULL THEN
    EXECUTE 'DELETE FROM collaboration_documents WHERE document_name = $1' USING OLD.id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS projects_retire_collaboration_document ON projects;
CREATE TRIGGER projects_retire_collaboration_document
AFTER DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION retire_deleted_project_document();

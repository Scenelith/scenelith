-- Run as the database owner after core migrations. This group cannot log in.
-- Provision a separate LOGIN role through the operator's secret manager, then:
-- GRANT scenelith_media_worker TO <dedicated_login>;
-- Never grant application, generation, commerce or schema-owner roles to that login.
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='scenelith_media_worker') THEN
    CREATE ROLE scenelith_media_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO scenelith_media_worker;
GRANT SELECT ON projects,workspace_members,workspaces,assets,media_job_inputs,media_job_dependencies TO scenelith_media_worker;
GRANT SELECT,UPDATE ON media_jobs,media_workspace_turns TO scenelith_media_worker;
GRANT SELECT,INSERT ON media_asset_analysis TO scenelith_media_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON media_job_objects TO scenelith_media_worker;
GRANT SELECT,INSERT,DELETE ON media_storage_reservations TO scenelith_media_worker;
GRANT SELECT,INSERT,UPDATE ON worker_heartbeats,workspace_storage_usage TO scenelith_media_worker;
GRANT INSERT ON assets TO scenelith_media_worker;
GRANT UPDATE(metadata_json) ON assets TO scenelith_media_worker;

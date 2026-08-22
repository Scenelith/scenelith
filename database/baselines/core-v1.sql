--
-- PostgreSQL database dump
--

-- Dumped from database version 14.16 (Homebrew)
-- Dumped by pg_dump version 14.16 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: enqueue_deleted_asset_storage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_deleted_asset_storage() RETURNS trigger
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


--
-- Name: maintain_workspace_storage_usage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.maintain_workspace_storage_usage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  old_bytes bigint := 0;
  new_bytes bigint := 0;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.workspace_id IS NOT NULL THEN
    old_bytes := COALESCE(OLD.size_bytes, 0) + COALESCE(OLD.thumbnail_size_bytes, 0);
    INSERT INTO workspace_storage_usage (workspace_id, used_bytes, updated_at)
    VALUES (OLD.workspace_id, 0, now())
    ON CONFLICT(workspace_id) DO UPDATE
      SET used_bytes = GREATEST(0, workspace_storage_usage.used_bytes - old_bytes), updated_at = now();
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.workspace_id IS NOT NULL THEN
    new_bytes := COALESCE(NEW.size_bytes, 0) + COALESCE(NEW.thumbnail_size_bytes, 0);
    INSERT INTO workspace_storage_usage (workspace_id, used_bytes, updated_at)
    VALUES (NEW.workspace_id, new_bytes, now())
    ON CONFLICT(workspace_id) DO UPDATE
      SET used_bytes = workspace_storage_usage.used_bytes + new_bytes, updated_at = now();
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_audit_event_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_audit_event_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END;
$$;


--
-- Name: retire_deleted_project_document(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retire_deleted_project_document() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: application_cutovers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_cutovers (
    id text NOT NULL,
    source_kind text NOT NULL,
    source_fingerprint text NOT NULL,
    imported_counts jsonb NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: asset_upload_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_upload_sessions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    purpose text NOT NULL,
    bucket text NOT NULL,
    object_key text NOT NULL,
    storage_reference text NOT NULL,
    upload_id text NOT NULL,
    filename text NOT NULL,
    original_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    part_size integer NOT NULL,
    part_count integer NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    locked_at timestamp with time zone,
    worker_id text,
    last_error text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT asset_upload_sessions_part_count_check CHECK ((part_count > 0)),
    CONSTRAINT asset_upload_sessions_size_bytes_check CHECK ((size_bytes > 0))
);


--
-- Name: assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assets (
    id text NOT NULL,
    workspace_id text,
    project_id text,
    persona_id text,
    kind text NOT NULL,
    role text,
    sort_order integer DEFAULT 0 NOT NULL,
    filename text NOT NULL,
    storage_path text NOT NULL,
    storage_provider text DEFAULT 'local'::text NOT NULL,
    storage_bucket text,
    object_key text,
    size_bytes bigint,
    content_hash text,
    thumbnail_storage_path text,
    thumbnail_size_bytes bigint,
    thumbnail_content_hash text,
    thumbnail_mime_type text,
    mime_type text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id text NOT NULL,
    workspace_id text,
    actor_user_id text,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '400 days'::interval) NOT NULL
);


--
-- Name: auth_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_accounts (
    id text NOT NULL,
    user_id text NOT NULL,
    provider text NOT NULL,
    provider_account_id text NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: auth_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_rate_limits (
    identifier_hash text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    blocked_until timestamp with time zone
);


--
-- Name: generation_dispatch_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generation_dispatch_jobs (
    generation_id text NOT NULL,
    payload_json jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    last_error text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT generation_dispatch_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'dispatching'::text, 'dispatched'::text, 'failed'::text])))
);


--
-- Name: generations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generations (
    id text NOT NULL,
    project_id text NOT NULL,
    node_id text NOT NULL,
    prompt text NOT NULL,
    status text DEFAULT 'created'::text NOT NULL,
    model_id text DEFAULT 'nano-banana-2'::text NOT NULL,
    media_type text DEFAULT 'image'::text NOT NULL,
    provider_path text,
    provider_task_id text,
    output_asset_id text,
    output_url text,
    error text,
    operation text DEFAULT 'generation'::text NOT NULL,
    aspect_ratio text,
    resolution text,
    credit_cost integer DEFAULT 0 NOT NULL,
    reference_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    requested_by_user_id text,
    usage_workspace_id text
);


--
-- Name: hooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hooks (
    id text NOT NULL,
    workspace_id text NOT NULL,
    project_id text,
    parent_hook_id text,
    source_asset_id text,
    source_url text,
    kind text DEFAULT 'original'::text NOT NULL,
    text text NOT NULL,
    angle text DEFAULT ''::text NOT NULL,
    language text DEFAULT ''::text NOT NULL,
    views_count integer DEFAULT 0 NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: operation_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operation_status (
    key text NOT NULL,
    status text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personas (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: project_snapshot_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_snapshot_versions (
    project_id text NOT NULL,
    revision bigint NOT NULL,
    graph_json jsonb NOT NULL,
    summary_json jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT project_snapshot_versions_revision_check CHECK ((revision > 0))
);


--
-- Name: project_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_snapshots (
    project_id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    graph_json jsonb DEFAULT '{"edges": [], "nodes": []}'::jsonb NOT NULL,
    summary_json jsonb DEFAULT '{"scenes": 0, "outputs": 0, "prompts": 0, "previews": []}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    source_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT project_snapshots_revision_check CHECK ((revision > 0)),
    CONSTRAINT project_snapshots_source_revision_check CHECK ((source_revision >= 0))
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    source_url text,
    status text DEFAULT 'draft'::text NOT NULL,
    graph_json jsonb DEFAULT '{"edges": [], "nodes": []}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL
);


--
-- Name: storage_deletion_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_deletion_jobs (
    id text NOT NULL,
    workspace_id text,
    storage_reference text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 12 NOT NULL,
    available_at timestamp with time zone NOT NULL,
    locked_at timestamp with time zone,
    worker_id text,
    last_error text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: tiktok_automation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tiktok_automation_jobs (
    id text NOT NULL,
    user_id text NOT NULL,
    workspace_id text NOT NULL,
    project_id text NOT NULL,
    source_node_id text NOT NULL,
    dedupe_key text NOT NULL,
    request_json jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    stage text DEFAULT 'queued'::text NOT NULL,
    stage_label text DEFAULT 'Waiting for an available planning slot'::text NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    result_json jsonb,
    error text,
    error_code text,
    http_status integer,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 2 NOT NULL,
    available_at timestamp with time zone NOT NULL,
    locked_at timestamp with time zone,
    worker_id text,
    reservation_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT tiktok_automation_jobs_progress_check CHECK (((progress >= 0) AND (progress <= 100))),
    CONSTRAINT tiktok_automation_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: tiktok_planning_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tiktok_planning_runs (
    id text NOT NULL,
    workspace_id text NOT NULL,
    project_id text NOT NULL,
    source_node_id text NOT NULL,
    input_hash text NOT NULL,
    analysis_json jsonb,
    observations_json jsonb,
    intent_json jsonb,
    binding_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    email public.citext NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    password_hash text,
    email_verified_at timestamp with time zone,
    is_admin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: worker_heartbeats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_heartbeats (
    worker_id text NOT NULL,
    worker_role text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    last_error text
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'owner'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text])))
);


--
-- Name: workspace_storage_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_storage_usage (
    workspace_id text NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL,
    reserved_bytes bigint DEFAULT 0 NOT NULL,
    quota_bytes bigint DEFAULT '107374182400'::bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_storage_usage_quota_bytes_check CHECK ((quota_bytes > 0)),
    CONSTRAINT workspace_storage_usage_reserved_bytes_check CHECK ((reserved_bytes >= 0)),
    CONSTRAINT workspace_storage_usage_used_bytes_check CHECK ((used_bytes >= 0))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id text NOT NULL,
    name text NOT NULL,
    role_prompt text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: application_cutovers application_cutovers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_cutovers
    ADD CONSTRAINT application_cutovers_pkey PRIMARY KEY (id);


--
-- Name: asset_upload_sessions asset_upload_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_upload_sessions
    ADD CONSTRAINT asset_upload_sessions_pkey PRIMARY KEY (id);


--
-- Name: assets assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: auth_accounts auth_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);


--
-- Name: auth_accounts auth_accounts_provider_provider_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_provider_provider_account_id_key UNIQUE (provider, provider_account_id);


--
-- Name: auth_rate_limits auth_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (identifier_hash);


--
-- Name: generation_dispatch_jobs generation_dispatch_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_dispatch_jobs
    ADD CONSTRAINT generation_dispatch_jobs_pkey PRIMARY KEY (generation_id);


--
-- Name: generations generations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_pkey PRIMARY KEY (id);


--
-- Name: hooks hooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hooks
    ADD CONSTRAINT hooks_pkey PRIMARY KEY (id);


--
-- Name: operation_status operation_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_status
    ADD CONSTRAINT operation_status_pkey PRIMARY KEY (key);


--
-- Name: personas personas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_pkey PRIMARY KEY (id);


--
-- Name: project_snapshot_versions project_snapshot_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_snapshot_versions
    ADD CONSTRAINT project_snapshot_versions_pkey PRIMARY KEY (project_id, revision);


--
-- Name: project_snapshots project_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_snapshots
    ADD CONSTRAINT project_snapshots_pkey PRIMARY KEY (project_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: storage_deletion_jobs storage_deletion_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletion_jobs
    ADD CONSTRAINT storage_deletion_jobs_pkey PRIMARY KEY (id);


--
-- Name: storage_deletion_jobs storage_deletion_jobs_storage_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletion_jobs
    ADD CONSTRAINT storage_deletion_jobs_storage_reference_key UNIQUE (storage_reference);


--
-- Name: tiktok_automation_jobs tiktok_automation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_automation_jobs
    ADD CONSTRAINT tiktok_automation_jobs_pkey PRIMARY KEY (id);


--
-- Name: tiktok_planning_runs tiktok_planning_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_planning_runs
    ADD CONSTRAINT tiktok_planning_runs_pkey PRIMARY KEY (id);


--
-- Name: tiktok_planning_runs tiktok_planning_runs_workspace_id_input_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_planning_runs
    ADD CONSTRAINT tiktok_planning_runs_workspace_id_input_hash_key UNIQUE (workspace_id, input_hash);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: worker_heartbeats worker_heartbeats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_heartbeats
    ADD CONSTRAINT worker_heartbeats_pkey PRIMARY KEY (worker_id);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: workspace_storage_usage workspace_storage_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_storage_usage
    ADD CONSTRAINT workspace_storage_usage_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: asset_upload_sessions_cleanup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_upload_sessions_cleanup_idx ON public.asset_upload_sessions USING btree (available_at, expires_at) WHERE (status = 'prepared'::text);


--
-- Name: assets_persona_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_persona_order_idx ON public.assets USING btree (persona_id, role, sort_order);


--
-- Name: assets_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_project_idx ON public.assets USING btree (project_id);


--
-- Name: assets_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_workspace_idx ON public.assets USING btree (workspace_id, created_at);


--
-- Name: audit_events_actor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_actor_created_idx ON public.audit_events USING btree (actor_user_id, created_at DESC);


--
-- Name: audit_events_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_expiry_idx ON public.audit_events USING btree (expires_at);


--
-- Name: audit_events_workspace_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_workspace_created_idx ON public.audit_events USING btree (workspace_id, created_at DESC);


--
-- Name: auth_accounts_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_accounts_user_idx ON public.auth_accounts USING btree (user_id);


--
-- Name: generation_dispatch_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generation_dispatch_queue_idx ON public.generation_dispatch_jobs USING btree (status, available_at, created_at);


--
-- Name: generation_dispatch_terminal_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generation_dispatch_terminal_updated_idx ON public.generation_dispatch_jobs USING btree (updated_at) WHERE (status = ANY (ARRAY['dispatched'::text, 'failed'::text]));


--
-- Name: generations_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generations_project_idx ON public.generations USING btree (project_id);


--
-- Name: generations_requester_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generations_requester_updated_idx ON public.generations USING btree (requested_by_user_id, updated_at DESC);


--
-- Name: generations_usage_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generations_usage_workspace_idx ON public.generations USING btree (usage_workspace_id, status);


--
-- Name: hooks_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hooks_workspace_idx ON public.hooks USING btree (workspace_id);


--
-- Name: operation_status_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operation_status_updated_idx ON public.operation_status USING btree (updated_at DESC);


--
-- Name: project_snapshot_versions_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_snapshot_versions_created_idx ON public.project_snapshot_versions USING btree (created_at);


--
-- Name: project_snapshot_versions_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_snapshot_versions_project_idx ON public.project_snapshot_versions USING btree (project_id, revision DESC);


--
-- Name: project_snapshots_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_snapshots_updated_idx ON public.project_snapshots USING btree (updated_at DESC);


--
-- Name: sessions_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expiry_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: storage_deletion_jobs_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_deletion_jobs_ready_idx ON public.storage_deletion_jobs USING btree (available_at, created_at) WHERE (status = 'queued'::text);


--
-- Name: tiktok_automation_jobs_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tiktok_automation_jobs_project_idx ON public.tiktok_automation_jobs USING btree (project_id, created_at DESC);


--
-- Name: tiktok_automation_jobs_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tiktok_automation_jobs_queue_idx ON public.tiktok_automation_jobs USING btree (status, available_at, created_at);


--
-- Name: tiktok_automation_jobs_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tiktok_automation_jobs_user_status_idx ON public.tiktok_automation_jobs USING btree (user_id, status, created_at);


--
-- Name: tiktok_automation_terminal_completed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tiktok_automation_terminal_completed_idx ON public.tiktok_automation_jobs USING btree (completed_at) WHERE (status = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text]));


--
-- Name: tiktok_planning_runs_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tiktok_planning_runs_expires_at_idx ON public.tiktok_planning_runs USING btree (expires_at);


--
-- Name: worker_heartbeats_last_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_heartbeats_last_seen_idx ON public.worker_heartbeats USING btree (last_seen_at);


--
-- Name: workspace_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_members_user_idx ON public.workspace_members USING btree (user_id);


--
-- Name: assets assets_enqueue_storage_deletion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assets_enqueue_storage_deletion AFTER DELETE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.enqueue_deleted_asset_storage();


--
-- Name: assets assets_workspace_storage_usage; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assets_workspace_storage_usage AFTER INSERT OR DELETE OR UPDATE OF workspace_id, size_bytes, thumbnail_size_bytes ON public.assets FOR EACH ROW EXECUTE FUNCTION public.maintain_workspace_storage_usage();


--
-- Name: audit_events audit_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_append_only BEFORE UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_event_update();


--
-- Name: projects projects_retire_collaboration_document; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER projects_retire_collaboration_document AFTER DELETE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.retire_deleted_project_document();


--
-- Name: asset_upload_sessions asset_upload_sessions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_upload_sessions
    ADD CONSTRAINT asset_upload_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: asset_upload_sessions asset_upload_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_upload_sessions
    ADD CONSTRAINT asset_upload_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: asset_upload_sessions asset_upload_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_upload_sessions
    ADD CONSTRAINT asset_upload_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: assets assets_persona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id) ON DELETE CASCADE;


--
-- Name: assets assets_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: assets assets_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: audit_events audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_events audit_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: auth_accounts auth_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: generation_dispatch_jobs generation_dispatch_jobs_generation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_dispatch_jobs
    ADD CONSTRAINT generation_dispatch_jobs_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.generations(id) ON DELETE CASCADE;


--
-- Name: generations generations_output_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_output_asset_id_fkey FOREIGN KEY (output_asset_id) REFERENCES public.assets(id) ON DELETE SET NULL;


--
-- Name: generations generations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: generations generations_requested_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: generations generations_usage_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_usage_workspace_id_fkey FOREIGN KEY (usage_workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: hooks hooks_parent_hook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hooks
    ADD CONSTRAINT hooks_parent_hook_id_fkey FOREIGN KEY (parent_hook_id) REFERENCES public.hooks(id) ON DELETE SET NULL;


--
-- Name: hooks hooks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hooks
    ADD CONSTRAINT hooks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: hooks hooks_source_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hooks
    ADD CONSTRAINT hooks_source_asset_id_fkey FOREIGN KEY (source_asset_id) REFERENCES public.assets(id) ON DELETE SET NULL;


--
-- Name: hooks hooks_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hooks
    ADD CONSTRAINT hooks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: personas personas_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: project_snapshot_versions project_snapshot_versions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_snapshot_versions
    ADD CONSTRAINT project_snapshot_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_snapshots project_snapshots_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_snapshots
    ADD CONSTRAINT project_snapshots_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: storage_deletion_jobs storage_deletion_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletion_jobs
    ADD CONSTRAINT storage_deletion_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: tiktok_automation_jobs tiktok_automation_jobs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_automation_jobs
    ADD CONSTRAINT tiktok_automation_jobs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: tiktok_automation_jobs tiktok_automation_jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_automation_jobs
    ADD CONSTRAINT tiktok_automation_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tiktok_automation_jobs tiktok_automation_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_automation_jobs
    ADD CONSTRAINT tiktok_automation_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: tiktok_planning_runs tiktok_planning_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_planning_runs
    ADD CONSTRAINT tiktok_planning_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: tiktok_planning_runs tiktok_planning_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_planning_runs
    ADD CONSTRAINT tiktok_planning_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_storage_usage workspace_storage_usage_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_storage_usage
    ADD CONSTRAINT workspace_storage_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


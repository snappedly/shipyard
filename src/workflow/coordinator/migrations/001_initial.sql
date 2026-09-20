-- Shipyard coordinator storage schema. Apply with a transaction-capable
-- PostgreSQL client selected by the host; the package does not provision a
-- database or embed credentials.

CREATE TABLE IF NOT EXISTS shipyard_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  item_id TEXT NOT NULL,
  brief_revision INTEGER NOT NULL,
  phase TEXT NOT NULL,
  relevant_revision TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  source_state TEXT,
  brief JSONB NOT NULL,
  policy JSONB NOT NULL,
  status TEXT NOT NULL,
  ignore_reason TEXT,
  job_id TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  payload JSONB
);

CREATE TABLE IF NOT EXISTS shipyard_jobs (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  brief_revision INTEGER NOT NULL,
  phase TEXT NOT NULL,
  relevant_revision TEXT NOT NULL,
  brief JSONB NOT NULL,
  policy JSONB NOT NULL,
  state TEXT NOT NULL,
  control TEXT NOT NULL,
  phase_attempts JSONB NOT NULL,
  repair_batches INTEGER NOT NULL DEFAULT 0,
  follow_ups INTEGER NOT NULL DEFAULT 0,
  infrastructure_retries INTEGER NOT NULL DEFAULT 0,
  infrastructure_retry_limit INTEGER NOT NULL,
  assignments JSONB NOT NULL,
  phase_results JSONB NOT NULL,
  active_assignment_id TEXT,
  latest_observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS shipyard_jobs_identity_idx
  ON shipyard_jobs (repository, item_id, item_kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS shipyard_jobs_key_idx
  ON shipyard_jobs (
    repository,
    item_id,
    brief_revision,
    phase,
    relevant_revision,
    updated_at DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS shipyard_jobs_work_key_idx
  ON shipyard_jobs (
    repository,
    item_id,
    item_kind,
    brief_revision,
    phase,
    relevant_revision
  );

CREATE TABLE IF NOT EXISTS shipyard_dispatches (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES shipyard_jobs(id),
  repository TEXT NOT NULL,
  item_id TEXT NOT NULL,
  brief_revision INTEGER NOT NULL,
  phase TEXT NOT NULL,
  relevant_revision TEXT NOT NULL,
  status TEXT NOT NULL,
  assignment JSONB,
  worker_id TEXT,
  claimed_at BIGINT,
  claim_expires_at BIGINT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS shipyard_effects (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES shipyard_jobs(id),
  kind TEXT NOT NULL,
  marker TEXT NOT NULL,
  payload JSONB,
  status TEXT NOT NULL,
  external_ref JSONB,
  worker_id TEXT,
  fencing_token BIGINT,
  claimed_at BIGINT,
  claim_expires_at BIGINT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (job_id, kind, marker)
);

CREATE TABLE IF NOT EXISTS shipyard_branch_leases (
  resource_key TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES shipyard_jobs(id),
  worker_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL,
  acquired_at BIGINT NOT NULL,
  heartbeat_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS shipyard_branch_leases_branch_idx
  ON shipyard_branch_leases (repository, branch);

CREATE TABLE IF NOT EXISTS shipyard_repository_controls (
  repository TEXT PRIMARY KEY,
  stopped BOOLEAN NOT NULL,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);

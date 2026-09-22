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
  resume_requested BOOLEAN NOT NULL DEFAULT FALSE,
  brief JSONB NOT NULL,
  policy JSONB NOT NULL,
  status TEXT NOT NULL,
  ignore_reason TEXT,
  job_id TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  payload JSONB,
  delivery JSONB
);

ALTER TABLE shipyard_events
  ADD COLUMN IF NOT EXISTS delivery JSONB,
  ADD COLUMN IF NOT EXISTS resume_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS shipyard_jobs (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  brief_revision INTEGER NOT NULL,
  phase TEXT NOT NULL,
  relevant_revision TEXT NOT NULL,
  delivery_repository TEXT,
  delivery_item_id TEXT,
  brief JSONB NOT NULL,
  policy JSONB NOT NULL,
  state TEXT NOT NULL,
  control TEXT NOT NULL,
  phase_attempts JSONB NOT NULL,
  repair_batches INTEGER NOT NULL DEFAULT 0,
  follow_ups INTEGER NOT NULL DEFAULT 0,
  infrastructure_retries INTEGER NOT NULL DEFAULT 0,
  infrastructure_retry_limit INTEGER NOT NULL,
  blocked_evidence JSONB,
  assignments JSONB NOT NULL,
  phase_results JSONB NOT NULL,
  active_assignment_id TEXT,
  latest_observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL
);

ALTER TABLE shipyard_jobs
  ADD COLUMN IF NOT EXISTS delivery_repository TEXT,
  ADD COLUMN IF NOT EXISTS delivery_item_id TEXT,
  ADD COLUMN IF NOT EXISTS blocked_evidence JSONB;

UPDATE shipyard_jobs
SET delivery_repository = COALESCE(delivery_repository, repository),
    delivery_item_id = COALESCE(delivery_item_id, item_id)
WHERE delivery_repository IS NULL OR delivery_item_id IS NULL;

CREATE INDEX IF NOT EXISTS shipyard_jobs_identity_idx
  ON shipyard_jobs (repository, item_id, item_kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS shipyard_deliveries (
  repository TEXT NOT NULL,
  item_id TEXT NOT NULL,
  delivery JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (repository, item_id)
);

-- Pre-delivery-schema jobs were standalone. Give pending dispatches a durable
-- owner before the coordinator attempts to claim their delivery lease.
INSERT INTO shipyard_deliveries (
  repository, item_id, delivery, created_at, updated_at, version
)
SELECT
  j.delivery_repository,
  j.delivery_item_id,
  jsonb_build_object(
    'key', jsonb_build_object('repository', j.delivery_repository, 'itemId', j.delivery_item_id),
    'id', j.delivery_repository || '#' || j.delivery_item_id,
    'mode', CASE WHEN j.item_kind = 'planning-spec' THEN 'planning-spec' ELSE 'standalone' END,
    'root', jsonb_build_object('repository', j.repository, 'itemId', j.item_id, 'kind', j.item_kind),
    'graph', jsonb_build_object(
      'root', jsonb_build_object('repository', j.repository, 'itemId', j.item_id, 'kind', j.item_kind),
      'children', '[]'::jsonb,
      'dependencies', '[]'::jsonb
    ),
    'createdAt', to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(j.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'version', 1
  ),
  j.created_at,
  j.updated_at,
  1
FROM shipyard_jobs j
WHERE j.delivery_repository = j.repository
  AND j.delivery_item_id = j.item_id
ON CONFLICT (repository, item_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS shipyard_delivery_leases (
  resource_key TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  item_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL,
  acquired_at BIGINT NOT NULL,
  heartbeat_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS shipyard_delivery_leases_key_idx
  ON shipyard_delivery_leases (repository, item_id);

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

-- Durable records for triage investigations and bounded repair publication.
-- These records resume phase-specific work; the coordinator ledger remains
-- responsible for job, dispatch, lease, and event state.

CREATE TABLE IF NOT EXISTS shipyard_workflow_phase_records (
  namespace TEXT NOT NULL CHECK (namespace IN ('triage', 'repair-batch')),
  record_key TEXT NOT NULL,
  record JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (namespace, record_key)
);

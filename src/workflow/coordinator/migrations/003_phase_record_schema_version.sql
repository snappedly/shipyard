-- Version phase records without breaking writers from the previous release.
-- The default assigns old-format inserts version 1; code rollback can leave the
-- additive column in place.
ALTER TABLE shipyard_workflow_phase_records
  ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1
  CHECK (schema_version = 1);

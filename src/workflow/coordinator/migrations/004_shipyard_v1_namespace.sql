-- Run after 001-003, with old Shipyard writers stopped. PostgreSQL keeps
-- existing rows and foreign keys when these tables are renamed.

ALTER TABLE IF EXISTS shipyard_events RENAME TO shipyard_v1_events;
ALTER TABLE IF EXISTS shipyard_jobs RENAME TO shipyard_v1_jobs;
ALTER TABLE IF EXISTS shipyard_dispatches RENAME TO shipyard_v1_dispatches;
ALTER TABLE IF EXISTS shipyard_effects RENAME TO shipyard_v1_effects;
ALTER TABLE IF EXISTS shipyard_branch_leases RENAME TO shipyard_v1_branch_leases;
ALTER TABLE IF EXISTS shipyard_repository_controls RENAME TO shipyard_v1_repository_controls;
ALTER TABLE IF EXISTS shipyard_workflow_phase_records RENAME TO shipyard_v1_workflow_phase_records;

ALTER INDEX IF EXISTS shipyard_jobs_identity_idx RENAME TO shipyard_v1_jobs_identity_idx;
ALTER INDEX IF EXISTS shipyard_jobs_key_idx RENAME TO shipyard_v1_jobs_key_idx;
ALTER INDEX IF EXISTS shipyard_jobs_work_key_idx RENAME TO shipyard_v1_jobs_work_key_idx;
ALTER INDEX IF EXISTS shipyard_branch_leases_branch_idx RENAME TO shipyard_v1_branch_leases_branch_idx;

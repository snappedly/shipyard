-- External publication effects owned by a delivery-wide fenced lease.
CREATE TABLE IF NOT EXISTS shipyard_delivery_effects (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  item_id TEXT NOT NULL,
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
  UNIQUE (repository, item_id, kind, marker),
  FOREIGN KEY (repository, item_id)
    REFERENCES shipyard_deliveries (repository, item_id)
);

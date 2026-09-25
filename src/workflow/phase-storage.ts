import type { PostgresQueryClient } from "./coordinator/postgres-storage.js";

export type WorkflowPhaseRecordKind = "triage" | "repair-batch";

/** Persistence shared by workflow phases whose records do not belong in the coordinator ledger. */
export interface WorkflowPhaseRecordStore {
  get(kind: WorkflowPhaseRecordKind, key: string): Promise<unknown | undefined>;
  save(
    kind: "repair-batch",
    key: string,
    record: unknown,
    updatedAt: string,
  ): Promise<void>;
  compareAndSaveTriage(
    key: string,
    expectedRevision: number | undefined,
    record: unknown,
    updatedAt: string,
  ): Promise<boolean>;
}

export interface PostgresWorkflowPhaseRecordStoreOptions {
  readonly client: PostgresQueryClient;
}

/** Stores resumable triage and repair records in the coordinator database. */
export class PostgresWorkflowPhaseRecordStore implements WorkflowPhaseRecordStore {
  private readonly client: PostgresQueryClient;

  constructor(options: PostgresWorkflowPhaseRecordStoreOptions) {
    this.client = options.client;
  }

  async get(
    kind: WorkflowPhaseRecordKind,
    key: string,
  ): Promise<unknown | undefined> {
    const result = await this.client.query<{
      record: unknown;
      schema_version: unknown;
    }>(
      `SELECT record, schema_version
       FROM shipyard_workflow_phase_records
       WHERE namespace = $1 AND record_key = $2`,
      [kind, encodeURIComponent(key)],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (Number(row.schema_version) !== 1) {
      throw new Error(
        `Unsupported ${kind} record schema version: ${String(row.schema_version)}`,
      );
    }
    if (typeof row.record === "string")
      return JSON.parse(row.record) as unknown;
    return row.record;
  }

  async save(
    kind: "repair-batch",
    key: string,
    record: unknown,
    updatedAt: string,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO shipyard_workflow_phase_records
         (namespace, record_key, schema_version, record, updated_at)
       VALUES ($1, $2, 1, $3::jsonb, $4::timestamptz)
       ON CONFLICT (namespace, record_key) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         record = EXCLUDED.record,
         updated_at = EXCLUDED.updated_at`,
      [kind, encodeURIComponent(key), JSON.stringify(record), updatedAt],
    );
  }

  async compareAndSaveTriage(
    key: string,
    expectedRevision: number | undefined,
    record: unknown,
    updatedAt: string,
  ): Promise<boolean> {
    const encodedKey = encodeURIComponent(key);
    const result =
      expectedRevision === undefined
        ? await this.client.query<{ record_key: string }>(
            `INSERT INTO shipyard_workflow_phase_records
               (namespace, record_key, schema_version, record, updated_at)
             VALUES ('triage', $1, 1, $2::jsonb, $3::timestamptz)
             ON CONFLICT (namespace, record_key) DO NOTHING
             RETURNING record_key`,
            [encodedKey, JSON.stringify(record), updatedAt],
          )
        : await this.client.query<{ record_key: string }>(
            `UPDATE shipyard_workflow_phase_records
             SET schema_version = 1, record = $3::jsonb, updated_at = $4::timestamptz
             WHERE namespace = 'triage'
               AND record_key = $1
               AND record->>'revision' = $2
             RETURNING record_key`,
            [
              encodedKey,
              String(expectedRevision),
              JSON.stringify(record),
              updatedAt,
            ],
          );
    return result.rows.length > 0;
  }
}

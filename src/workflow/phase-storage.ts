import type { PostgresQueryClient } from "./coordinator/postgres-storage.js";

export type WorkflowPhaseRecordKind = "triage" | "repair-batch";

/** Persistence shared by workflow phases whose records do not belong in the coordinator ledger. */
export interface WorkflowPhaseRecordStore {
  get<T>(kind: WorkflowPhaseRecordKind, key: string): Promise<T | undefined>;
  save<T>(
    kind: WorkflowPhaseRecordKind,
    key: string,
    record: T,
    updatedAt: string,
  ): Promise<void>;
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

  async get<T>(
    kind: WorkflowPhaseRecordKind,
    key: string,
  ): Promise<T | undefined> {
    const result = await this.client.query<{ record: unknown }>(
      `SELECT record
       FROM shipyard_workflow_phase_records
       WHERE namespace = $1 AND record_key = $2`,
      [kind, encodeURIComponent(key)],
    );
    const record = result.rows[0]?.record;
    if (record === undefined) return undefined;
    if (typeof record === "string") return JSON.parse(record) as T;
    return record as T;
  }

  async save<T>(
    kind: WorkflowPhaseRecordKind,
    key: string,
    record: T,
    updatedAt: string,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO shipyard_workflow_phase_records
         (namespace, record_key, record, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz)
       ON CONFLICT (namespace, record_key) DO UPDATE SET
         record = EXCLUDED.record,
         updated_at = EXCLUDED.updated_at`,
      [kind, encodeURIComponent(key), JSON.stringify(record), updatedAt],
    );
  }
}

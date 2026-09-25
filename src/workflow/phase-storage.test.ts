import { describe, expect, it } from "vitest";
import type { PostgresQueryClient } from "./coordinator/postgres-storage.js";
import { PostgresWorkflowPhaseRecordStore } from "./phase-storage.js";

describe("PostgresWorkflowPhaseRecordStore", () => {
  it("reads versioned records and rejects unsupported schema versions", async () => {
    let schemaVersion: number = 1;
    const query: PostgresQueryClient["query"] = async <
      Row extends Record<string, unknown>,
    >() => ({
      rows: [
        {
          schema_version: schemaVersion,
          record: JSON.stringify({ revision: 3 }),
        } as unknown as Row,
      ],
    });
    const store = new PostgresWorkflowPhaseRecordStore({ client: { query } });

    await expect(store.get("triage", "repo/item")).resolves.toEqual({
      revision: 3,
    });
    schemaVersion = 2;
    await expect(store.get("triage", "repo/item")).rejects.toThrow(
      "Unsupported triage record schema version: 2",
    );
  });

  it("uses revision-checked triage inserts and updates", async () => {
    const statements: { text: string; values: readonly unknown[] }[] = [];
    let match = true;
    const query: PostgresQueryClient["query"] = async <
      Row extends Record<string, unknown>,
    >(
      text: string,
      values?: readonly unknown[],
    ) => {
      statements.push({ text, values: values ?? [] });
      return {
        rows: (match ? [{ record_key: values?.[0] }] : []) as unknown as Row[],
      };
    };
    const store = new PostgresWorkflowPhaseRecordStore({ client: { query } });
    const record = { revision: 4 };

    await expect(
      store.compareAndSaveTriage(
        "repo/item",
        undefined,
        record,
        "2026-09-17T12:00:00.000Z",
      ),
    ).resolves.toBe(true);
    expect(statements[0]?.text).toContain(
      "ON CONFLICT (namespace, record_key) DO NOTHING",
    );
    expect(statements[0]?.values).toEqual([
      "repo%2Fitem",
      JSON.stringify(record),
      "2026-09-17T12:00:00.000Z",
    ]);

    await store.compareAndSaveTriage(
      "repo/item",
      3,
      { revision: 4 },
      "2026-09-17T12:01:00.000Z",
    );
    expect(statements[1]?.text).toContain("record->>'revision' = $2");
    expect(statements[1]?.values[1]).toBe("3");

    match = false;
    await expect(
      store.compareAndSaveTriage(
        "repo/item",
        3,
        { revision: 4 },
        "2026-09-17T12:02:00.000Z",
      ),
    ).resolves.toBe(false);
  });
});

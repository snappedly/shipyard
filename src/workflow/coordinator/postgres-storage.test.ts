import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  PostgresCoordinatorStorage,
  type PostgresQueryClient,
} from "./index.js";

describe("PostgresCoordinatorStorage", () => {
  it("backfills a delivery record for pending pre-upgrade jobs", async () => {
    const migration = await readFile(
      new URL("./migrations/001_initial.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toMatch(
      /INSERT INTO shipyard_deliveries[\s\S]*FROM shipyard_jobs/,
    );
    expect(migration).toContain(
      "'mode', CASE WHEN j.item_kind = 'planning-spec'",
    );
    expect(migration).toContain("ON CONFLICT (repository, item_id) DO NOTHING");
  });
  it("wraps coordinator operations in a transaction and releases pooled clients", async () => {
    const query = vi.fn(
      async (_text: string, _values?: readonly unknown[]) => ({
        rows: [],
      }),
    );
    const release = vi.fn();
    const client: PostgresQueryClient & {
      connect: () => Promise<{ query: typeof query; release: typeof release }>;
    } = {
      query,
      connect: async () => ({ query, release }),
    };
    const storage = new PostgresCoordinatorStorage({ client });

    await expect(storage.transaction(async () => "ok")).resolves.toBe("ok");
    expect(query.mock.calls.map(([text]) => text)).toEqual(["BEGIN", "COMMIT"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and preserves the operation error", async () => {
    const query = vi.fn(async (_text: string) => ({ rows: [] }));
    const storage = new PostgresCoordinatorStorage({ client: { query } });
    const failure = new Error("operation failed");

    await expect(
      storage.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(query.mock.calls.map(([text]) => text)).toEqual([
      "BEGIN",
      "ROLLBACK",
    ]);
  });

  it("locks mutable jobs and absent lease resources inside the transaction", async () => {
    const query = vi.fn(
      async (_text: string, _values?: readonly unknown[]) => ({
        rows: [],
      }),
    );
    const storage = new PostgresCoordinatorStorage({ client: { query } });

    await storage.transaction(async (transaction) => {
      expect(await transaction.getJob("missing")).toBeUndefined();
      await transaction.lockLeaseResource("snappedly/shipyard", "main");
    });

    const statements = query.mock.calls.map(([text]) => text);
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements[2]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[2]?.[1]).toEqual(["snappedly/shipyard\u0000main"]);
  });

  it("uses legacy job identity when excluding busy delivery groups", async () => {
    const query = vi.fn(
      async (_text: string, _values?: readonly unknown[]) => ({ rows: [] }),
    );
    const storage = new PostgresCoordinatorStorage({ client: { query } });

    await storage.transaction((transaction) =>
      transaction.findPendingDispatch("snappedly/shipyard", 0, {
        excludedDeliveryIds: ["snappedly/shipyard#100"],
      }),
    );

    const selection = query.mock.calls.find(([statement]) =>
      statement.includes("FROM shipyard_dispatches"),
    );
    expect(selection?.[0]).toContain(
      "COALESCE(j.delivery_repository, j.repository)",
    );
    expect(selection?.[0]).toContain("COALESCE(j.delivery_item_id, j.item_id)");
    expect(selection?.[1]).toContainEqual(["snappedly/shipyard#100"]);
  });
});

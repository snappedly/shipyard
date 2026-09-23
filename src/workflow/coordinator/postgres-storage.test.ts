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

  it("creates delivery-keyed durable effects with a unique replay identity", async () => {
    const migration = await readFile(
      new URL("./migrations/002_delivery_effects.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS shipyard_delivery_effects",
    );
    expect(migration).toContain("UNIQUE (repository, item_id, kind, marker)");
    expect(migration).toContain(
      "REFERENCES shipyard_deliveries (repository, item_id)",
    );

    const row = {
      id: "effect-1",
      repository: "snappedly/shipyard",
      item_id: "100",
      kind: "github-spec-pull-request",
      marker: "spec:100:pull-request",
      payload: { title: "Spec" },
      status: "succeeded",
      external_ref: { number: 14 },
      worker_id: "worker-a",
      fencing_token: 3,
      claimed_at: 10,
      claim_expires_at: 20,
      error: null,
      created_at: "2026-09-23T10:00:00.000Z",
      updated_at: "2026-09-23T10:00:01.000Z",
    };
    const query = vi.fn(
      async (statement: string, _values?: readonly unknown[]) => ({
        rows: statement.includes("INSERT INTO shipyard_delivery_effects")
          ? [row]
          : statement.includes("SELECT * FROM shipyard_delivery_effects")
            ? [row]
            : [],
      }),
    );
    const storage = new PostgresCoordinatorStorage({
      client: { query: query as unknown as PostgresQueryClient["query"] },
    });
    const input = {
      id: "effect-1",
      key: { repository: "snappedly/shipyard", itemId: "100" },
      kind: "github-spec-pull-request",
      marker: "spec:100:pull-request",
      payload: { title: "Spec" },
      status: "claimed" as const,
      workerId: "worker-a",
      fencingToken: 3,
      claimedAt: 10,
      claimExpiresAt: 20,
      createdAt: "2026-09-23T10:00:00.000Z",
      updatedAt: "2026-09-23T10:00:00.000Z",
    };

    await storage.transaction(async (transaction) => {
      const inserted = await transaction.insertDeliveryEffectIfAbsent(input);
      expect(inserted.inserted).toBe(true);
      expect(inserted.effect.key).toEqual(input.key);
      const existing = await transaction.findDeliveryEffect(
        input.key,
        input.kind,
        input.marker,
      );
      expect(existing?.externalRef).toEqual({ number: 14 });
    });

    expect(query.mock.calls[1]?.[0]).toContain(
      "ON CONFLICT (repository, item_id, kind, marker) DO NOTHING",
    );
    expect(query.mock.calls[1]?.[1]).toEqual([
      "effect-1",
      "snappedly/shipyard",
      "100",
      "github-spec-pull-request",
      "spec:100:pull-request",
      JSON.stringify({ title: "Spec" }),
      "claimed",
      null,
      "worker-a",
      3,
      10,
      20,
      null,
      "2026-09-23T10:00:00.000Z",
      "2026-09-23T10:00:00.000Z",
    ]);
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

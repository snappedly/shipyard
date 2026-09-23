import { describe, expect, it, vi } from "vitest";
import { openPostgresCoordinator } from "./postgres-runtime.js";

describe("bundled PostgreSQL coordinator", () => {
  it("requires a database URL before opening a delivery", async () => {
    const createPool = vi.fn();
    await expect(
      openPostgresCoordinator({ databaseUrl: " ", createPool }),
    ).rejects.toThrow("SHIPYARD_DATABASE_URL is required");
    expect(createPool).not.toHaveBeenCalled();
  });

  it("applies the coordinator schema and closes its pool", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const end = vi.fn(async () => undefined);
    const createPool = vi.fn(() => ({ query, end }));
    const runtime = await openPostgresCoordinator({
      databaseUrl: "postgres://shipyard:test@localhost/shipyard",
      createPool,
    });

    expect(createPool).toHaveBeenCalledWith(
      "postgres://shipyard:test@localhost/shipyard",
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      "CREATE TABLE IF NOT EXISTS shipyard_jobs",
    );
    expect(runtime.coordinator).toBeDefined();
    await runtime.close();
    expect(end).toHaveBeenCalledOnce();
  });

  it("closes the pool when schema initialization fails", async () => {
    const end = vi.fn(async () => undefined);
    await expect(
      openPostgresCoordinator({
        databaseUrl: "postgres://shipyard:test@localhost/shipyard",
        createPool: () => ({
          query: async () => {
            throw new Error("migration failed");
          },
          end,
        }),
      }),
    ).rejects.toThrow("migration failed");
    expect(end).toHaveBeenCalledOnce();
  });
});

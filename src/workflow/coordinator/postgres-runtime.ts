import { readFile } from "node:fs/promises";
import pg from "pg";
import { PostgresCoordinatorStorage } from "./postgres-storage.js";
import { WorkflowCoordinator } from "./index.js";

interface CoordinatorPool {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface OpenPostgresCoordinatorOptions {
  readonly databaseUrl: string;
  /** A test or host-provided pool; production uses `pg.Pool`. */
  readonly createPool?: (databaseUrl: string) => CoordinatorPool;
}

export interface PostgresCoordinatorRuntime {
  readonly coordinator: WorkflowCoordinator;
  close(): Promise<void>;
}

const defaultPool = (databaseUrl: string): CoordinatorPool =>
  new pg.Pool({ connectionString: databaseUrl });

const migrationSql = async (name: string): Promise<string> => {
  const locations = [
    new URL(`./workflow/coordinator/migrations/${name}`, import.meta.url),
    new URL(`./migrations/${name}`, import.meta.url),
  ];
  for (const location of locations) {
    try {
      return await readFile(location, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    `Shipyard coordinator migration ${name} is missing from the package`,
  );
};

/** Open the durable coordinator required by bundled GitHub workflows. */
export const openPostgresCoordinator = async (
  options: OpenPostgresCoordinatorOptions,
): Promise<PostgresCoordinatorRuntime> => {
  const databaseUrl = options.databaseUrl.trim();
  if (databaseUrl.length === 0) {
    throw new Error("SHIPYARD_DATABASE_URL is required for bundled workflows");
  }
  const pool = (options.createPool ?? defaultPool)(databaseUrl);
  try {
    for (const migration of ["001_initial.sql", "002_delivery_effects.sql"]) {
      await pool.query(await migrationSql(migration));
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    coordinator: new WorkflowCoordinator({
      storage: new PostgresCoordinatorStorage({
        client: pool as ConstructorParameters<
          typeof PostgresCoordinatorStorage
        >[0]["client"],
      }),
    }),
    close: () => pool.end(),
  };
};

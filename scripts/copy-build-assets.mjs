#!/usr/bin/env node

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

await rm("dist/templates", { force: true, recursive: true });
await cp("src/templates", "dist/templates", { recursive: true });

const sourceMigrations = "src/workflow/coordinator/migrations";
const targetMigrations = "dist/workflow/coordinator/migrations";
await mkdir(targetMigrations, { recursive: true });

for (const entry of await readdir(sourceMigrations, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".sql")) {
    await cp(
      join(sourceMigrations, entry.name),
      join(targetMigrations, entry.name),
    );
  }
}

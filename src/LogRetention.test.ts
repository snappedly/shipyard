import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { purgeRunLogs } from "./LogRetention.js";

const temporaryDirectories: string[] = [];

const makeRepository = async (): Promise<string> => {
  const repoDir = await mkdtemp(join(tmpdir(), "shipyard-log-retention-"));
  temporaryDirectories.push(repoDir);
  return repoDir;
};

const makeLogDirectory = async (
  repoDir: string,
  name: string,
): Promise<string> => {
  const directory = join(repoDir, ".shipyard", "logs", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "run.log"), name);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("purgeRunLogs", () => {
  it("removes only dated folders strictly older than the retention threshold", async () => {
    const repoDir = await makeRepository();
    await makeLogDirectory(repoDir, "2026-09-13");
    await makeLogDirectory(repoDir, "2026-09-14");
    await makeLogDirectory(repoDir, "2026-09-22");

    const logsDir = join(repoDir, ".shipyard", "logs");
    await mkdir(join(logsDir, "2026-09-31"));
    await mkdir(join(logsDir, "not-a-date"));
    const oldRootLog = join(logsDir, "old.log");
    const retainedRootLog = join(logsDir, "retained.log");
    const unrelatedFile = join(logsDir, "notes.txt");
    await writeFile(oldRootLog, "remove old root-level log");
    await writeFile(retainedRootLog, "keep recent root-level log");
    await writeFile(unrelatedFile, "keep operator notes");
    await utimes(
      oldRootLog,
      new Date(2026, 8, 13, 12, 0, 0),
      new Date(2026, 8, 13, 12, 0, 0),
    );
    await utimes(
      retainedRootLog,
      new Date(2026, 8, 14, 12, 0, 0),
      new Date(2026, 8, 14, 12, 0, 0),
    );
    await utimes(
      unrelatedFile,
      new Date(2026, 8, 1, 12, 0, 0),
      new Date(2026, 8, 1, 12, 0, 0),
    );

    const result = await purgeRunLogs({
      repoDir,
      retentionDays: 8,
      now: new Date(2026, 8, 22, 12, 0, 0),
    });

    expect(result.cutoffDate).toBe("2026-09-14");
    expect(result.scannedDirectories).toBe(3);
    expect(result.removedCount).toBe(2);
    expect(result.removedDirectories).toEqual(["2026-09-13"]);
    expect(result.removedFiles).toEqual(["old.log"]);
    await expect(access(join(logsDir, "2026-09-13"))).rejects.toThrow();
    await expect(access(join(logsDir, "2026-09-14"))).resolves.toBeUndefined();
    await expect(access(oldRootLog)).rejects.toThrow();
    await expect(access(retainedRootLog)).resolves.toBeUndefined();
    await expect(access(unrelatedFile)).resolves.toBeUndefined();
    await expect(access(join(logsDir, "not-a-date"))).resolves.toBeUndefined();
  });

  it("removes dated folders and root-level logs when no retention policy is supplied", async () => {
    const repoDir = await makeRepository();
    await makeLogDirectory(repoDir, "2026-09-14");
    await makeLogDirectory(repoDir, "2026-09-22");
    const logsDir = join(repoDir, ".shipyard", "logs");
    await writeFile(join(logsDir, "audit.log"), "root-level run log");
    await writeFile(join(logsDir, "notes.txt"), "operator notes");

    const result = await purgeRunLogs({
      repoDir,
    });

    expect(result.retentionDays).toBeUndefined();
    expect(result.cutoffDate).toBeUndefined();
    expect(result.removedCount).toBe(3);
    expect(new Set(result.removedDirectories)).toEqual(
      new Set(["2026-09-14", "2026-09-22"]),
    );
    expect(result.removedFiles).toEqual(["audit.log"]);
    await expect(access(join(logsDir, "audit.log"))).rejects.toThrow();
    await expect(access(join(logsDir, "notes.txt"))).resolves.toBeUndefined();
  });

  it("treats a missing logs directory as empty", async () => {
    const repoDir = await makeRepository();
    const result = await purgeRunLogs({ repoDir });

    expect(result.removedCount).toBe(0);
    expect(result.removedDirectories).toEqual([]);
    expect(result.removedFiles).toEqual([]);
  });

  it("rejects invalid retention values", async () => {
    const repoDir = await makeRepository();

    await expect(purgeRunLogs({ repoDir, retentionDays: -1 })).rejects.toThrow(
      "non-negative integer",
    );
    await expect(purgeRunLogs({ repoDir, retentionDays: 1.5 })).rejects.toThrow(
      "non-negative integer",
    );
  });

  it.skipIf(process.platform === "win32")(
    "does not follow symlinked log entries",
    async () => {
      const repoDir = await makeRepository();
      const logsDir = join(repoDir, ".shipyard", "logs");
      const targetDir = join(repoDir, "preserved-log-target");
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, "run.log"), "keep");
      const link = join(logsDir, "2026-09-01");
      await mkdir(logsDir, { recursive: true });
      await symlink(targetDir, link, "dir");
      const fileLink = join(logsDir, "legacy.log");
      await symlink(join(targetDir, "run.log"), fileLink, "file");

      const result = await purgeRunLogs({
        repoDir,
        retentionDays: 8,
        now: new Date(2026, 8, 22, 12, 0, 0),
      });

      expect(result.removedDirectories).toEqual([]);
      expect(result.removedFiles).toEqual([]);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect((await lstat(fileLink)).isSymbolicLink()).toBe(true);
      await expect(access(join(targetDir, "run.log"))).resolves.toBeUndefined();
    },
  );
});

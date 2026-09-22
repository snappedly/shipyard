import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR, LOGS_DIR } from "./runtimeNames.js";

/** The default age threshold for automatic run-log purges. */
export const DEFAULT_LOG_RETENTION_DAYS = 8;

const LOG_DIRECTORY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Build the local calendar date directory used for default run logs. */
export const buildLogDirectoryName = (date: Date = new Date()): string => {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Cannot build a log directory name from an invalid date.");
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const parseLogDirectoryDate = (name: string): Date | undefined => {
  const match = LOG_DIRECTORY_PATTERN.exec(name);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : undefined;
};

const validateRetentionDays = (retentionDays: number): void => {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0) {
    throw new Error("Log retention days must be a non-negative integer.");
  }
};

export interface PurgeRunLogsOptions {
  /** Host repository containing `.shipyard/logs/`. */
  readonly repoDir: string;
  /** Remove run logs strictly older than this many calendar days. Omit to remove every default run log. */
  readonly retentionDays?: number;
  /** Local time used to calculate the cutoff. Primarily useful for tests. */
  readonly now?: Date;
}

export interface PurgeRunLogsResult {
  readonly logsDir: string;
  readonly retentionDays?: number;
  /** Dated directories on or after this local date are retained when age-based purging is used. */
  readonly cutoffDate?: string;
  readonly scannedDirectories: number;
  readonly removedCount: number;
  /** Directory names removed from `logsDir`, without the parent path. */
  readonly removedDirectories: readonly string[];
  /** Root-level log filenames removed from `logsDir`. */
  readonly removedFiles: readonly string[];
}

/**
 * Remove default run logs, either all of them or only those older than an
 * explicit retention threshold.
 *
 * Dated default run-log directories and regular root-level `.log` files inside
 * the managed logs directory are considered. Other files, malformed directory
 * names, and symlink entries are left alone.
 */
export const purgeRunLogs = async (
  options: PurgeRunLogsOptions,
): Promise<PurgeRunLogsResult> => {
  const retentionDays = options.retentionDays;
  if (retentionDays !== undefined) validateRetentionDays(retentionDays);

  const now = options.now ?? new Date();
  if (retentionDays !== undefined && Number.isNaN(now.getTime())) {
    throw new Error("Cannot purge logs using an invalid date.");
  }
  const cutoff =
    retentionDays === undefined
      ? undefined
      : new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - retentionDays,
        );
  const cutoffDate =
    cutoff === undefined ? undefined : buildLogDirectoryName(cutoff);
  const logsDir = join(options.repoDir, CONFIG_DIR, LOGS_DIR);

  let entries;
  try {
    entries = await readdir(logsDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        logsDir,
        ...(retentionDays === undefined ? {} : { retentionDays, cutoffDate }),
        scannedDirectories: 0,
        removedCount: 0,
        removedDirectories: [],
        removedFiles: [],
      };
    }
    throw error;
  }

  const removedDirectories: string[] = [];
  const removedFiles: string[] = [];
  let scannedDirectories = 0;
  for (const entry of entries) {
    const entryPath = join(logsDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".log")) {
      const file = await lstat(entryPath);
      if (file.isFile() && (cutoff === undefined || file.mtime < cutoff)) {
        await rm(entryPath, { force: true });
        removedFiles.push(entry.name);
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    const directoryDate = parseLogDirectoryDate(entry.name);
    if (directoryDate === undefined) continue;
    scannedDirectories += 1;
    if (cutoff !== undefined && directoryDate >= cutoff) continue;

    await rm(entryPath, { recursive: true, force: true });
    removedDirectories.push(entry.name);
  }

  return {
    logsDir,
    ...(retentionDays === undefined ? {} : { retentionDays, cutoffDate }),
    scannedDirectories,
    removedCount: removedDirectories.length + removedFiles.length,
    removedDirectories,
    removedFiles,
  };
};

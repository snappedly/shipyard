import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { Effect } from "effect";
import {
  CopyToWorktreeError,
  CopyToWorktreeTimeoutError,
  withTimeout,
} from "./errors.js";
import {
  assertNoSymlinkComponents,
  resolveSafeRelativePath,
} from "./pathSecurity.js";
import { assertExcludesRepositoryRunner } from "./runnerSecurity.js";

const COPY_TO_WORKTREE_TIMEOUT_MS = 60_000;

/**
 * Returns cp flags for copy-on-write support:
 * - macOS (darwin): `-cR` uses APFS clonefile
 * - Other (Linux, etc.): `-R --reflink=auto` uses GNU coreutils reflink
 */
export const getCopyOnWriteFlags = (platform: string): string[] =>
  platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];

/**
 * Copy files and directories from the host repo root to the worktree root,
 * using copy-on-write when the filesystem supports it.
 * Missing paths are silently skipped.
 */
export const copyToWorktree = (
  paths: string[],
  hostRepoDir: string,
  worktreePath: string,
  timeoutMs?: number,
): Effect.Effect<void, CopyToWorktreeTimeoutError | CopyToWorktreeError> => {
  const effectiveTimeout = timeoutMs ?? COPY_TO_WORKTREE_TIMEOUT_MS;
  return Effect.gen(function* () {
    const cowFlags = getCopyOnWriteFlags(process.platform);
    for (const relativePath of paths) {
      let src: string;
      let dest: string;
      try {
        assertExcludesRepositoryRunner(relativePath);
        src = resolveSafeRelativePath(hostRepoDir, relativePath, "copy path");
        dest = resolveSafeRelativePath(worktreePath, relativePath, "copy path");
      } catch (error) {
        return yield* Effect.fail(
          new CopyToWorktreeError({
            message: `Refusing unsafe copy path ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
            path: relativePath,
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: null,
          }),
        );
      }
      if (!existsSync(src)) {
        continue;
      }
      yield* Effect.tryPromise({
        try: async () => {
          // Do not let a configured copy path follow a repository symlink to
          // an unrelated host file, or write through a symlink in the target
          // worktree.
          await assertNoSymlinkComponents(hostRepoDir, src, "copy source");
          await assertNoSymlinkComponents(worktreePath, dest, "copy target");
        },
        catch: (error) =>
          new CopyToWorktreeError({
            message: `Refusing symlinked copy path ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
            path: relativePath,
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: null,
          }),
      });
      yield* Effect.async<void, CopyToWorktreeError>((resume) => {
        execFile("cp", [...cowFlags, src, dest], (error) => {
          if (error) {
            // Fall back to a regular copy if copy-on-write is not supported
            execFile("cp", ["-R", src, dest], (fallbackError, _, stderr) => {
              if (fallbackError) {
                resume(
                  Effect.fail(
                    new CopyToWorktreeError({
                      message: `Failed to copy ${relativePath} to worktree: ${stderr || fallbackError.message}`,
                      path: relativePath,
                      stderr: stderr || fallbackError.message,
                      exitCode:
                        typeof fallbackError.code === "number"
                          ? fallbackError.code
                          : null,
                    }),
                  ),
                );
              } else {
                resume(Effect.succeed(undefined));
              }
            });
          } else {
            resume(Effect.succeed(undefined));
          }
        });
      });
    }
  }).pipe(
    withTimeout(
      effectiveTimeout,
      () =>
        new CopyToWorktreeTimeoutError({
          message: `Copying files to worktree timed out after ${effectiveTimeout}ms`,
          timeoutMs: effectiveTimeout,
          paths,
        }),
    ),
  );
};

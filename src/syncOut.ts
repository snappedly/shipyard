/**
 * Sync-out: extract changes from an isolated sandbox back to the host.
 *
 * Two-phase approach:
 * 1. Save phase: eagerly save all artifacts (patches, diff, untracked files)
 *    to `.shipyard/patches/<timestamp>/` before attempting to apply.
 * 2. Apply phase: apply from the saved directory.
 *    - On success: clean up the patch directory.
 *    - On failure: preserve the patch directory and print recovery commands.
 *
 * Three-prong extraction within each phase:
 * 1. Committed changes: `git format-patch` + `git am --3way`
 * 2. Uncommitted changes (staged + unstaged): `git diff HEAD` + `git apply`
 * 3. Untracked files: `git ls-files --others` + `copyFileOut` each file
 */

import { constants, existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  chmod,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { Effect } from "effect";
import type { ExecResult, SandboxService } from "./SandboxFactory.js";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { buildRecoveryMessage, type FailedStep } from "./RecoveryMessage.js";
import { SyncError } from "./errors.js";
import { execHostGit as execSafeHostGit } from "./hostGit.js";
import {
  assertNoSymlinkComponents,
  assertSafePathSegment,
  assertSafeGitWorktreePath,
  resolveSafeRelativePath,
} from "./pathSecurity.js";
import { shellQuote } from "./shellQuote.js";
import {
  CONFIG_DIR,
  PATCHES_DIR,
  RUNTIME_NAMESPACE,
  SYNC_BASE_REF,
} from "./runtimeNames.js";
import { assertExcludesRepositoryRunner } from "./runnerSecurity.js";

export { SYNC_BASE_REF } from "./runtimeNames.js";

/**
 * Sandbox-owned ref tracking the last-synced commit. Lives inside the sandbox's
 * git repo (not the host's), survives across `run()` calls on the same handle,
 * and never crosses to the host — sync-out ships commits, not refs. ADR 0017.
 */

/**
 * Execute a command on the host side, returning stdout.
 * Fails with SyncError on non-zero exit.
 */
const execHostGit = (
  args: string[],
  cwd: string,
): Effect.Effect<string, SyncError> =>
  Effect.tryPromise({
    try: () => execSafeHostGit(args, cwd),
    catch: (e) =>
      new SyncError({
        message: `Host command failed: git ${args.join(" ")}\n${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/**
 * Execute a command in the sandbox, failing with SyncError if it exits non-zero.
 */
const execOk = (
  handle: IsolatedSandboxHandle,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<
  { stdout: string; stderr: string; exitCode: number },
  SyncError
> =>
  Effect.tryPromise({
    try: () => handle.exec(command, options),
    catch: (e) =>
      new SyncError({
        message: `Sandbox exec failed: ${command}\n${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            new SyncError({
              message: `Sandbox command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
            }),
          )
        : Effect.succeed(result),
    ),
  );

/**
 * Execute a command in the sandbox, returning the result without failing on non-zero exit.
 */
const execSandbox = (
  handle: IsolatedSandboxHandle,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<
  { stdout: string; stderr: string; exitCode: number },
  SyncError
> =>
  Effect.tryPromise({
    try: () => handle.exec(command, options),
    catch: (e) =>
      new SyncError({
        message: `Sandbox exec failed: ${command}\n${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/**
 * Check if a patch file is empty or header-only.
 * Merge commits produce patches with headers but no diff content.
 * A patch is considered empty if it has no lines starting with "diff --git".
 */
const isEmptyPatch = (patchPath: string): Effect.Effect<boolean, SyncError> =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(patchPath);
      if (info.size === 0) return true;
      const content = await readFile(patchPath, "utf-8");
      return !content.includes("diff --git");
    },
    catch: (e) =>
      new SyncError({
        message: `Failed to check patch ${patchPath}: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/**
 * Generate a YYYYMMDD-HHMMSS timestamp directory name.
 * Appends a counter suffix (-1, -2, ...) if the directory already exists.
 */
const createPatchDir = (
  hostRepoDir: string,
): Effect.Effect<string, SyncError> =>
  Effect.tryPromise({
    try: async () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      const patchesRoot = join(hostRepoDir, CONFIG_DIR, PATCHES_DIR);
      await assertNoSymlinkComponents(
        hostRepoDir,
        patchesRoot,
        "patch directory",
      );
      await mkdir(patchesRoot, { recursive: true, mode: 0o700 });
      await assertNoSymlinkComponents(
        hostRepoDir,
        patchesRoot,
        "patch directory",
      );

      let dirName = base;
      let counter = 0;
      while (existsSync(join(patchesRoot, dirName))) {
        counter++;
        dirName = `${base}-${counter}`;
      }

      const patchDir = join(patchesRoot, dirName);
      await mkdir(patchDir, { recursive: true, mode: 0o700 });
      // The directory may be replaced between mkdir and the first artifact
      // write. Validate it from the trusted repository root as well as the
      // patches root so a raced symlink cannot redirect saved artifacts.
      await assertNoSymlinkComponents(hostRepoDir, patchDir, "patch directory");
      return patchDir;
    },
    catch: (e) =>
      new SyncError({
        message: `Failed to create patch directory: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/**
 * Count commits that `syncOut` would emit on the next run. Uses the same base
 * resolution as `syncOut` itself so the pre-flight count and the actual sync
 * stay in lockstep — SandboxLifecycle calls this to label "Syncing N commits
 * to host" without re-implementing the ref fallback.
 *
 * Degrades to 0 (rather than throwing) when either git command fails, matching
 * the prior inline behaviour at the call site. A missing sync-base ref is a
 * normal first-run state, so the rev-parse failure path falls back to hostHead.
 */
export const countCommitsToSync = (
  sandbox: SandboxService,
  cwd: string,
  hostHead: string,
): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const baseResult = yield* sandbox
      .exec(`git rev-parse --verify --quiet ${shellQuote(SYNC_BASE_REF)}`, {
        cwd,
      })
      .pipe(
        Effect.catchAll(() =>
          Effect.succeed<ExecResult>({
            stdout: "",
            stderr: "",
            exitCode: 1,
          }),
        ),
      );
    const base =
      baseResult.exitCode === 0 && baseResult.stdout.trim().length > 0
        ? baseResult.stdout.trim()
        : hostHead;
    const countResult = yield* sandbox
      .exec(`git rev-list ${shellQuote(`${base}..HEAD`)} --count`, { cwd })
      .pipe(
        Effect.catchAll(() =>
          Effect.succeed<ExecResult>({
            stdout: "0",
            stderr: "",
            exitCode: 1,
          }),
        ),
      );
    if (countResult.exitCode !== 0) return 0;
    const parsed = parseInt(countResult.stdout.trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });

/**
 * Sync changes from an isolated sandbox back to the host repo.
 *
 * Two-phase extraction with artifact persistence:
 * 1. Save all artifacts to `.shipyard/patches/<timestamp>/`
 * 2. Apply from saved directory; on failure, preserve artifacts and print recovery
 */
export const syncOut = (
  hostRepoDir: string,
  handle: IsolatedSandboxHandle,
): Effect.Effect<void, SyncError> =>
  Effect.gen(function* () {
    const worktreePath = handle.worktreePath;

    const hostHead = (yield* execHostGit(
      ["rev-parse", "HEAD"],
      hostRepoDir,
    )).trim();
    const sandboxHead = (yield* execOk(handle, "git rev-parse HEAD", {
      cwd: worktreePath,
    })).stdout.trim();

    // Resolve the format-patch base from a sandbox-owned ref. `git am` rewrites
    // host SHAs, so after run 1 the host HEAD is unknown to the sandbox; the
    // ref pins the last commit we actually shipped. Absent on run 1 — and that
    // is the only run where host HEAD is still a valid base (sync-in just
    // copied it in). The two conditions are coupled. See ADR 0017.
    const baseRefResult = yield* execSandbox(
      handle,
      `git rev-parse --verify --quiet ${shellQuote(SYNC_BASE_REF)}`,
      { cwd: worktreePath },
    );
    const base =
      baseRefResult.exitCode === 0 && baseRefResult.stdout.trim().length > 0
        ? baseRefResult.stdout.trim()
        : hostHead;

    const hasCommits = base !== sandboxHead;

    // Check for uncommitted changes
    const diffResult = yield* execOk(handle, "git diff --binary HEAD", {
      cwd: worktreePath,
    }).pipe(
      Effect.mapError(
        (error) =>
          new SyncError({
            message: `Failed to inspect sandbox diff: ${error.message}`,
          }),
      ),
    );
    const hasDiff = diffResult.stdout.trim().length > 0;

    // Check for untracked files
    const lsFilesResult = yield* execOk(
      handle,
      "git ls-files --others --exclude-standard -z",
      { cwd: worktreePath },
    ).pipe(
      Effect.mapError(
        (error) =>
          new SyncError({
            message: `Failed to inspect sandbox untracked files: ${error.message}`,
          }),
      ),
    );
    const hasUntracked = lsFilesResult.stdout.length > 0;

    const untrackedFiles = hasUntracked
      ? lsFilesResult.stdout.split("\0").filter((f) => f.length > 0)
      : [];

    yield* Effect.try({
      try: () =>
        untrackedFiles.forEach((path) => {
          assertSafeGitWorktreePath(path);
          assertExcludesRepositoryRunner(path);
        }),
      catch: (error) => new SyncError({ message: String(error) }),
    });

    const changedPaths: string[] = [];
    if (hasCommits) {
      const committedNames = yield* execOk(
        handle,
        `git diff --name-only -z ${shellQuote(`${base}..HEAD`)}`,
        { cwd: worktreePath },
      );
      changedPaths.push(
        ...committedNames.stdout.split("\0").filter((path) => path.length > 0),
      );
    }
    if (hasDiff) {
      const uncommittedNames = yield* execOk(
        handle,
        "git diff --name-only -z HEAD",
        { cwd: worktreePath },
      );
      changedPaths.push(
        ...uncommittedNames.stdout
          .split("\0")
          .filter((path) => path.length > 0),
      );
    }
    yield* Effect.try({
      try: () => changedPaths.forEach(assertExcludesRepositoryRunner),
      catch: (error) => new SyncError({ message: String(error) }),
    });

    // Nothing to sync
    if (!hasCommits && !hasDiff && !hasUntracked) {
      return;
    }

    // --- Phase 1: Save all artifacts ---
    const patchDir = yield* createPatchDir(hostRepoDir);
    const relativePatchDir = join(CONFIG_DIR, PATCHES_DIR, basename(patchDir));

    const nonEmptyPatches: string[] = [];

    // Save committed patches
    if (hasCommits) {
      const mkTempResult = yield* execOk(
        handle,
        `mktemp -d -t ${RUNTIME_NAMESPACE}-patches-XXXXXX`,
      );
      const sandboxPatchDir = mkTempResult.stdout.trim();

      try {
        yield* execOk(
          handle,
          `git format-patch ${shellQuote(`${base}..HEAD`)} -o ${shellQuote(sandboxPatchDir)}`,
          { cwd: worktreePath },
        );

        const lsResult = yield* execOk(
          handle,
          `find ${shellQuote(sandboxPatchDir)} -maxdepth 1 -type f -print0`,
        );
        const patchPaths = lsResult.stdout
          .split("\0")
          .filter((path) => path.length > 0)
          .sort((left, right) => left.localeCompare(right));
        const patchPrefix = `${sandboxPatchDir.replace(/\/+$/, "")}/`;

        for (const sandboxPatchPath of patchPaths) {
          if (!sandboxPatchPath.startsWith(patchPrefix)) {
            return yield* Effect.fail(
              new SyncError({
                message: `Sandbox returned a patch outside its patch directory: ${sandboxPatchPath}`,
              }),
            );
          }
          const patchName = sandboxPatchPath.slice(patchPrefix.length);
          try {
            assertSafePathSegment(patchName, "patch filename");
          } catch (error) {
            return yield* Effect.fail(
              new SyncError({
                message: `Refusing unsafe patch filename ${patchName}: ${error instanceof Error ? error.message : String(error)}`,
              }),
            );
          }
          const hostPatchPath = join(patchDir, patchName);
          yield* Effect.tryPromise({
            try: async () => {
              await assertNoSymlinkComponents(
                hostRepoDir,
                hostPatchPath,
                "patch path",
              );
              await handle.copyFileOut(sandboxPatchPath, hostPatchPath);
              await assertNoSymlinkComponents(
                hostRepoDir,
                hostPatchPath,
                "patch path",
              );
            },
            catch: (e) =>
              new SyncError({
                message: `Failed to copy patch ${patchName}: ${e instanceof Error ? e.message : String(e)}`,
              }),
          });

          if (!(yield* isEmptyPatch(hostPatchPath))) {
            nonEmptyPatches.push(hostPatchPath);
          }
        }
      } finally {
        yield* execSandbox(handle, `rm -rf ${shellQuote(sandboxPatchDir)}`);
      }
    }

    // Save uncommitted diff
    if (hasDiff) {
      const diffPath = join(patchDir, "changes.patch");
      yield* Effect.tryPromise({
        try: async () => {
          await assertNoSymlinkComponents(hostRepoDir, diffPath, "diff patch");
          await writeFile(diffPath, diffResult.stdout, { mode: 0o600 });
          await chmod(diffPath, 0o600);
        },
        catch: (e) =>
          new SyncError({
            message: `Failed to write diff patch: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
    }

    // Save untracked files
    if (hasUntracked) {
      const untrackedDir = join(patchDir, "untracked");
      for (const relPath of untrackedFiles) {
        let hostFilePath: string;
        try {
          assertSafeGitWorktreePath(relPath);
          hostFilePath = resolveSafeRelativePath(
            untrackedDir,
            relPath,
            "untracked path",
          );
        } catch (error) {
          return yield* Effect.fail(
            new SyncError({
              message: `Refusing unsafe untracked path ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
            }),
          );
        }
        const sandboxFilePath = posix.join(worktreePath, relPath);
        const quotedSandboxFilePath = shellQuote(sandboxFilePath);
        const modeResult = yield* execOk(
          handle,
          `mode=$(stat -c '%a' -- ${quotedSandboxFilePath} 2>/dev/null || stat -f '%Lp' ${quotedSandboxFilePath}) && printf '%s\\n' "$mode"`,
        );
        const sandboxMode = Number.parseInt(modeResult.stdout.trim(), 8);
        if (!Number.isInteger(sandboxMode) || sandboxMode < 0) {
          return yield* Effect.fail(
            new SyncError({
              message: `Failed to read mode for untracked file ${relPath}`,
            }),
          );
        }
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(hostFilePath), {
              recursive: true,
              mode: 0o700,
            });
            await assertNoSymlinkComponents(
              hostRepoDir,
              hostFilePath,
              "untracked path",
            );
            await handle.copyFileOut(sandboxFilePath, hostFilePath);
            await chmod(hostFilePath, sandboxMode & 0o777);
            await assertNoSymlinkComponents(
              hostRepoDir,
              hostFilePath,
              "untracked path",
            );
          },
          catch: (e) =>
            new SyncError({
              message: `Failed to save untracked file ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
            }),
        });
      }
    }

    // --- Phase 2: Apply from saved directory ---
    let failedStep: FailedStep | undefined;

    // Apply committed patches
    if (nonEmptyPatches.length > 0) {
      const abortResult = yield* Effect.either(
        execHostGit(["am", "--abort"], hostRepoDir),
      );
      void abortResult; // ignore abort failures
      const applyResult = yield* Effect.either(
        execHostGit(["am", "--3way", ...nonEmptyPatches], hostRepoDir),
      );
      if (applyResult._tag === "Left") {
        failedStep = "commits";
      }
    }

    // Apply uncommitted diff
    if (!failedStep && hasDiff) {
      const diffPath = join(patchDir, "changes.patch");
      const applyResult = yield* Effect.either(
        execHostGit(["apply", diffPath], hostRepoDir),
      );
      if (applyResult._tag === "Left") {
        failedStep = "diff";
      }
    }

    // Copy untracked files
    if (!failedStep && hasUntracked) {
      const copyResult = yield* Effect.either(
        Effect.tryPromise({
          try: async () => {
            const untrackedDir = join(patchDir, "untracked");
            for (const relPath of untrackedFiles) {
              const srcPath = resolveSafeRelativePath(
                untrackedDir,
                relPath,
                "untracked path",
              );
              const destPath = resolveSafeRelativePath(
                hostRepoDir,
                relPath,
                "untracked path",
              );
              await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
              await assertNoSymlinkComponents(
                hostRepoDir,
                srcPath,
                "saved untracked path",
              );
              await assertNoSymlinkComponents(
                hostRepoDir,
                destPath,
                "untracked path",
              );
              const sourceMode = (await stat(srcPath)).mode & 0o777;
              await copyFile(srcPath, destPath, constants.COPYFILE_EXCL);
              await chmod(destPath, sourceMode);
            }
          },
          catch: (e) =>
            new SyncError({
              message: `Failed to copy untracked files: ${e instanceof Error ? e.message : String(e)}`,
            }),
        }),
      );
      if (copyResult._tag === "Left") {
        failedStep = "untracked";
      }
    }

    // Advance the sync-base ref whenever commits were actually shipped (or
    // there were none new to ship in this slice). Skipped only when `git am`
    // itself failed — those commits never landed on the host, and the next
    // run must retry from the same base. Diff/untracked failures don't undo
    // the commits that already landed; the ref must move so we don't re-emit.
    if (hasCommits && failedStep !== "commits") {
      yield* execOk(
        handle,
        `git update-ref ${shellQuote(SYNC_BASE_REF)} ${shellQuote(sandboxHead)}`,
        {
          cwd: worktreePath,
        },
      );
    }

    // --- Cleanup or preserve ---
    if (failedStep) {
      const msg = buildRecoveryMessage({
        patchDir: relativePatchDir,
        failedStep,
        hasCommits: nonEmptyPatches.length > 0,
        hasDiff,
        hasUntracked,
      });
      console.error(`\n${msg}`);
      const description =
        failedStep === "commits"
          ? "committed changes"
          : failedStep === "diff"
            ? "uncommitted changes"
            : "untracked files";
      return yield* Effect.fail(
        new SyncError({
          message: `Failed to sync ${description}; recovery artifacts preserved at ${relativePatchDir}`,
        }),
      );
    } else {
      yield* Effect.tryPromise({
        try: async () => {
          await assertNoSymlinkComponents(
            hostRepoDir,
            patchDir,
            "patch directory",
          );
          await rm(patchDir, { recursive: true, force: true });
          const patchesRoot = join(hostRepoDir, CONFIG_DIR, PATCHES_DIR);
          try {
            const remaining = await readdir(patchesRoot);
            if (remaining.length === 0) {
              await assertNoSymlinkComponents(
                hostRepoDir,
                patchesRoot,
                "patch directory",
              );
              await rm(patchesRoot, {
                recursive: true,
                force: true,
              });
            }
          } catch {
            // ignore
          }
        },
        catch: () =>
          new SyncError({ message: "Failed to clean up patch directory" }),
      });
    }
  });

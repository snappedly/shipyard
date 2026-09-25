/**
 * Sync-in: transfer a host git repo into an isolated sandbox via git bundle.
 *
 * Creates a git bundle capturing all refs from the host repo,
 * copies it into the sandbox via the provider's copyIn, and
 * clones from the bundle inside the sandbox.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { SyncError } from "./errors.js";
import { CONFIG_DIR, RUNNER_DIR, RUNTIME_NAMESPACE } from "./runtimeNames.js";
import { shellQuote } from "./shellQuote.js";
import { execHostGit, execOk } from "./syncCommands.js";

/**
 * Sync a host git repo into an isolated sandbox.
 *
 * 1. `git bundle create --all` on the host
 * 2. `copyIn` the bundle to the sandbox
 * 3. `git clone` from the bundle inside the sandbox
 * 4. Verify HEAD matches
 *
 * @returns The branch name that was checked out
 */
export const syncIn = (
  hostRepoDir: string,
  handle: IsolatedSandboxHandle,
): Effect.Effect<{ branch: string }, SyncError> =>
  Effect.gen(function* () {
    const protectedRunnerPath = `${CONFIG_DIR}/${RUNNER_DIR}`;
    const runnerObjects = yield* execHostGit(
      ["rev-list", "--objects", "--all", "--", protectedRunnerPath],
      hostRepoDir,
    );
    if (runnerObjects.trim().length > 0) {
      return yield* Effect.fail(
        new SyncError({
          message: `Refusing to copy repository history into the sandbox because it contains protected repository runner files under ${protectedRunnerPath}. Remove those files from all refs before retrying.`,
        }),
      );
    }

    // Get current branch from host
    const branch = (yield* execHostGit(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      hostRepoDir,
    )).trim();

    // Create git bundle on host capturing all refs
    const bundleDir = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), `${RUNTIME_NAMESPACE}-bundle-`)),
      catch: (e) =>
        new SyncError({
          message: `Failed to create temp dir: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });
    const bundleHostPath = join(bundleDir, "repo.bundle");

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* execHostGit(
          ["bundle", "create", bundleHostPath, "--all"],
          hostRepoDir,
        );

        // Create temp dir in sandbox and copy bundle in
        const mkTempResult = yield* execOk(
          handle,
          `mktemp -d -t ${RUNTIME_NAMESPACE}-XXXXXX`,
        );
        const sandboxTmpDir = mkTempResult.stdout.trim();
        const bundleSandboxPath = `${sandboxTmpDir}/repo.bundle`;

        yield* Effect.tryPromise({
          try: () => handle.copyIn(bundleHostPath, bundleSandboxPath),
          catch: (e) =>
            new SyncError({
              message: `Failed to copy bundle into sandbox: ${e instanceof Error ? e.message : String(e)}`,
            }),
        });

        // Clone from bundle into the worktree
        const worktreePath = handle.worktreePath;
        yield* execOk(
          handle,
          `git clone ${shellQuote(bundleSandboxPath)} ${shellQuote(`${worktreePath}_clone`)}`,
        );

        // Move contents from clone into worktree (git clone requires empty target)
        yield* execOk(
          handle,
          `rm -rf ${shellQuote(worktreePath)} && mv ${shellQuote(`${worktreePath}_clone`)} ${shellQuote(worktreePath)}`,
        );

        // Checkout the correct branch
        yield* execOk(handle, `git checkout ${shellQuote(branch)}`, {
          cwd: worktreePath,
        });

        // Clean up sandbox temp files
        yield* Effect.tryPromise({
          try: () => handle.exec(`rm -rf ${shellQuote(sandboxTmpDir)}`),
          catch: () =>
            new SyncError({ message: "Failed to clean up sandbox temp dir" }),
        });

        // Verify sync succeeded
        const hostHead = (yield* execHostGit(
          ["rev-parse", "HEAD"],
          hostRepoDir,
        )).trim();
        const sandboxHead = (yield* execOk(handle, "git rev-parse HEAD", {
          cwd: worktreePath,
        })).stdout.trim();

        if (hostHead !== sandboxHead) {
          yield* Effect.fail(
            new SyncError({
              message: `HEAD mismatch after sync-in: host=${hostHead} sandbox=${sandboxHead}`,
            }),
          );
        }
      }),
      // Clean up host-side bundle temp dir (runs regardless of success/failure)
      Effect.promise(() => rm(bundleDir, { recursive: true, force: true })),
    );

    return { branch };
  });

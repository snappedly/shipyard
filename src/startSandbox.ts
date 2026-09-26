import { Effect } from "effect";
import { existsSync } from "node:fs";
import { posix } from "node:path";
import {
  ContainerStartTimeoutError,
  CopyToWorktreeTimeoutError,
  SyncError,
  SyncInTimeoutError,
  WorktreeError,
  withTimeout,
  type DockerError,
} from "./errors.js";
import type {
  IsolatedSandboxProvider,
  IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import {
  type SandboxService,
  makeSandboxFromHandle,
} from "./SandboxFactory.js";
import { syncIn } from "./syncIn.js";
import {
  assertNoSymlinkComponents,
  resolveSafeRelativePath,
} from "./pathSecurity.js";
import { assertExcludesRepositoryRunner } from "./runnerSecurity.js";

export interface StartSandboxOptions {
  readonly sourceRepoDir?: string;
  /** Source for selected files; defaults to the original repository. */
  readonly copySourceDir?: string;
  readonly provider: IsolatedSandboxProvider;
  readonly hostRepoDir: string;
  readonly env: Record<string, string>;
  readonly copyPaths?: string[];
  readonly copyTimeoutMs?: number;
}

export interface StartSandboxResult {
  readonly handle: IsolatedSandboxHandle;
  readonly sandbox: SandboxService;
  readonly worktreePath: string;
  /** Inputs copied after Git sync; untracked copies are not task output. */
  readonly copiedPaths: readonly string[];
}

const CONTAINER_START_TIMEOUT_MS = 120_000;
const SYNC_IN_TIMEOUT_MS = 120_000;
export const COPY_PATHS_TIMEOUT_MS = 60_000;

export const startSandbox = (
  options: StartSandboxOptions,
): Effect.Effect<
  StartSandboxResult,
  | DockerError
  | WorktreeError
  | SyncError
  | ContainerStartTimeoutError
  | SyncInTimeoutError
  | CopyToWorktreeTimeoutError
> =>
  Effect.gen(function* () {
    const handle = yield* Effect.tryPromise({
      try: () =>
        options.provider.create({
          env: options.env,
          hostRepoPath: options.sourceRepoDir ?? options.hostRepoDir,
        }),
      catch: (e) =>
        new WorktreeError({
          message: `Isolated provider '${options.provider.name}' setup failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }).pipe(
      withTimeout(
        CONTAINER_START_TIMEOUT_MS,
        () =>
          new ContainerStartTimeoutError({
            message: `Isolated sandbox container start timed out after ${CONTAINER_START_TIMEOUT_MS}ms`,
            timeoutMs: CONTAINER_START_TIMEOUT_MS,
          }),
      ),
    );

    return yield* Effect.gen(function* () {
      yield* syncIn(options.hostRepoDir, handle).pipe(
        withTimeout(
          SYNC_IN_TIMEOUT_MS,
          () =>
            new SyncInTimeoutError({
              message: `Sync-in timed out after ${SYNC_IN_TIMEOUT_MS}ms`,
              timeoutMs: SYNC_IN_TIMEOUT_MS,
            }),
        ),
      );

      const copiedPaths: string[] = [];
      if (options.copyPaths && options.copyPaths.length > 0) {
        const pathsToCopy = options.copyPaths;
        const copySourceDir =
          options.copySourceDir ?? options.sourceRepoDir ?? options.hostRepoDir;
        const copyTimeoutMs = options.copyTimeoutMs ?? COPY_PATHS_TIMEOUT_MS;
        yield* Effect.gen(function* () {
          for (const relativePath of pathsToCopy) {
            let hostPath: string;
            let sandboxPath: string;
            try {
              assertExcludesRepositoryRunner(relativePath);
              hostPath = resolveSafeRelativePath(
                copySourceDir,
                relativePath,
                "copy path",
              );
              resolveSafeRelativePath(
                handle.worktreePath,
                relativePath,
                "copy path",
              );
              // Sandbox paths are POSIX even when Shipyard is running on Windows.
              sandboxPath = posix.join(handle.worktreePath, relativePath);
            } catch (error) {
              return yield* Effect.fail(
                new WorktreeError({
                  message: `Refusing unsafe copy path ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
                }),
              );
            }
            if (!existsSync(hostPath)) {
              continue;
            }
            yield* Effect.tryPromise({
              try: async () => {
                await assertNoSymlinkComponents(
                  copySourceDir,
                  hostPath,
                  "copy source",
                );
              },
              catch: (error) =>
                new WorktreeError({
                  message: `Refusing symlinked copy path ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
                }),
            });
            yield* Effect.tryPromise({
              try: () => handle.copyIn(hostPath, sandboxPath),
              catch: (e) =>
                new WorktreeError({
                  message: `Failed to copy ${relativePath} into sandbox: ${e instanceof Error ? e.message : String(e)}`,
                }),
            });
            copiedPaths.push(relativePath);
          }
        }).pipe(
          withTimeout(
            copyTimeoutMs,
            () =>
              new CopyToWorktreeTimeoutError({
                message: `Copying paths to sandbox timed out after ${copyTimeoutMs}ms`,
                timeoutMs: copyTimeoutMs,
                paths: pathsToCopy,
              }),
          ),
        );
      }

      return {
        handle,
        sandbox: makeSandboxFromHandle(handle),
        worktreePath: handle.worktreePath,
        copiedPaths,
      };
    }).pipe(Effect.onError(() => Effect.promise(() => handle.close())));
  });

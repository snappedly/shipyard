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
  SandboxProvider,
  BindMountSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxProvider,
  IsolatedSandboxHandle,
  NoSandboxProvider,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import {
  type SandboxService,
  type MountEntry,
  makeSandboxFromHandle,
  SANDBOX_REPO_DIR,
} from "./SandboxFactory.js";
import { syncIn } from "./syncIn.js";
import { normalizeMounts } from "./mountUtils.js";
import {
  assertNoSymlinkComponents,
  resolveSafeRelativePath,
} from "./pathSecurity.js";

export interface StartSandboxBindMountOptions {
  provider: BindMountSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  worktreeOrRepoPath: string;
  gitMounts: MountEntry[];
  repoDir: string;
  copyPaths?: undefined;
}

export interface StartSandboxIsolatedOptions {
  /** Original repository for image naming and configured copy paths. */
  sourceRepoDir?: string;
  provider: IsolatedSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  worktreeOrRepoPath?: undefined;
  gitMounts?: undefined;
  repoDir?: undefined;
  copyPaths?: string[];
}

export interface StartSandboxNoSandboxOptions {
  provider: NoSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  /** Host-side worktree path the agent will run in. Equal to hostRepoDir in head mode. */
  worktreeOrRepoPath: string;
  gitMounts?: undefined;
  repoDir?: undefined;
  copyPaths?: undefined;
}

export type StartSandboxOptions =
  | StartSandboxBindMountOptions
  | StartSandboxIsolatedOptions
  | StartSandboxNoSandboxOptions;

export interface StartSandboxResult {
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle;
  sandbox: SandboxService;
  worktreePath: string;
}

const CONTAINER_START_TIMEOUT_MS = 120_000;
const SYNC_IN_TIMEOUT_MS = 120_000;
export const COPY_PATHS_TIMEOUT_MS = 120_000;

/**
 * Start a sandbox by dispatching on `provider.tag`.
 *
 * - `"bind-mount"`: creates mounts and delegates to the provider's `create()`.
 * - `"isolated"`: creates handle, syncs host repo via git bundle, then copies
 *   optional `copyPaths` via `handle.copyIn()`.
 *
 * Returns the handle, a `SandboxService` layer, and the worktree path.
 */
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
> => {
  if (options.provider.tag === "bind-mount") {
    return startBindMountSandbox(options as StartSandboxBindMountOptions);
  }
  if (options.provider.tag === "none") {
    return startNoSandbox(options as StartSandboxNoSandboxOptions);
  }
  return startIsolatedSandbox(options as StartSandboxIsolatedOptions);
};

const startNoSandbox = (
  options: StartSandboxNoSandboxOptions,
): Effect.Effect<StartSandboxResult, WorktreeError> =>
  Effect.tryPromise({
    try: () =>
      options.provider.create({
        worktreePath: options.worktreeOrRepoPath,
        env: options.env,
      }),
    catch: (e) =>
      new WorktreeError({
        message: `Provider '${options.provider.name}' create failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(
    Effect.map((handle) => ({
      handle,
      sandbox: makeSandboxFromHandle(handle),
      worktreePath: handle.worktreePath,
    })),
  );

const startBindMountSandbox = (
  options: StartSandboxBindMountOptions,
): Effect.Effect<
  StartSandboxResult,
  DockerError | WorktreeError | ContainerStartTimeoutError
> =>
  Effect.tryPromise({
    try: () => {
      const rawMounts = [
        {
          hostPath: options.worktreeOrRepoPath,
          sandboxPath: options.repoDir,
        },
        ...options.gitMounts,
      ];
      const mounts = normalizeMounts(
        rawMounts,
        options.worktreeOrRepoPath,
        SANDBOX_REPO_DIR,
      );
      const worktreePath =
        process.platform === "win32"
          ? options.worktreeOrRepoPath.replace(/\\/g, "/")
          : options.worktreeOrRepoPath;
      return options.provider.create({
        worktreePath,
        hostRepoPath: options.hostRepoDir,
        mounts,
        env: options.env,
      });
    },
    catch: (e) =>
      new WorktreeError({
        message: `Provider '${options.provider.name}' create failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(
    Effect.map((handle) => ({
      handle,
      sandbox: makeSandboxFromHandle(handle),
      worktreePath: handle.worktreePath,
    })),
    withTimeout(
      CONTAINER_START_TIMEOUT_MS,
      () =>
        new ContainerStartTimeoutError({
          message: `Sandbox container start timed out after ${CONTAINER_START_TIMEOUT_MS}ms`,
          timeoutMs: CONTAINER_START_TIMEOUT_MS,
        }),
    ),
  );

const startIsolatedSandbox = (
  options: StartSandboxIsolatedOptions,
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

      if (options.copyPaths && options.copyPaths.length > 0) {
        const pathsToCopy = options.copyPaths;
        yield* Effect.gen(function* () {
          for (const relativePath of pathsToCopy) {
            let hostPath: string;
            let sandboxPath: string;
            try {
              hostPath = resolveSafeRelativePath(
                options.sourceRepoDir ?? options.hostRepoDir,
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
                  options.sourceRepoDir ?? options.hostRepoDir,
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
          }
        }).pipe(
          withTimeout(
            COPY_PATHS_TIMEOUT_MS,
            () =>
              new CopyToWorktreeTimeoutError({
                message: `Copying paths to worktree timed out after ${COPY_PATHS_TIMEOUT_MS}ms`,
                timeoutMs: COPY_PATHS_TIMEOUT_MS,
                paths: pathsToCopy,
              }),
          ),
        );
      }

      return {
        handle,
        sandbox: makeSandboxFromHandle(handle),
        worktreePath: handle.worktreePath,
      };
    }).pipe(Effect.onError(() => Effect.promise(() => handle.close())));
  });

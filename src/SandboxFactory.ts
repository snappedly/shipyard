import { toSessionTransferHandle } from "./SandboxProvider.js";
import { Context, Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import {
  AgentError,
  AgentIdleTimeoutError,
  CopyError,
  ExecError,
  SyncError,
  WorktreeError,
  type DockerError,
  type SandboxError,
} from "./errors.js";
import type { Timeouts } from "./run.js";
import * as WorktreeManager from "./WorktreeManager.js";
import type {
  SandboxProvider,
  BranchStrategy,
  SessionTransferHandle,
  IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { runHostHooks, type SandboxHooks } from "./SandboxLifecycle.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      stdin?: string;
      signal?: AbortSignal;
      /** Reject/terminate the command after this many combined output bytes. */
      maxOutputBytes?: number;
    },
  ) => Effect.Effect<ExecResult, ExecError>;

  /** Copy a file or directory from the host into the sandbox. */
  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  /** Copy a single file from the sandbox to the host. */
  readonly copyFileOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, CopyError>;
}

/** Wrap the Docker handle in the Effect service used by execution. */
export const makeSandboxFromHandle = (
  handle: IsolatedSandboxHandle,
): SandboxService => ({
  exec: (command, options) =>
    Effect.tryPromise({
      try: () => handle.exec(command, options),
      catch: (e) =>
        new ExecError({
          command,
          message: `exec failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }),
  copyIn: (hostPath, sandboxPath) =>
    Effect.tryPromise({
      try: () => handle.copyIn(hostPath, sandboxPath),
      catch: (e) =>
        new CopyError({
          message: `copyIn failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }),
  copyFileOut: (sandboxPath, hostPath) =>
    Effect.tryPromise({
      try: () => handle.copyFileOut(sandboxPath, hostPath),
      catch: (e) =>
        new CopyError({
          message: `copyFileOut failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }),
});

/** The project path inside the Docker sandbox. */
export const SANDBOX_REPO_DIR = "/home/agent/workspace";

export interface SandboxInfo {
  /** Host-side path to the worktree directory (worktree/branch mode only). */
  readonly hostWorktreePath?: string;
  /** Absolute path to the worktree inside the sandbox, as reported by the provider. */
  readonly sandboxRepoPath: string;
  /** Sync changes from the sandbox to the host worktree (isolated providers only). */
  readonly applyToHost?: () => Effect.Effect<void, SyncError>;
  /** File-transfer handle for agent session capture and resume. */
  readonly sessionTransferHandle?: SessionTransferHandle;
}

export interface WithSandboxResult<A> {
  readonly value: A;
  /** Host path to the preserved worktree, set when the worktree was left behind due to uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export class SandboxFactory extends Context.Tag("SandboxFactory")<
  SandboxFactory,
  {
    readonly withSandbox: <A, E, R>(
      makeEffect: (
        info: SandboxInfo,
        sandbox: SandboxService,
      ) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<WithSandboxResult<A>, E | SandboxError, R>;
  }
>() {}

export class SandboxConfig extends Context.Tag("SandboxConfig")<
  SandboxConfig,
  {
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
    readonly copyToWorktree?: string[];
    /** When specified, the run name is included in the auto-generated branch and worktree names. */
    readonly name?: string;
    /** Sandbox provider — delegates sandbox lifecycle to the provider. */
    readonly sandboxProvider: SandboxProvider;
    /** Branch strategy — controls how the agent's changes relate to branches. */
    readonly branchStrategy: BranchStrategy;
    /** Lifecycle hooks grouped by execution location (host or sandbox). */
    readonly hooks?: SandboxHooks;
    /** AbortSignal threaded to lifecycle hooks so they can cooperatively cancel. */
    readonly signal?: AbortSignal;
    /** Override default timeouts for built-in lifecycle steps. */
    readonly timeouts?: Timeouts;
  }
>() {}

/**
 * Print a message to stderr about a preserved worktree, with review and cleanup instructions.
 */
const printWorktreePreservedMessage = (
  worktreePath: string,
  reason: string,
): void => {
  console.error(`\n${reason}`);
  console.error(`  To review: cd ${worktreePath}`);
  console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
};

/**
 * Check for uncommitted changes and either preserve or remove the worktree.
 * Returns the preserved path if preserved, undefined if removed.
 */
const cleanupWorktree = (
  worktreePath: string,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<string | undefined, WorktreeError> =>
  WorktreeManager.hasUncommittedChanges(worktreePath).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.flatMap((isDirty) => {
      if (isDirty) {
        printWorktreePreservedMessage(
          worktreePath,
          Exit.isSuccess(exit)
            ? `Run succeeded but worktree has uncommitted changes at ${worktreePath}`
            : `Worktree preserved at ${worktreePath}`,
        );
        return Effect.succeed(worktreePath as string | undefined);
      }
      if (!Exit.isSuccess(exit)) {
        console.error(`\nWorktree removed (no uncommitted changes)`);
      }
      return WorktreeManager.remove(worktreePath).pipe(
        Effect.map(() => undefined as string | undefined),
      );
    }),
  );

/**
 * Attach the preserved worktree path to AgentIdleTimeoutError and AgentError so
 * programmatic callers can build on top of the preserved worktree.
 */
const attachPreservedPath = <E>(
  path: string | undefined,
  e: E | SandboxError,
): E | SandboxError => {
  if (path !== undefined) {
    if (e instanceof AgentIdleTimeoutError) {
      return new AgentIdleTimeoutError({
        message: e.message,
        timeoutMs: e.timeoutMs,
        preservedWorktreePath: path,
      }) as unknown as E | SandboxError;
    }
    if (e instanceof AgentError) {
      return new AgentError({
        message: e.message,
        preservedWorktreePath: path,
      }) as unknown as E | SandboxError;
    }
  }
  return e;
};

export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const {
        env,
        hostRepoDir,
        copyToWorktree: copyPaths,
        name,
        sandboxProvider,
        branchStrategy,
        hooks,
        signal,
        timeouts,
      } = yield* SandboxConfig;

      const branch =
        branchStrategy.type === "branch" ? branchStrategy.branch : undefined;
      const baseBranch =
        branchStrategy.type === "branch"
          ? branchStrategy.baseBranch
          : undefined;
      const fileSystem = yield* FileSystem.FileSystem;

      /** Prune stale worktrees (best-effort), then create a fresh one. */
      const pruneAndCreate = () =>
        WorktreeManager.pruneStale(hostRepoDir).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => {
              console.error(
                "[shipyard] Warning: failed to prune stale worktrees:",
                e.message,
              );
            }),
          ),
          Effect.andThen(
            branch
              ? WorktreeManager.create(hostRepoDir, { branch, baseBranch })
              : WorktreeManager.create(hostRepoDir, { name }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );

      return {
        withSandbox: <A, E, R>(
          makeEffect: (
            info: SandboxInfo,
            sandbox: SandboxService,
          ) => Effect.Effect<A, E, R>,
        ): Effect.Effect<WithSandboxResult<A>, E | SandboxError, R> => {
          // Docker creates a worktree and transfers it through a Git bundle.
          {
            let preservedPath: string | undefined;

            // Nested so the worktree is always cleaned up (outer release) even
            // when hooks or sandbox start fail. The provider handle is closed by
            // the inner release, which only runs once it exists.
            return Effect.acquireUseRelease(
              pruneAndCreate(),
              (worktreeInfo) =>
                (hooks?.host?.onWorktreeReady?.length
                  ? runHostHooks(
                      hooks.host.onWorktreeReady,
                      worktreeInfo.path,
                      signal,
                    )
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    Effect.acquireUseRelease(
                      startSandbox({
                        provider: sandboxProvider,
                        hostRepoDir: worktreeInfo.path,
                        sourceRepoDir: hostRepoDir,
                        env,
                        copyPaths,
                        copyTimeoutMs: timeouts?.copyToWorktreeMs,
                      }),
                      ({ sandbox, worktreePath, handle }) =>
                        makeEffect(
                          {
                            hostWorktreePath: worktreeInfo.path,
                            sandboxRepoPath: worktreePath,
                            sessionTransferHandle:
                              toSessionTransferHandle(handle),
                            applyToHost: () =>
                              syncOut(
                                worktreeInfo.path,
                                handle as IsolatedSandboxHandle,
                              ),
                          },
                          sandbox,
                        ),
                      ({ handle }) =>
                        Effect.tryPromise({
                          try: () => handle.close(),
                          catch: () => undefined,
                        }).pipe(Effect.orDie),
                    ),
                  ),
                ) as Effect.Effect<A, E | SandboxError, R>,
              (worktreeInfo, exit) =>
                cleanupWorktree(worktreeInfo.path, exit).pipe(
                  Effect.tap((p) => {
                    preservedPath = p;
                  }),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorktreePath: preservedPath,
              })),
              Effect.mapError((e: E | SandboxError) =>
                attachPreservedPath(preservedPath, e),
              ),
            );
          }
        },
      };
    }),
  ),
};

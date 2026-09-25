import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import * as clack from "@clack/prompts";
import { Effect } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
import { ClackDisplay, Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { resolvePrompt } from "./PromptResolver.js";
import { makeSandboxFromHandle } from "./SandboxFactory.js";
import {
  withSandboxLifecycle,
  runHostHooks,
  type SandboxHooks,
} from "./SandboxLifecycle.js";
import type {
  SandboxProvider,
  BranchStrategy,
  IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { generateTempBranchName, getCurrentBranch } from "./WorktreeManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
  findMissingPromptArgKeys,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { raceAbortSignal } from "./raceAbortSignal.js";
import { resolveCwd } from "./resolveCwd.js";
import type { Timeouts } from "./run.js";
import { CLI_NAME } from "./runtimeNames.js";

export interface InteractiveOptions {
  /** Agent provider to use (e.g. codex(CODEX_MODELS.routine)) */
  readonly agent: AgentProvider;
  /** Docker sandbox provider. */
  readonly sandbox: SandboxProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Optional name for the interactive session. */
  readonly name?: string;
  /** Branch strategy; defaults to merge-to-head. */
  readonly branchStrategy?: BranchStrategy;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: SandboxHooks;
  /** Paths relative to the host repo root to copy into Docker after Git sync. */
  readonly copyToWorktree?: string[];
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Environment variables to inject into the sandbox. */
  readonly env?: Record<string, string>;
  /**
   * Host repo directory to use instead of `process.cwd()`.
   *
   * Relative paths resolve against `process.cwd()`; absolute paths pass
   * through as-is. A {@link CwdError} is thrown if the path does not exist
   * or is not a directory.
   */
  readonly cwd?: string;
  /**
   * An `AbortSignal` that cancels the interactive session when aborted.
   *
   * - If `signal.aborted` is already `true` at entry, `interactive()` rejects
   *   immediately without doing any setup work.
   * - Aborting during an active session kills the agent subprocess.
   * - The rejected promise surfaces `signal.reason` via
   *   `signal.throwIfAborted()` — no Shipyard-specific wrapping.
   * - The worktree is preserved on disk after abort (error-path behavior).
   */
  readonly signal?: AbortSignal;
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
}

export interface InteractiveResult {
  /** List of commits made during the interactive session. */
  readonly commits: { sha: string }[];
  /** The branch name the agent worked on. */
  readonly branch: string;
  /** Host path to the preserved worktree, if worktree had uncommitted changes. */
  readonly preservedWorktreePath?: string;
  /** Exit code of the interactive process. */
  readonly exitCode: number;
}

/**
 * Launch an interactive agent session inside a sandbox.
 *
 * The user sees the agent's TUI directly. When the session ends,
 * Shipyard collects commits and handles branch merging, just like run().
 *
 * Full prompt preprocessing pipeline: PromptResolver -> PromptArgumentSubstitution
 * -> PromptPreprocessor (shell expressions inside sandbox).
 *
 * All three branch strategies are supported: head, merge-to-head, branch.
 */
export const interactive = async (
  options: InteractiveOptions,
): Promise<InteractiveResult> => {
  // If signal is already aborted, reject immediately without any setup
  options.signal?.throwIfAborted();

  const { prompt, promptFile, hooks, agent: provider } = options;

  const resolvedSandbox = options.sandbox;

  const branchStrategy: BranchStrategy = options.branchStrategy ?? {
    type: "merge-to-head",
  };

  // Validate buildInteractiveArgs is available
  if (!provider.buildInteractiveArgs) {
    throw new Error(
      `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
    );
  }

  const branch: string | undefined =
    branchStrategy.type === "branch" ? branchStrategy.branch : undefined;

  const sandboxProvider = resolvedSandbox;

  const inner = Effect.gen(function* () {
    const hostRepoDir = yield* resolveCwd(options.cwd);
    const d = yield* Display;

    // 1. Resolve prompt (from string or file), or skip if neither provided
    const hasPromptSource = prompt !== undefined || promptFile !== undefined;
    const resolved = hasPromptSource
      ? yield* resolvePrompt({ prompt, promptFile })
      : undefined;
    const rawPrompt = resolved?.text ?? "";
    const isInlinePrompt = resolved?.source === "inline";

    // 2. Resolve env vars
    const resolvedEnv = yield* resolveEnv(hostRepoDir);
    const env = mergeProviderEnv({
      resolvedEnv,
      agentProviderEnv: provider.env,
      sandboxProviderEnv: sandboxProvider.env,
    });
    const effectiveEnv = { ...env, ...(options.env ?? {}) };

    // 3. Capture host's current branch
    const currentHostBranch = yield* getCurrentBranch(hostRepoDir);

    const resolvedBranch = branch ?? generateTempBranchName(options.name);

    // 4. Validate prompt args and collect missing ones interactively (skip when no prompt).
    // Inline prompts pass through literally — skip scanning, substitution, and built-in args.
    let substitutedPrompt = rawPrompt;
    if (hasPromptSource && !isInlinePrompt) {
      const userArgs = options.promptArgs ?? {};
      yield* validateNoBuiltInArgOverride(userArgs);

      // Scan for missing keys and prompt the user for each one
      const missingKeys = findMissingPromptArgKeys(rawPrompt, userArgs);
      const collectedArgs: Record<string, string> = {};
      for (const key of missingKeys) {
        const value = yield* Effect.promise(() =>
          clack.text({
            message: `Enter value for {{${key}}}`,
            validate: (v) => {
              if (!v) return `A value is required for {{${key}}}`;
            },
          }),
        );
        if (clack.isCancel(value)) {
          clack.cancel("Prompt arg collection cancelled.");
          return yield* Effect.fail(
            new Error("User cancelled prompt arg collection"),
          );
        }
        collectedArgs[key] = value;
      }

      const mergedUserArgs = { ...userArgs, ...collectedArgs };
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...mergedUserArgs,
      };
      const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
      substitutedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet,
      );
    } else if (isInlinePrompt) {
      const userArgs = options.promptArgs ?? {};
      yield* validateNoArgsWithInlinePrompt(userArgs);
    }

    const lifecycleBranch = branch;

    // Display intro and summary
    yield* d.intro(options.name ?? `${CLI_NAME} interactive`);
    yield* d.summary("Interactive Session", {
      Agent: options.name ?? provider.name,
      Sandbox: sandboxProvider.name,
      Branch: resolvedBranch,
    });

    // 5. Create a worktree for the Docker sandbox.
    const worktreeInfo = yield* d.taskLog("Creating worktree", () =>
      WorktreeManager.pruneStale(hostRepoDir).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.andThen(
          branch
            ? WorktreeManager.create(hostRepoDir, { branch })
            : WorktreeManager.create(hostRepoDir, { name: options.name }),
        ),
      ),
    );

    // 6. Prepare the worktree and start the sandbox. If any step fails after the
    // worktree exists (copying, hooks, or sandbox start), remove the worktree so
    // it is not orphaned on disk.
    const handle: IsolatedSandboxHandle = yield* Effect.gen(function* () {
      if (hooks?.host?.onWorktreeReady?.length) {
        yield* runHostHooks(hooks.host.onWorktreeReady, worktreeInfo.path);
      }
      const startResult = yield* d.taskLog("Starting sandbox", () =>
        startSandbox({
          provider: sandboxProvider,
          hostRepoDir: worktreeInfo.path,
          sourceRepoDir: hostRepoDir,
          env: effectiveEnv,
          copyPaths: options.copyToWorktree,
          copyTimeoutMs: options.timeouts?.copyToWorktreeMs,
        }),
      );
      return startResult.handle;
    }).pipe(
      Effect.tapError(() =>
        worktreeInfo
          ? WorktreeManager.remove(worktreeInfo.path).pipe(
              Effect.catchAll(() => Effect.void),
            )
          : Effect.void,
      ),
    );

    // Run lifecycle with guaranteed cleanup of handle and worktree
    return yield* Effect.gen(function* () {
      // The Docker provider must support interactive sessions.
      if (!handle.interactiveExec) {
        throw new Error(
          `Sandbox provider does not support interactiveExec. ` +
            `The provider must implement the optional interactiveExec method to use interactive().`,
        );
      }
      const interactiveExecFn = handle.interactiveExec.bind(handle);

      // Build sandbox service and run withSandboxLifecycle
      const sandbox = makeSandboxFromHandle(handle);
      const worktreePath = handle.worktreePath;

      const applyToHost = () => syncOut(worktreeInfo.path, handle);

      const lifecycleEffect = withSandboxLifecycle(
        {
          hostRepoDir,
          sandboxRepoDir: worktreePath,
          hooks,
          branch: lifecycleBranch,
          hostWorktreePath: worktreeInfo.path,
          applyToHost,
          timeouts: options.timeouts,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            // Preprocess prompt (expand !`command` shell expressions inside sandbox).
            // Skip when no prompt source was provided, or when inline (literal passthrough).
            const fullPrompt =
              !hasPromptSource || isInlinePrompt
                ? substitutedPrompt
                : yield* preprocessPrompt(
                    substitutedPrompt,
                    ctx.sandbox,
                    ctx.sandboxRepoDir,
                  );

            // Build interactive args and run the session
            const interactiveArgs = provider.buildInteractiveArgs!({
              prompt: fullPrompt,
              dangerouslySkipPermissions: true,
            });

            const result = yield* raceAbortSignal(
              Effect.promise(() =>
                interactiveExecFn(interactiveArgs, {
                  stdin: process.stdin,
                  stdout: process.stdout,
                  stderr: process.stderr,
                  cwd: worktreePath,
                  signal: options.signal,
                }),
              ),
              options.signal,
            );

            return result.exitCode;
          }),
      );

      const lifecycleResult = yield* lifecycleEffect;

      const exitCode = lifecycleResult.result;

      // Check for uncommitted changes
      let preservedWorktreePath: string | undefined;
      if (worktreeInfo) {
        const hasUncommitted = yield* WorktreeManager.hasUncommittedChanges(
          worktreeInfo.path,
        ).pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (hasUncommitted) {
          preservedWorktreePath = worktreeInfo.path;
        }
      }

      // Clean up worktree if not preserved
      if (worktreeInfo && !preservedWorktreePath) {
        yield* WorktreeManager.remove(worktreeInfo.path).pipe(
          Effect.catchAll(() => Effect.void),
        );
      }

      // Final summary
      yield* d.summary("Session Complete", {
        Commits: String(lifecycleResult.commits.length),
        Branch: lifecycleResult.branch,
        "Exit code": String(exitCode),
        ...(preservedWorktreePath
          ? { "Preserved worktree": preservedWorktreePath }
          : {}),
      });

      return {
        commits: lifecycleResult.commits,
        branch: lifecycleResult.branch,
        preservedWorktreePath,
        exitCode,
      };
    }).pipe(
      // Cancellation preserves the worktree for inspection and recovery.
      Effect.tapError(() =>
        worktreeInfo && !options.signal?.aborted
          ? WorktreeManager.remove(worktreeInfo.path).pipe(
              Effect.catchAll(() => Effect.void),
            )
          : Effect.void,
      ),
      // Always close sandbox handle
      Effect.ensuring(Effect.promise(() => handle.close().catch(() => {}))),
    );
  });

  let result: InteractiveResult;
  try {
    result = await Effect.runPromise(
      inner.pipe(
        Effect.provide(ClackDisplay.layer),
        Effect.provide(NodeContext.layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    );
  } catch (error: unknown) {
    // If the signal was aborted, surface its reason verbatim (no wrapping)
    options.signal?.throwIfAborted();
    throw error;
  }

  return result;
};

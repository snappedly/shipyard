import { Effect } from "effect";
import type { ExecResult, IsolatedSandboxHandle } from "./SandboxProvider.js";
import { SyncError } from "./errors.js";
import { execHostGit as execSafeHostGit } from "./hostGit.js";

export const execHostGit = (
  args: string[],
  cwd: string,
): Effect.Effect<string, SyncError> =>
  Effect.tryPromise({
    try: () => execSafeHostGit(args, cwd),
    catch: (error) =>
      new SyncError({
        message: `Host command failed: git ${args.join(" ")}\n${error instanceof Error ? error.message : String(error)}`,
      }),
  });

export const execSandbox = (
  handle: IsolatedSandboxHandle,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, SyncError> =>
  Effect.tryPromise({
    try: () => handle.exec(command, options),
    catch: (error) =>
      new SyncError({
        message: `Sandbox exec failed: ${command}\n${error instanceof Error ? error.message : String(error)}`,
      }),
  });

export const execOk = (
  handle: IsolatedSandboxHandle,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, SyncError> =>
  execSandbox(handle, command, options).pipe(
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

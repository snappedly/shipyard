/**
 * Shared helper for filesystem-backed test sandbox providers.
 *
 * Implements "run commands in a temp directory" — process spawning,
 * working-directory management, exit code propagation, and cleanup.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxProvider,
  type ExecResult,
} from "../SandboxProvider.js";
import { collectProcessOutput } from "../processOutput.js";

export interface TempSandbox {
  readonly worktreePath: string;
  readonly exec: (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      signal?: AbortSignal;
      maxOutputBytes?: number;
    },
  ) => Promise<ExecResult>;
  readonly close: () => Promise<void>;
}

export const createTempSandbox = async (
  prefix: string,
): Promise<TempSandbox> => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), prefix));
  const worktreePath = join(sandboxRoot, "workspace");
  await mkdir(worktreePath, { recursive: true });

  const exec = (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      signal?: AbortSignal;
      maxOutputBytes?: number;
    },
  ): Promise<ExecResult> => {
    if (options?.onLine || options?.maxOutputBytes !== undefined) {
      const onLine = options?.onLine ?? (() => {});
      return new Promise((resolve, reject) => {
        const proc = spawn("sh", ["-c", command], {
          cwd: options?.cwd ?? worktreePath,
          signal: options?.signal,
          stdio: ["ignore", "pipe", "pipe"],
        });

        proc.on("error", (error) => {
          reject(new Error(`exec failed: ${error.message}`));
        });
        collectProcessOutput(
          {
            stdout: proc.stdout!,
            stderr: proc.stderr!,
            kill: () => proc.kill("SIGKILL"),
            onClose: (listener) => proc.on("close", listener),
          },
          { ...options, onLine },
          resolve,
          reject,
        );
      });
    }

    return new Promise((resolve, reject) => {
      execFile(
        "sh",
        ["-c", command],
        {
          cwd: options?.cwd ?? worktreePath,
          signal: options?.signal,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error && error.code === undefined) {
            reject(new Error(`exec failed: ${error.message}`));
          } else {
            resolve({
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              exitCode: typeof error?.code === "number" ? error.code : 0,
            });
          }
        },
      );
    });
  };

  return {
    worktreePath,
    exec,
    close: () => rm(sandboxRoot, { recursive: true, force: true }),
  };
};

export interface StubProviderRecord {
  readonly provider: IsolatedSandboxProvider;
  readonly createCalls: ReadonlyArray<unknown>;
  readonly closeCalls: { count: number };
}

/**
 * Create a no-op isolated sandbox provider that records `create`/`close` calls.
 * For tests that verify call contracts without exercising filesystem behaviour.
 */
export const testStubProvider = (
  options: { name?: string; worktreePath?: string } = {},
): StubProviderRecord => {
  const createCalls: unknown[] = [];
  const closeCalls = { count: 0 };
  const provider = createIsolatedSandboxProvider({
    name: options.name ?? "test-stub",
    create: async (createOptions) => {
      createCalls.push(createOptions);
      const { testIsolated } = await import("./test-isolated.js");
      const handle = await testIsolated().create(createOptions);
      return {
        ...handle,
        close: async () => {
          closeCalls.count++;
          await handle.close();
        },
      };
    },
  });
  return { provider, createCalls, closeCalls };
};

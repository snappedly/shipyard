/**
 * Shared helper for filesystem-backed test sandbox providers.
 *
 * Implements "run commands in a temp directory" — process spawning,
 * working-directory management, exit code propagation, cleanup. Both
 * `testBindMount` and `testIsolated` are thin adaptors over this helper.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type ExecResult,
} from "../SandboxProvider.js";
import {
  BoundedTail,
  MAX_TAIL_CHARS,
  OutputByteCounter,
} from "../boundedTail.js";

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

        const outputLimit =
          options?.maxOutputBytes === undefined
            ? undefined
            : new OutputByteCounter(options.maxOutputBytes);
        const tailChars = options?.maxOutputBytes ?? MAX_TAIL_CHARS;
        const stdoutTail = new BoundedTail(tailChars, "\n");
        const stderrTail = new BoundedTail(tailChars, "");
        let limitError: Error | undefined;

        const rl = createInterface({ input: proc.stdout! });
        rl.on("line", (line) => {
          stdoutTail.push(line);
          onLine(line);
        });

        const checkOutputLimit = (chunk: Buffer): void => {
          if (outputLimit === undefined || limitError !== undefined) return;
          outputLimit.add(chunk);
          if (outputLimit.exceeded) {
            limitError = new Error(
              `Sandbox command output exceeded ${options.maxOutputBytes} bytes`,
            );
            proc.kill("SIGKILL");
          }
        };
        proc.stdout!.on("data", checkOutputLimit);
        proc.stderr!.on("data", (chunk: Buffer) => {
          checkOutputLimit(chunk);
          stderrTail.push(chunk.toString());
        });

        proc.on("error", (error) => {
          reject(new Error(`exec failed: ${error.message}`));
        });

        proc.on("close", (code) => {
          if (limitError !== undefined) {
            reject(limitError);
            return;
          }
          resolve({
            stdout: stdoutTail.toString(),
            stderr: stderrTail.toString(),
            exitCode: code ?? 0,
          });
        });
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
  readonly provider: BindMountSandboxProvider;
  readonly createCalls: ReadonlyArray<unknown>;
  readonly closeCalls: { count: number };
}

/**
 * Create a no-op bind-mount sandbox provider that records `create`/`close` calls.
 * For tests that verify call contracts without exercising filesystem behaviour.
 */
export const testStubProvider = (
  options: { name?: string; worktreePath?: string } = {},
): StubProviderRecord => {
  const createCalls: unknown[] = [];
  const closeCalls = { count: 0 };
  const provider = createBindMountSandboxProvider({
    name: options.name ?? "test-stub",
    create: async (createOptions) => {
      createCalls.push(createOptions);
      const handle: BindMountSandboxHandle = {
        worktreePath: options.worktreePath ?? "/home/agent/workspace",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {
          closeCalls.count++;
        },
      };
      return handle;
    },
  });
  return { provider, createCalls, closeCalls };
};

/**
 * Vercel isolated sandbox provider — wraps `@vercel/sandbox` into a SandboxProvider.
 *
 * Usage:
 *   import { vercel } from "@snappedly-tools/shipyard/sandboxes/vercel";
 *   await run({ agent: codex(CODEX_MODELS.routine), sandbox: vercel() });
 */

import { execFileSync } from "node:child_process";
import {
  lstat,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import {
  BoundedTail,
  MAX_TAIL_CHARS,
  OutputByteCounter,
} from "../boundedTail.js";
import { shellQuote } from "../shellQuote.js";

/** Worktree path inside the Vercel sandbox. */
const VERCEL_REPO_PATH = "/vercel/sandbox/workspace";

/**
 * Options for creating a Vercel sandbox provider.
 *
 * All `@vercel/sandbox` `Sandbox.create()` options are accepted as pass-through,
 * plus Shipyard-specific options for auth and branch strategy.
 */
export interface VercelOptions {
  /**
   * Vercel access token.
   *
   * Falls back to the SDK's default auth behavior, which reads
   * `VERCEL_OIDC_TOKEN` (recommended for Vercel-hosted environments) or
   * `VERCEL_TOKEN` from the environment.
   */
  readonly token?: string;

  // ---- Pass-through @vercel/sandbox Sandbox.create() options ----

  /**
   * The source of the sandbox (git repo, tarball, or snapshot).
   * Omit to start an empty sandbox.
   */
  readonly source?:
    | {
        type: "git";
        url: string;
        depth?: number;
        revision?: string;
        username?: string;
        password?: string;
      }
    | {
        type: "tarball";
        url: string;
      }
    | {
        type: "snapshot";
        snapshotId: string;
      };

  /** Array of port numbers to expose from the sandbox (up to 4). */
  readonly ports?: number[];

  /** Timeout in milliseconds before the sandbox auto-terminates. */
  readonly timeout?: number;

  /**
   * Resources to allocate to the sandbox.
   * Each vCPU gets 2048 MB of memory.
   */
  readonly resources?: {
    vcpus: number;
  };

  /**
   * The runtime of the sandbox (e.g. `"node24"`, `"node22"`, `"python3.13"`).
   * Defaults to `"node24"`.
   */
  readonly runtime?: string;

  /**
   * Network policy for the sandbox.
   * Defaults to full internet access if not specified.
   */
  readonly networkPolicy?: Record<string, unknown>;

  /**
   * Vercel project ID to associate sandbox operations with.
   */
  readonly projectId?: string;

  /**
   * Vercel team ID to associate sandbox operations with.
   */
  readonly teamId?: string;

  /**
   * Timeout in milliseconds (alias for `timeout`, kept for discoverability).
   */
  readonly timeoutMs?: number;

  /**
   * Sandbox template shorthand (e.g. `"node-22"`).
   * Maps to the `runtime` option.
   */
  readonly template?: string;

  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;

  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
}

/**
 * Create a Vercel isolated sandbox provider.
 *
 * The returned provider creates Vercel Firecracker microVM sandboxes via
 * the `@vercel/sandbox` SDK. Each sandbox is ephemeral — one sandbox per run.
 *
 * Requires `@vercel/sandbox` to be installed as a peer dependency.
 */
export const vercel = (options?: VercelOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "vercel",
    env: options?.env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
      // Dynamic import so the peer dependency is only loaded at runtime
      const { Sandbox } = await import("@vercel/sandbox");

      const createParams: Record<string, unknown> = {};

      // Pass through SDK options
      if (options?.source) createParams.source = options.source;
      if (options?.ports) createParams.ports = options.ports;
      if (options?.resources) createParams.resources = options.resources;
      if (options?.networkPolicy)
        createParams.networkPolicy = options.networkPolicy;
      // runtime takes precedence over the template convenience alias
      const resolvedRuntime = options?.runtime ?? options?.template;
      if (resolvedRuntime) createParams.runtime = resolvedRuntime;

      // Timeout: prefer explicit timeout, fall back to timeoutMs alias
      const timeoutValue = options?.timeout ?? options?.timeoutMs;
      if (timeoutValue !== undefined) createParams.timeout = timeoutValue;

      // Merge provider env with Shipyard env
      createParams.env = createOptions.env;

      // Auth: pass token and team/project IDs if provided
      if (options?.token) createParams.token = options.token;
      if (options?.projectId) createParams.projectId = options.projectId;
      if (options?.teamId) createParams.teamId = options.teamId;

      const sandbox = await Sandbox.create(
        createParams as Parameters<typeof Sandbox.create>[0],
      );

      // Ensure worktree directory exists
      await sandbox.mkDir(VERCEL_REPO_PATH);

      const handle: IsolatedSandboxHandle = {
        worktreePath: VERCEL_REPO_PATH,

        exec: async (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            maxOutputBytes?: number;
          },
        ): Promise<ExecResult> => {
          if (opts?.onLine || opts?.maxOutputBytes !== undefined) {
            const onLine = opts?.onLine ?? (() => {});
            const outputLimit =
              opts?.maxOutputBytes === undefined
                ? undefined
                : new OutputByteCounter(opts.maxOutputBytes);
            const tailChars = opts?.maxOutputBytes ?? maxOutputTailChars;
            const stdoutTail = new BoundedTail(tailChars, "\n");
            const stderrTail = new BoundedTail(tailChars, "");
            let outputLimitError: Error | undefined;
            const checkOutputLimit = (chunk: string): void => {
              if (outputLimit === undefined || outputLimitError !== undefined) {
                return;
              }
              outputLimit.add(chunk);
              if (outputLimit.exceeded) {
                outputLimitError = new Error(
                  `Sandbox command output exceeded ${opts.maxOutputBytes} bytes`,
                );
              }
            };
            let partial = "";

            const stdoutWritable = new Writable({
              write(chunk, _encoding, callback) {
                checkOutputLimit(chunk.toString());
                if (outputLimitError !== undefined) {
                  callback(outputLimitError);
                  return;
                }
                const text = partial + chunk.toString();
                const lines = text.split("\n");
                partial = lines.pop() ?? "";
                for (const line of lines) {
                  stdoutTail.push(line);
                  onLine(line);
                }
                callback();
              },
              final(callback) {
                if (partial) {
                  stdoutTail.push(partial);
                  onLine(partial);
                  partial = "";
                }
                callback();
              },
            });

            const stderrWritable = new Writable({
              write(chunk, _encoding, callback) {
                checkOutputLimit(chunk.toString());
                if (outputLimitError !== undefined) {
                  callback(outputLimitError);
                  return;
                }
                stderrTail.push(chunk.toString());
                callback();
              },
            });

            const result = await sandbox.runCommand({
              cmd: "sh",
              args: ["-c", command],
              cwd: opts?.cwd ?? VERCEL_REPO_PATH,
              stdout: stdoutWritable,
              stderr: stderrWritable,
              ...(opts?.sudo ? { sudo: true } : {}),
            });

            if (outputLimitError !== undefined) throw outputLimitError;

            return {
              stdout: stdoutTail.toString(),
              stderr: stderrTail.toString(),
              exitCode: result.exitCode,
            };
          }

          const result = await sandbox.runCommand({
            cmd: "sh",
            args: ["-c", command],
            cwd: opts?.cwd ?? VERCEL_REPO_PATH,
            ...(opts?.sudo ? { sudo: true } : {}),
          });

          const stdout = await result.stdout();
          const stderr = await result.stderr();

          return {
            stdout,
            stderr,
            exitCode: result.exitCode,
          };
        },

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const info = await lstat(hostPath);
          if (info.isSymbolicLink()) {
            throw new Error(`Refusing to copy a symbolic link: ${hostPath}`);
          }
          if (info.isDirectory()) {
            const tempDir = await mkdtemp(join(tmpdir(), "shipyard-copyin-"));
            const tarPath = join(tempDir, "archive.tar.gz");
            try {
              execFileSync("tar", ["-czf", tarPath, "-C", hostPath, "."]);
              const tarContent = await readFile(tarPath);
              const sandboxTarPath = `/tmp/shipyard-copyin-${randomUUID()}.tar.gz`;
              await sandbox.writeFiles([
                { path: sandboxTarPath, content: tarContent },
              ]);
              await sandbox.runCommand({
                cmd: "sh",
                args: [
                  "-c",
                  `mkdir -p ${shellQuote(sandboxPath)} && tar -xzf ${shellQuote(sandboxTarPath)} -C ${shellQuote(sandboxPath)} && rm -f ${shellQuote(sandboxTarPath)}`,
                ],
              });
            } finally {
              await rm(tempDir, { recursive: true, force: true }).catch(
                () => {},
              );
            }
          } else {
            const content = await readFile(hostPath);
            await sandbox.writeFiles([{ path: sandboxPath, content }]);
          }
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          const buffer = await sandbox.readFileToBuffer({
            path: sandboxPath,
          });
          if (!buffer) {
            throw new Error(`File not found in Vercel sandbox: ${sandboxPath}`);
          }
          await mkdir(dirname(hostPath), { recursive: true, mode: 0o700 });
          try {
            if ((await lstat(hostPath)).isSymbolicLink()) {
              throw new Error(
                `Refusing to overwrite symbolic link: ${hostPath}`,
              );
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await writeFile(hostPath, buffer, { mode: 0o600 });
          await chmod(hostPath, 0o600);
        },

        close: async (): Promise<void> => {
          await sandbox.stop();
        },
      };

      return handle;
    },
  });

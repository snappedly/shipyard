import { copyIntoContainer } from "./copyIntoContainer.js";
/**
 * Docker sandbox provider — wraps DockerLifecycle into a SandboxProvider.
 *
 * Usage:
 *   import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";
 *   await run({ agent: codex(CODEX_MODELS.routine), sandbox: docker() });
 */

import {
  execFile,
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { startContainer, removeContainer } from "../DockerLifecycle.js";
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxProvider,
  type IsolatedCreateOptions,
  type IsolatedSandboxHandle,
  type ExecResult,
  type InteractiveExecOptions,
} from "../SandboxProvider.js";
import type { MountConfig } from "../MountConfig.js";
import type { SelinuxLabel } from "../mountUtils.js";
import {
  defaultImageName,
  resolveUserMounts,
  assertIsolatedWorkspaceMounts,
  processFileMountParents,
} from "../mountUtils.js";
import { MAX_TAIL_CHARS } from "../boundedTail.js";
import { collectProcessOutput } from "../processOutput.js";
import { registerShutdown } from "../shutdownRegistry.js";
import {
  REPOSITORY_RUNNER_OWNER_ENV,
  REPOSITORY_RUNNER_OWNER_LABEL,
} from "../RepositoryRunnerLifecycle.js";

export interface DockerOptions {
  /** Docker image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * The UID of the `agent` user inside the container image (default: host UID via `process.getuid()`, or 1000).
   *
   * Must match the UID baked into the image at build time. Used as the `--user` flag value
   * and checked against the image's configured UID in the pre-flight diagnostic.
   */
  readonly containerUid?: number;
  /**
   * The GID of the `agent` user inside the container image (default: host GID via `process.getgid()`, or 1000).
   *
   * Must match the GID baked into the image at build time. Used as the `--user` flag value.
   */
  readonly containerGid?: number;
  /**
   * SELinux volume label suffix applied to bind mounts.
   *
   * - `"z"` — shared label (default). No-op on non-SELinux systems.
   * - `"Z"` — private label; only this container can access the mount.
   * - `false` — disable labeling entirely.
   */
  readonly selinuxLabel?: SelinuxLabel;
  /**
   * Additional host directories to bind-mount into the sandbox.
   *
   * Each entry specifies a `hostPath` (tilde-expanded) and `sandboxPath`.
   * If `hostPath` does not exist, sandbox creation fails with a clear error.
   */
  readonly mounts?: readonly MountConfig[];
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
  /**
   * Docker network(s) to attach the container to.
   *
   * - `"my-network"` → `--network my-network`
   * - `["net1", "net2"]` → `--network net1 --network net2`
   *
   * When omitted, Docker's default bridge network is used.
   */
  readonly network?: string | readonly string[];
  /**
   * Supplementary groups to add the container user to, via `--group-add`.
   *
   * Accepts group names or numeric GIDs:
   *
   * - `["docker"]` → `--group-add docker`
   * - `[999]` → `--group-add 999`
   * - `["docker", 999]` → `--group-add docker --group-add 999`
   *
   * Useful for granting access to a bind-mounted Docker socket (Docker-outside-of-Docker).
   * When omitted, no `--group-add` flags are added.
   */
  readonly groups?: readonly (string | number)[];
  /**
   * Host devices to expose to the container, via `--device`.
   *
   * Each entry is a full device spec in `host[:container[:permissions]]` form:
   *
   * - `["/dev/kvm"]` → `--device /dev/kvm`
   * - `["/dev/sda:/dev/xvda:rwm"]` → `--device /dev/sda:/dev/xvda:rwm`
   * - `["/dev/kvm", "/dev/fuse"]` → `--device /dev/kvm --device /dev/fuse`
   *
   * When omitted, no `--device` flags are added.
   */
  readonly devices?: readonly string[];
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
  /**
   * Limit the CPU resources available to the container, via `--cpus`.
   *
   * Maps directly to `docker run --cpus`. Accepts fractional values:
   *
   * - `2` → `--cpus 2` (at most 2 CPUs)
   * - `1.5` → `--cpus 1.5` (at most 1.5 CPUs)
   *
   * When omitted, no `--cpus` flag is added and the container is unconstrained.
   */
  readonly cpus?: number;
}

/**
 * Create a Docker sandbox provider.
 *
 * The returned provider creates Docker containers with isolated repository and Git storage.
 * Changes are transferred through git bundle and validated sync-out.
 */
export const docker = (options?: DockerOptions): IsolatedSandboxProvider => {
  const configuredImageName = options?.imageName;
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
  const sandboxHomedir = "/home/agent";
  const userMounts = options?.mounts
    ? resolveUserMounts(options.mounts, sandboxHomedir)
    : [];
  assertIsolatedWorkspaceMounts(userMounts);
  // Validate file mounts and collect parent dirs to create at container start.
  // Throws at construction time if any file mount parent is outside sandboxHomedir.
  const parentDirsToCreate = processFileMountParents(
    userMounts,
    sandboxHomedir,
  );

  return createIsolatedSandboxProvider({
    name: "docker",
    env: options?.env,
    create: async (
      createOptions: IsolatedCreateOptions,
    ): Promise<IsolatedSandboxHandle> => {
      const containerName = `shipyard-${randomUUID()}`;

      const worktreePath = "/home/agent/workspace";

      // Repository and Git storage are container-owned. Only explicitly
      // configured mounts cross the host boundary.
      const allMounts = userMounts;
      const volumeMounts = allMounts.map((m) => ({
        hostPath: m.hostPath,
        sandboxPath: m.sandboxPath,
        readonly: m.readonly,
      }));

      // Resolve image name
      const imageName =
        configuredImageName ??
        defaultImageName(createOptions.hostRepoPath ?? process.cwd());

      const containerUid = options?.containerUid ?? process.getuid?.() ?? 1000;
      const containerGid = options?.containerGid ?? process.getgid?.() ?? 1000;

      // Pre-flight: verify image exists and UID matches
      await checkImageUid(imageName, containerUid);

      // Start container
      await Effect.runPromise(
        startContainer(
          containerName,
          imageName,
          {
            ...createOptions.env,
            HOME: "/home/agent",
          },
          {
            volumeMounts,
            workdir: worktreePath,
            user: `${containerUid}:${containerGid}`,
            network: options?.network,
            groups: options?.groups,
            devices: options?.devices,
            cpus: options?.cpus,
            selinuxLabel,
            labels: process.env[REPOSITORY_RUNNER_OWNER_ENV]
              ? {
                  [REPOSITORY_RUNNER_OWNER_LABEL]:
                    process.env[REPOSITORY_RUNNER_OWNER_ENV],
                }
              : undefined,
          },
        ),
      );

      // Create parent directories for file mounts and chown to the container user
      for (const dir of parentDirsToCreate) {
        await new Promise<void>((resolve, reject) => {
          execFile(
            "docker",
            [
              "exec",
              "--user",
              "0:0",
              containerName,
              "sh",
              "-c",
              `mkdir -p "$1" && chown "$2" "$1"`,
              "sh",
              dir,
              `${containerUid}:${containerGid}`,
            ],
            (error) => {
              if (error) {
                reject(
                  new Error(
                    `Failed to create parent directory '${dir}' in container: ${error.message}`,
                  ),
                );
              } else {
                resolve();
              }
            },
          );
        });
      }

      // Register synchronous container cleanup via the shared shutdown registry
      // so concurrent sandboxes share a single exit/SIGINT/SIGTERM listener
      // instead of tripping Node's MaxListenersExceededWarning.
      const removeContainerSync = () => {
        try {
          execFileSync("docker", ["rm", "-f", containerName], {
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      };
      const unregisterShutdown = registerShutdown(removeContainerSync);

      const handle: IsolatedSandboxHandle = {
        worktreePath,

        exec: (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
            signal?: AbortSignal;
            maxOutputBytes?: number;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const args = ["exec"];
          if (opts?.stdin !== undefined) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);

          return new Promise((resolve, reject) => {
            const proc = spawn("docker", args, {
              signal: opts?.signal,
              stdio: [
                opts?.stdin !== undefined ? "pipe" : "ignore",
                "pipe",
                "pipe",
              ],
            });

            if (opts?.stdin !== undefined) {
              proc.stdin!.write(opts.stdin);
              proc.stdin!.end();
            }

            proc.on("error", (error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            collectProcessOutput(
              {
                stdout: proc.stdout!,
                stderr: proc.stderr!,
                kill: () => proc.kill("SIGKILL"),
                onClose: (listener) => proc.on("close", listener),
              },
              { ...opts, maxOutputTailChars },
              resolve,
              reject,
            );
          });
        },

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> => {
          return new Promise((resolve, reject) => {
            opts.signal?.throwIfAborted();
            const executionId = randomUUID();
            const pidFile = `/tmp/shipyard-interactive-${executionId}.pid`;
            const cancelFile = `/tmp/shipyard-interactive-${executionId}.cancel`;
            const dockerArgs = ["exec"];
            // Allocate a pseudo-terminal when stdin looks like a TTY
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY
            ) {
              dockerArgs.push("-it");
            } else {
              dockerArgs.push("-i");
            }
            if (opts.cwd) dockerArgs.push("-w", opts.cwd);
            dockerArgs.push(
              containerName,
              "sh",
              "-c",
              'pid_file=$1; cancel_file=$2; shift 2; command -v setsid >/dev/null 2>&1 && command -v ps >/dev/null 2>&1 && command -v awk >/dev/null 2>&1 || { printf "%s\\n" "setsid, ps, and awk are required for cancellable interactive execution" >&2; exit 127; }; if [ -e "$cancel_file" ]; then rm -f "$pid_file" "$cancel_file"; exit 130; fi; setsid "$@" & child=$!; printf "%s\\n" "$child" > "$pid_file"; wait "$child"; status=$?; rm -f "$pid_file" "$cancel_file"; exit "$status"',
              "shipyard-interactive",
              pidFile,
              cancelFile,
              ...args,
            );

            const proc = spawn("docker", dockerArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            });

            let settled = false;
            let cancelling = false;
            const finish = (
              result:
                | { readonly exitCode: number }
                | { readonly error: unknown },
            ): void => {
              if (settled) return;
              settled = true;
              opts.signal?.removeEventListener("abort", onAbort);
              if ("error" in result) reject(result.error);
              else resolve(result);
            };

            const onAbort = (): void => {
              if (cancelling || settled) return;
              cancelling = true;
              const cancellationScript =
                'touch "$1"; attempts=0; while [ ! -s "$2" ] && [ "$attempts" -lt 50 ]; do sleep 0.1; attempts=$((attempts + 1)); done; if [ -s "$2" ]; then pid=$(cat "$2"); group_running() { ps -eo pgid=,stat= | awk -v pg="$pid" \'$1 == pg && $2 !~ /^Z/ { found=1 } END { exit found ? 0 : 1 }\'; }; kill -TERM "-$pid" 2>/dev/null || true; attempts=0; while group_running && [ "$attempts" -lt 20 ]; do sleep 0.1; attempts=$((attempts + 1)); done; kill -KILL "-$pid" 2>/dev/null || true; attempts=0; while group_running && [ "$attempts" -lt 20 ]; do sleep 0.1; attempts=$((attempts + 1)); done; if group_running; then exit 1; fi; rm -f "$1" "$2"; fi';
              execFile(
                "docker",
                [
                  "exec",
                  containerName,
                  "sh",
                  "-c",
                  cancellationScript,
                  "shipyard-cancel",
                  cancelFile,
                  pidFile,
                ],
                { timeout: 7_000 },
                (error) => {
                  proc.kill("SIGKILL");
                  if (error) {
                    finish({
                      error: new Error(
                        `Failed to terminate interactive process in Docker sandbox: ${error.message}`,
                      ),
                    });
                    return;
                  }
                  finish({
                    error:
                      opts.signal?.reason ??
                      new Error("Interactive execution aborted"),
                  });
                },
              );
            };

            opts.signal?.addEventListener("abort", onAbort, { once: true });
            if (opts.signal?.aborted) onAbort();

            proc.on("error", (error: Error) => {
              if (!cancelling) {
                finish({
                  error: new Error(`docker exec failed: ${error.message}`),
                });
              }
            });

            proc.on("close", (code: number | null) => {
              if (cancelling) return;
              execFile(
                "docker",
                ["exec", containerName, "rm", "-f", pidFile, cancelFile],
                () => {},
              );
              finish({ exitCode: code ?? 0 });
            });
          });
        },

        copyIn: (hostPath, sandboxPath) =>
          copyIntoContainer(
            "docker",
            containerName,
            `${containerUid}:${containerGid}`,
            hostPath,
            sandboxPath,
          ),

        copyFileOut: (sandboxPath: string, hostPath: string): Promise<void> =>
          new Promise((resolve, reject) => {
            execFile(
              "docker",
              ["cp", `${containerName}:${sandboxPath}`, hostPath],
              (error) => {
                if (error) {
                  reject(new Error(`docker cp (out) failed: ${error.message}`));
                } else {
                  resolve();
                }
              },
            );
          }),

        close: async (): Promise<void> => {
          unregisterShutdown();
          await Effect.runPromise(removeContainer(containerName));
        },
      };

      return handle;
    },
  });
};

// Re-export for backwards compatibility
export { defaultImageName };

const checkImageUid = (imageName: string, expectedUid: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile(
      "docker",
      ["image", "inspect", imageName, "--format", "{{.Config.User}}"],
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `Image '${imageName}' not found locally. Build it first with 'shipyard docker build-image'.`,
            ),
          );
          return;
        }
        const imageUser = (stdout ?? "").toString().trim();
        if (!imageUser) {
          // No USER directive in image — skip check
          resolve();
          return;
        }
        const uidPart = imageUser.split(":")[0]!;
        const imageUid = parseInt(uidPart, 10);
        if (isNaN(imageUid)) {
          // Non-numeric user (e.g. "agent") — can't compare, skip check
          resolve();
          return;
        }
        if (imageUid !== expectedUid) {
          reject(
            new Error(
              `UID mismatch: image '${imageName}' was built with UID ${imageUid}, ` +
                `but the expected UID is ${expectedUid}. ` +
                `Rebuild the image with 'shipyard docker build-image', ` +
                `or pass containerUid: ${imageUid} to docker() to match the image.`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });

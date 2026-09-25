/**
 * Shared mount utilities for the Docker sandbox provider.
 *
 * Handles host/sandbox path resolution, tilde expansion, user mount
 * validation, image naming, and Windows path normalization.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, dirname, relative, posix } from "node:path";
import type { MountConfig } from "./MountConfig.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { RUNTIME_NAMESPACE } from "./runtimeNames.js";

/**
 * SELinux volume label suffix applied to bind mounts.
 *
 * - `"z"` — shared label. No-op on non-SELinux systems.
 * - `"Z"` — private label; only this container can access the mount.
 * - `false` — disable labeling entirely.
 */
export type SelinuxLabel = "z" | "Z" | false;

/**
 * Derive the default image name from the repo directory.
 * Returns `shipyard:<dir-name>` where dir-name is the last path segment,
 * lowercased and sanitized for image tag rules.
 *
 * Handles both POSIX (`/`) and Windows (`\`) path separators.
 */
export const defaultImageName = (repoDir: string): string => {
  const dirName =
    repoDir
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `${RUNTIME_NAMESPACE}:${sanitized || "local"}`;
};

/**
 * Expand tilde (`~`) to the given home directory (or `os.homedir()` if omitted).
 * Handles both `~/path` (POSIX) and `~\path` (Windows).
 */
export const expandTilde = (p: string, homeDirPath?: string): string => {
  const home = homeDirPath ?? homedir();
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return home + "/" + p.slice(2);
  return p;
};

/**
 * Resolve a host path: expand tilde, then resolve relative paths from `process.cwd()`.
 */
export const resolveHostPath = (hostPath: string): string => {
  const expanded = expandTilde(hostPath);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
};

/**
 * Resolve a sandbox path: expands tilde using `sandboxHomedir`, then resolves
 * relative paths from `SANDBOX_REPO_DIR`.
 *
 * Throws if `sandboxPath` starts with `~` but `sandboxHomedir` is `undefined`.
 */
export const resolveSandboxPath = (
  sandboxPath: string,
  sandboxHomedir?: string,
): string => {
  const hasTilde =
    sandboxPath === "~" ||
    sandboxPath.startsWith("~/") ||
    sandboxPath.startsWith("~\\");
  if (hasTilde && sandboxHomedir === undefined) {
    throw new Error(
      `sandboxPath "${sandboxPath}" contains a tilde but the provider has no sandboxHomedir set`,
    );
  }
  const expanded = hasTilde
    ? expandTilde(sandboxPath, sandboxHomedir)
    : sandboxPath;
  // Canonicalize absolute paths too. Without this, `/home/agent/../etc` can
  // pass the home-directory containment check and be created/chowned as root
  // during container startup.
  return isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(SANDBOX_REPO_DIR, expanded);
};

/**
 * Resolve and validate user-provided mount configurations.
 * Throws if a hostPath does not exist on the filesystem.
 * Throws if a sandboxPath uses tilde but `sandboxHomedir` is `undefined`.
 */
export const resolveUserMounts = (
  mounts: readonly MountConfig[],
  sandboxHomedir?: string,
): Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }> =>
  mounts.map((m) => {
    const resolvedHostPath = resolveHostPath(m.hostPath);

    if (!existsSync(resolvedHostPath)) {
      throw new Error(
        `Mount hostPath does not exist: ${m.hostPath}` +
          (m.hostPath !== resolvedHostPath
            ? ` (resolved to ${resolvedHostPath})`
            : ""),
      );
    }

    return {
      hostPath: resolvedHostPath,
      sandboxPath: resolveSandboxPath(m.sandboxPath, sandboxHomedir),
      ...(m.readonly ? { readonly: true } : {}),
    };
  });

/**
 * Format a bind mount into a `-v` style string for container runtimes.
 *
 * Produces: `hostPath:sandboxPath[:ro][,z|Z]`
 *
 * Used by the Docker provider.
 */
export const formatVolumeMount = (
  mount: { hostPath: string; sandboxPath: string; readonly?: boolean },
  selinuxLabel: SelinuxLabel | undefined,
): string => {
  const base = `${mount.hostPath}:${mount.sandboxPath}`;
  const options = [mount.readonly ? "ro" : undefined, selinuxLabel || undefined]
    .filter((option): option is string => option !== undefined)
    .join(",");

  return options ? `${base}:${options}` : base;
};

/**
 * Detect file-target mounts whose sandbox-side parent directory may not
 * exist in the container image, and return the parent dirs that need to
 * be created at container start.
 *
 * Validates at config time: if a file mount's sandbox parent is outside
 * `sandboxHomedir`, throws with a clear error and remediation guidance.
 *
 * For file mounts whose parent is under `sandboxHomedir` (but not equal
 * to it — `/home/agent` always exists), returns the unique set of parent
 * directories that must be `mkdir -p` + `chown`'d before the agent runs.
 *
 * @param mounts - Resolved mounts (hostPath already validated to exist).
 * @param sandboxHomedir - The agent's home directory in the sandbox (e.g. `/home/agent`).
 * @param statFn - Injectable stat function for testing (defaults to `statSync`).
 */
export const processFileMountParents = (
  mounts: ReadonlyArray<{ hostPath: string; sandboxPath: string }>,
  sandboxHomedir: string,
  statFn: (path: string) => { isFile(): boolean } = statSync,
): string[] => {
  const parentDirs = new Set<string>();

  for (const mount of mounts) {
    let isFile: boolean;
    try {
      isFile = statFn(mount.hostPath).isFile();
    } catch {
      continue;
    }

    if (!isFile) continue;

    const parentDir = resolve(dirname(mount.sandboxPath));
    const homeDir = resolve(sandboxHomedir);

    // Parent IS sandboxHomedir — it always exists in the image
    if (parentDir === homeDir) continue;

    // Parent is outside sandboxHomedir — fail at config time
    const fromHome = relative(homeDir, parentDir);
    if (
      fromHome === ".." ||
      fromHome.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(fromHome)
    ) {
      throw new Error(
        `Cannot mount file to '${mount.sandboxPath}': ` +
          `parent directory '${parentDir}' is outside the sandbox home directory ('${homeDir}'). ` +
          `Mount the parent directory instead, or rebuild the image with '${parentDir}' pre-created.`,
      );
    }

    parentDirs.add(parentDir);
  }

  return [...parentDirs];
};

/** Explicit mounts must not replace or sit beneath sandbox-owned Git storage. */
export const assertIsolatedWorkspaceMounts = (
  mounts: readonly { readonly sandboxPath: string }[],
): void => {
  for (const mount of mounts) {
    const path = posix.resolve(mount.sandboxPath);
    if (
      path === "/" ||
      path === SANDBOX_REPO_DIR ||
      path.startsWith(`${SANDBOX_REPO_DIR}/`) ||
      SANDBOX_REPO_DIR.startsWith(`${path}/`)
    ) {
      throw new Error(
        `Mount overlaps the isolated workspace: ${mount.sandboxPath}. Mount outside ${SANDBOX_REPO_DIR} or use copyToWorktree.`,
      );
    }
  }
};

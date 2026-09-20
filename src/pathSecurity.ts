import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/;

/** Validate a path that is expected to be relative to an application root. */
export const assertSafeRelativePath = (
  relativePath: string,
  label = "relative path",
): void => {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath) ||
    WINDOWS_DRIVE_PATH.test(relativePath) ||
    relativePath.startsWith("\\\\") ||
    relativePath.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error(`${label} must stay within its root: ${relativePath}`);
  }
};

/** Validate a filename that must not contain a directory separator. */
export const assertSafePathSegment = (
  segment: string,
  label = "path segment",
): void => {
  assertSafeRelativePath(segment, label);
  if (segment.includes("/") || segment.includes("\\")) {
    throw new Error(`${label} must be a single filename: ${segment}`);
  }
};

/** Resolve a user- or sandbox-supplied relative path without allowing escape. */
export const resolveSafeRelativePath = (
  root: string,
  relativePath: string,
  label = "relative path",
): string => {
  assertSafeRelativePath(relativePath, label);
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, relativePath);
  const fromRoot = relative(rootPath, candidate);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} must stay within its root: ${relativePath}`);
  }
  return candidate;
};

/** Reject existing symlink components before writing below a trusted root. */
export const assertNoSymlinkComponents = async (
  root: string,
  target: string,
  label = "path",
): Promise<void> => {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const fromRoot = relative(rootPath, targetPath);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} escapes its root`);
  }

  let current = rootPath;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
};

/** Sandbox file lists must never address Git administrative data, including
 * common case-insensitive, NTFS and HFS aliases. Git itself validates patches;
 * raw untracked-file copies need this separate guard. */
export const assertSafeGitWorktreePath = (path: string): void => {
  assertSafeRelativePath(path, "untracked path");
  for (const component of path.split(/[\\/]/)) {
    const normalized = component
      .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
      .toLowerCase()
      .split(":")[0]!
      .replace(/[ .]+$/, "");
    if (normalized === ".git" || /^git~[0-9]+$/.test(normalized)) {
      throw new Error(`Untracked path addresses Git metadata: ${path}`);
    }
  }
};

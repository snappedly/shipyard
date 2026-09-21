import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";

import { ConfigDirError } from "./errors.js";
import { assertNoSymlinkComponents } from "./pathSecurity.js";
import { CONFIG_DIR } from "./runtimeNames.js";

const parseEnvFile = (
  filePath: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const symlink = yield* fs.readLink(filePath).pipe(
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    // A repository-controlled symlink could redirect this read to a host
    // secret and then expose matching keys to the agent.
    if (symlink) return {};
    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) return {};
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      const isDoubleQuoted =
        value.length >= 2 &&
        value[0] === '"' &&
        value[value.length - 1] === '"';
      const isSingleQuoted =
        value.length >= 2 &&
        value[0] === "'" &&
        value[value.length - 1] === "'";
      if (isDoubleQuoted || isSingleQuoted) {
        value = value.slice(1, -1);
      }
      if (isDoubleQuoted) {
        value = value.replace(/\\([nrt\\])/g, (_, ch: string) => {
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
          };
          return escapes[ch] ?? ch;
        });
      }
      vars[key] = value;
    }
    return vars;
  });

/**
 * Resolve all env vars from .env files with process.env fallback.
 *
 * Precedence: .shipyard/.env > process.env
 * Only keys declared in .shipyard/.env are resolved from process.env.
 * Repo root .env is not part of the resolution chain.
 */
export const resolveEnv = (
  repoDir: string,
): Effect.Effect<
  Record<string, string>,
  ConfigDirError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const configDir = join(repoDir, CONFIG_DIR);
    const envPath = join(configDir, ".env");
    yield* Effect.tryPromise({
      try: () =>
        assertNoSymlinkComponents(repoDir, envPath, "environment file"),
      catch: (e) =>
        new ConfigDirError({
          message: `Refusing symlinked environment path: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });
    const shipyardEnv = yield* parseEnvFile(envPath);

    const result: Record<string, string> = {};
    for (const key of Object.keys(shipyardEnv)) {
      // A blank placeholder falls back to process.env, so callers can source
      // credentials from a host login for one invocation, e.g.
      // `GH_TOKEN="$(gh auth token)" npx shipyard run`. Only keys declared in
      // .shipyard/.env are eligible for this fallback.
      const value = shipyardEnv[key] || process.env[key];
      if (value) {
        result[key] = value;
      }
    }

    return result;
  });

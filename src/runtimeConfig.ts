import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";

import { ConfigDirError } from "./errors.js";
import { CONFIG_DIR, CLI_NAME } from "./runtimeNames.js";

const configDirExists = (
  repoDir: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .exists(join(repoDir, CONFIG_DIR))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
  });

export const requireCanonicalConfigDir = (
  repoDir: string,
): Effect.Effect<string, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (!(yield* configDirExists(repoDir))) {
      return yield* Effect.fail(
        new ConfigDirError({
          message: `No ${CONFIG_DIR}/ found. Run \`${CLI_NAME} init\` first.`,
        }),
      );
    }
    return join(repoDir, CONFIG_DIR);
  });

/** Fail before initialization can overwrite an existing configuration directory. */
export const assertConfigDirAvailable = (
  repoDir: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (yield* configDirExists(repoDir)) {
      return yield* Effect.fail(
        new ConfigDirError({
          message: `${CONFIG_DIR}/ directory already exists. ${CLI_NAME} did not modify it. Use the existing configuration or remove it deliberately after preserving any active worktrees before re-initializing.`,
        }),
      );
    }
  });

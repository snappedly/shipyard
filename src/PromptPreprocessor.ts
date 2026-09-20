import { Clock, Duration, Effect, Option } from "effect";
import { Display } from "./Display.js";
import { PromptError, PromptExpansionTimeoutError } from "./errors.js";
import type { ExecError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";

const PROMPT_EXPANSION_TIMEOUT_MS = 30_000;
const MAX_PROMPT_EXPANSIONS = 64;
const MAX_EXPANSION_OUTPUT_BYTES = 256 * 1024;
const MAX_EXPANDED_PROMPT_BYTES = 4 * 1024 * 1024;
const PROMPT_EXPANSION_CONCURRENCY = 8;

/**
 * @internal
 * Marker inserted between `!` and the opening backtick for shell blocks that
 * appear in the raw template. The preprocessor only executes marked blocks, so
 * `!`...`` patterns arriving via argument substitution are treated as data.
 * Used only by `substitutePromptArgs`; not part of the public API.
 */
export const SHELL_BLOCK_MARKER = "\x01";

const MARKED_SHELL_BLOCK_PATTERN = new RegExp(
  `!${SHELL_BLOCK_MARKER}\`([^\`]+)\``,
  "g",
);

export const preprocessPrompt = (
  prompt: string,
  sandbox: SandboxService,
  cwd: string,
): Effect.Effect<
  string,
  ExecError | PromptError | PromptExpansionTimeoutError,
  Display
> => {
  const matches = [...prompt.matchAll(MARKED_SHELL_BLOCK_PATTERN)];

  if (matches.length === 0) {
    return Effect.succeed(prompt.replaceAll(SHELL_BLOCK_MARKER, ""));
  }

  if (matches.length > MAX_PROMPT_EXPANSIONS) {
    return Effect.fail(
      new PromptError({
        message: `Prompt contains ${matches.length} shell expressions; the maximum is ${MAX_PROMPT_EXPANSIONS}`,
      }),
    );
  }

  return Effect.gen(function* () {
    const display = yield* Display;
    return yield* display.taskLog("Expanding shell expressions", (message) =>
      Effect.gen(function* () {
        // Execute all commands in parallel
        const results = yield* Effect.all(
          matches.map((match) => {
            const command = match[1]!;
            return Effect.gen(function* () {
              const start = yield* Clock.currentTimeMillis;
              const controller = new AbortController();
              const maybeResult = yield* sandbox
                .exec(command, {
                  cwd,
                  signal: controller.signal,
                  maxOutputBytes: MAX_EXPANSION_OUTPUT_BYTES,
                })
                .pipe(
                  Effect.timeoutOption(
                    Duration.millis(PROMPT_EXPANSION_TIMEOUT_MS),
                  ),
                  // A timeout must stop the underlying local process too;
                  // interrupting a Promise alone would leave a host-side
                  // prompt command running after the request has failed.
                  Effect.ensuring(
                    Effect.sync(() => {
                      controller.abort();
                    }),
                  ),
                );
              if (Option.isNone(maybeResult)) {
                const elapsedMs = (yield* Clock.currentTimeMillis) - start;
                return yield* Effect.fail(
                  new PromptExpansionTimeoutError({
                    message: `Shell expression \`${command}\` timed out after ${elapsedMs}ms`,
                    timeoutMs: PROMPT_EXPANSION_TIMEOUT_MS,
                    expression: command,
                    elapsedMs,
                  }),
                );
              }
              const execResult = maybeResult.value;
              if (execResult.exitCode !== 0) {
                return yield* Effect.fail(
                  new PromptError({
                    message: `Command \`${command}\` exited with code ${execResult.exitCode}: ${execResult.stderr}`,
                    exitCode: execResult.exitCode,
                  }),
                );
              }
              const output = execResult.stdout.trimEnd();
              if (
                Buffer.byteLength(output, "utf8") > MAX_EXPANSION_OUTPUT_BYTES
              ) {
                return yield* Effect.fail(
                  new PromptError({
                    message: `Shell expression output exceeds the ${MAX_EXPANSION_OUTPUT_BYTES}-byte limit`,
                    exitCode: execResult.exitCode,
                  }),
                );
              }
              return output;
            });
          }),
          { concurrency: PROMPT_EXPANSION_CONCURRENCY },
        );

        // Log per-command token counts
        for (let i = 0; i < matches.length; i++) {
          const command = matches[i]![1]!;
          const tokens = Math.ceil(results[i]!.length / 4);
          message(`${command} → ~${tokens} tokens`);
        }

        // Replace all matches using original indices (process in reverse to preserve positions)
        let result = prompt;
        for (let i = matches.length - 1; i >= 0; i--) {
          const match = matches[i]!;
          const index = match.index!;
          result =
            result.slice(0, index) +
            results[i] +
            result.slice(index + match[0].length);
        }
        const expanded = result.replaceAll(SHELL_BLOCK_MARKER, "");
        if (Buffer.byteLength(expanded, "utf8") > MAX_EXPANDED_PROMPT_BYTES) {
          return yield* Effect.fail(
            new PromptError({
              message: `Expanded prompt exceeds the ${MAX_EXPANDED_PROMPT_BYTES}-byte limit`,
            }),
          );
        }
        return expanded;
      }),
    );
  });
};

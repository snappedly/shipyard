import { constants } from "node:fs";
import { open } from "node:fs/promises";
import * as clack from "@clack/prompts";
import { FileSystem } from "@effect/platform";
import { dirname } from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import { styleText } from "node:util";

export type Severity = "info" | "success" | "warn" | "error";

export interface DisplayProgressUpdate {
  readonly current: number;
  readonly total: number;
  readonly message: string;
}

export type DisplayEntry =
  | { readonly _tag: "intro"; readonly title: string }
  | {
      readonly _tag: "status";
      readonly message: string;
      readonly severity: Severity;
    }
  | { readonly _tag: "spinner"; readonly message: string }
  | {
      readonly _tag: "progress";
      readonly title: string;
      readonly updates: ReadonlyArray<DisplayProgressUpdate>;
    }
  | {
      readonly _tag: "summary";
      readonly title: string;
      readonly rows: Record<string, string>;
    }
  | {
      readonly _tag: "taskLog";
      readonly title: string;
      readonly messages: ReadonlyArray<string>;
    }
  | { readonly _tag: "text"; readonly message: string }
  | { readonly _tag: "textChunk"; readonly message: string }
  | {
      readonly _tag: "toolCall";
      readonly name: string;
      readonly formattedArgs: string;
    };

export interface DisplayService {
  readonly intro: (title: string) => Effect.Effect<void>;

  readonly status: (message: string, severity: Severity) => Effect.Effect<void>;

  readonly spinner: <A, E, R>(
    message: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly progress: <A, E, R>(
    title: string,
    effect: (
      report: (update: DisplayProgressUpdate) => void,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly summary: (
    title: string,
    rows: Record<string, string>,
  ) => Effect.Effect<void>;

  readonly taskLog: <A, E, R>(
    title: string,
    effect: (message: (msg: string) => void) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly text: (message: string) => Effect.Effect<void>;

  /**
   * Writes a raw streaming chunk with no implied line break. Used for
   * token-by-token agent output, where consecutive chunks must flow together
   * as contiguous prose rather than each landing on its own line.
   */
  readonly textChunk: (chunk: string) => Effect.Effect<void>;

  readonly toolCall: (
    name: string,
    formattedArgs: string,
  ) => Effect.Effect<void>;
}

export class Display extends Context.Tag("Display")<
  Display,
  DisplayService
>() {}

export const SilentDisplay = {
  layer: (ref: Ref.Ref<ReadonlyArray<DisplayEntry>>): Layer.Layer<Display> =>
    Layer.succeed(Display, {
      intro: (title) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "intro" as const, title },
        ]),

      status: (message, severity) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "status" as const, message, severity },
        ]),

      spinner: (message, effect) =>
        Effect.flatMap(
          Ref.update(ref, (entries) => [
            ...entries,
            { _tag: "spinner" as const, message },
          ]),
          () => effect,
        ),

      progress: (title, effect) =>
        Effect.gen(function* () {
          const updates: DisplayProgressUpdate[] = [];
          const result = yield* effect((update) => updates.push(update));
          yield* Ref.update(ref, (entries) => [
            ...entries,
            { _tag: "progress" as const, title, updates: [...updates] },
          ]);
          return result;
        }),

      summary: (title, rows) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "summary" as const, title, rows },
        ]),

      taskLog: (title, effect) => {
        const messages: string[] = [];
        return Effect.flatMap(
          effect((msg) => messages.push(msg)),
          (result) =>
            Effect.map(
              Ref.update(ref, (entries) => [
                ...entries,
                {
                  _tag: "taskLog" as const,
                  title,
                  messages: [...messages],
                },
              ]),
              () => result,
            ),
        );
      },

      text: (message) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "text" as const, message },
        ]),

      textChunk: (chunk) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "textChunk" as const, message: chunk },
        ]),

      toolCall: (name, formattedArgs) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "toolCall" as const, name, formattedArgs },
        ]),
    }),
};

export const FileDisplay = {
  layer: (
    filePath: string,
  ): Layer.Layer<Display, never, FileSystem.FileSystem> =>
    Layer.scoped(
      Display,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const logFileIsSymlink = yield* fs.readLink(filePath).pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false)),
        );
        if (logFileIsSymlink) {
          yield* Effect.die(
            new Error(
              `Refusing to write through symlinked log file: ${filePath}`,
            ),
          );
        }
        yield* fs
          .makeDirectory(dirname(filePath), { recursive: true, mode: 0o700 })
          .pipe(Effect.orDie);
        const delimiter = `\n--- Run started: ${new Date().toISOString()} ---\n`;
        const file = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            open(
              filePath,
              constants.O_WRONLY |
                constants.O_APPEND |
                constants.O_CREAT |
                constants.O_NOFOLLOW,
              0o600,
            ),
          ).pipe(Effect.orDie),
          (handle) => Effect.promise(() => handle.close()).pipe(Effect.orDie),
        );
        yield* Effect.tryPromise(async () => {
          if (!(await file.stat()).isFile())
            throw new Error("Log must be a regular file");
          await file.chmod(0o600);
          await file.appendFile(delimiter);
        }).pipe(Effect.orDie);

        // Tracks whether the last write left the cursor mid-line (a raw chunk
        // with no trailing newline). Line-oriented entries consult this so they
        // always begin on a fresh line, keeping structured output (tool calls,
        // status, context-window summaries) off the tail of streamed prose.
        let midLine = false;

        const appendToLog = (line: string): Effect.Effect<void> =>
          Effect.suspend(() => {
            const prefix = midLine ? "\n" : "";
            midLine = false;
            return Effect.tryPromise(() =>
              file.appendFile(`${prefix}${line}\n`),
            ).pipe(Effect.ignore);
          });

        const appendRaw = (chunk: string): Effect.Effect<void> =>
          Effect.suspend(() => {
            if (chunk.length === 0) return Effect.void;
            midLine = !chunk.endsWith("\n");
            return Effect.tryPromise(() => file.appendFile(chunk)).pipe(
              Effect.ignore,
            );
          });

        return {
          intro: () => Effect.void,

          status: (message, _severity) =>
            appendToLog(message.replace(/^\[[^\]]+\] /, "")),

          spinner: (message, effect) =>
            Effect.gen(function* () {
              yield* appendToLog(`${message}...`);
              const start = Date.now();
              const result = yield* effect;
              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              yield* appendToLog(`${message} done (${elapsed}s)`);
              return result;
            }),

          progress: (title, effect) =>
            Effect.gen(function* () {
              yield* appendToLog(`${title}...`);
              const start = Date.now();
              const updates: DisplayProgressUpdate[] = [];
              const result = yield* effect((update) => updates.push(update));
              for (const update of updates) {
                yield* appendToLog(
                  `  ${update.message} (${update.current}/${update.total})`,
                );
              }
              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              yield* appendToLog(`${title} done (${elapsed}s)`);
              return result;
            }),

          summary: (title, rows) => {
            const lines = Object.entries(rows)
              .map(([key, value]) => `  ${key}: ${value}`)
              .join("\n");
            return appendToLog(`${title}\n${lines}`);
          },

          taskLog: (title, effect) =>
            Effect.gen(function* () {
              yield* appendToLog(title);
              const start = Date.now();
              const messages: string[] = [];
              const result = yield* effect((msg) => {
                messages.push(msg);
              });
              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              for (const msg of messages) {
                yield* appendToLog(`  ${msg}`);
              }
              yield* appendToLog(`${title} done (${elapsed}s)`);
              return result;
            }),

          text: (message) => appendToLog(message),

          textChunk: (chunk) => appendRaw(chunk),

          toolCall: (name, formattedArgs) =>
            appendToLog(`${name}(${formattedArgs})`),
        };
      }),
    ),
};

const severityToClack: Record<Severity, (message: string) => void> = {
  info: clack.log.info,
  success: clack.log.success,
  warn: clack.log.warning,
  error: clack.log.error,
};

export const terminalStyle = {
  status: (message: string): string => styleText("bold", message),
  summaryTitle: (title: string): string => styleText("bold", title),
  summaryRow: (key: string, value: string): string =>
    `${styleText("bold", key)}: ${styleText("dim", value)}`,
  toolCall: (text: string): string => styleText("dim", text),
};

export const ClackDisplay = {
  layer: Layer.succeed(Display, {
    intro: (title) =>
      Effect.sync(() => clack.intro(styleText("inverse", ` ${title} `))),

    status: (message, severity) =>
      Effect.sync(() =>
        severityToClack[severity](terminalStyle.status(message)),
      ),

    spinner: (message, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const s = clack.spinner();
          s.start(message);
          return s;
        }),
        () => effect,
        (s, exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success") {
              s.stop(message);
            } else {
              s.stop(`${message} (failed)`);
            }
          }),
      ),

    progress: (title, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const progress = clack.progress({ max: 100 });
          let percent = 0;
          progress.start(title);
          const report = (update: DisplayProgressUpdate): void => {
            const total = Math.max(1, update.total);
            const current = Math.min(total, Math.max(0, update.current));
            const nextPercent = Math.round((current / total) * 100);
            const message = `${update.message} (${current}/${total})`;
            if (nextPercent > percent) {
              progress.advance(nextPercent - percent, message);
            } else {
              progress.message(message);
            }
            percent = nextPercent;
          };
          return { progress, report };
        }),
        ({ report }) => effect(report),
        ({ progress }, exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success") {
              progress.stop(`${title} complete`);
            } else {
              progress.error(`${title} failed`);
            }
          }),
      ),

    summary: (title, rows) =>
      Effect.sync(() => {
        const lines = Object.entries(rows)
          .map(([key, value]) => terminalStyle.summaryRow(key, value))
          .join("\n");
        clack.note(lines, terminalStyle.summaryTitle(title));
      }),

    taskLog: (title, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => clack.taskLog({ title })),
        (log) => effect((msg) => log.message(msg)),
        (log, exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success") {
              log.success(title, { showLog: true });
            } else {
              log.error(title, { showLog: true });
            }
          }),
      ),

    text: (message) => Effect.sync(() => clack.log.message(message)),

    textChunk: (chunk) => Effect.sync(() => clack.log.message(chunk)),

    toolCall: (name, formattedArgs) =>
      Effect.sync(() =>
        clack.log.step(terminalStyle.toolCall(`${name}(${formattedArgs})`)),
      ),
  }),
};

import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  claudeHostSessionPath,
  claudeSandboxSessionPath,
  claudeSubagentsDirOnHost,
  findCodexSessionOnHost,
  listClaudeSubagentSessionsInSandbox,
  locateCodexHostSession,
  locateCodexSandboxSession,
  transferClaudeSession,
  transferCodexSession,
} from "./SessionStore.js";
import type { SessionTransferHandle } from "./SandboxProvider.js";
import { CODEX_MODELS } from "./modelConfig.js";
import type { CodexModelConfig, CodexReasoningEffort } from "./modelConfig.js";
import { shellQuote } from "./shellQuote.js";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
};

const writePrivateFile = async (
  path: string,
  content: string,
): Promise<void> => {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, content, { mode: 0o600 });
  // `mode` only applies to newly-created files.
  await chmod(path, 0o600);
};

export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "session_id"; sessionId: string }
  | { type: "usage"; usage: IterationUsage };

/** Maps allowlisted tool names to the input field containing the display arg */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

/**
 * Extract an error message from a parsed JSON error event.
 * Handles { error: "string" }, { error: { message: "string" } },
 * { error: { data: { message: "string" } } }, and { message: "string" }.
 */
const extractErrorMessage = (obj: any): string | undefined => {
  const err = obj.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    if (typeof err.message === "string") return err.message;
    if (typeof err.data?.message === "string") return err.data.message;
  }
  if (typeof obj.message === "string") return obj.message;
  return undefined;
};

const parseStreamJsonLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events: ParsedStreamEvent[] = [];
      const texts: string[] = [];
      for (const block of obj.message.content as {
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[]) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue; // not allowlisted
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue; // missing/wrong arg field
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({
            type: "tool_call",
            name: block.name,
            args: argValue,
          });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return [{ type: "result", result: obj.result }];
    }
    if (
      obj.type === "system" &&
      obj.subtype === "init" &&
      typeof obj.session_id === "string"
    ) {
      return [{ type: "session_id", sessionId: obj.session_id }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options passed to buildPrintCommand and buildInteractiveArgs. */
export interface AgentCommandOptions {
  readonly prompt: string;
  readonly dangerouslySkipPermissions: boolean;
  /** Tools the controlled phase is permitted to invoke. */
  readonly toolAllowlist?: readonly string[];
  /** When set, the agent should resume the given session ID instead of starting fresh. */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, the agent should fork the session
   * instead of mutating it — Claude's `--fork-session`, Codex's
   * `codex exec fork`. The parent session JSONL is left intact and the agent
   * writes a new session under a fresh id.
   */
  readonly forkSession?: boolean;
}

/** Return type of buildPrintCommand — command string plus optional stdin content.
 *  When `stdin` is set, the sandbox pipes it to the child process's stdin
 *  instead of inlining the prompt in argv, avoiding the Linux 128 KB per-arg limit. */
export interface PrintCommand {
  readonly command: string;
  readonly stdin?: string;
}

/** Per-iteration token usage snapshot extracted from the agent session. */
export interface IterationUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

export interface AgentSessionStorage {
  /** Transfer a session JSONL from the sandbox into the host store. */
  captureToHost(args: {
    hostCwd: string;
    sandboxCwd: string;
    sessionId: string;
    handle: SessionTransferHandle;
  }): Promise<void>;
  /** Transfer a session JSONL from the host store into the sandbox. */
  resumeIntoSandbox(args: {
    hostCwd: string;
    sandboxCwd: string;
    sessionId: string;
    handle: SessionTransferHandle;
  }): Promise<void>;
  /** Read a captured session JSONL from the host store. Returns undefined when absent. */
  readHostSession(cwd: string, sessionId: string): Promise<string | undefined>;
  /** Whether a session with the given id exists in the host store keyed on cwd. */
  existsOnHost(cwd: string, sessionId: string): Promise<boolean>;
  /** Absolute host path where a session would be stored (for not-found error messages). */
  hostSessionFilePath(cwd: string, sessionId: string): string | undefined;
}

export interface AgentProvider {
  readonly name: string;
  /** Resolved model and effort for attribution when the provider exposes them. */
  readonly model?: string;
  readonly effort?: string;
  /** Environment variables injected by this agent provider. Merged at launch time with env resolver and sandbox provider env. */
  readonly env: Record<string, string>;
  /** Set only when this provider enforces `AgentCommandOptions.toolAllowlist`. */
  readonly supportsToolAllowlist?: boolean;
  /** When true, session capture is enabled for this provider. Default: true for file-backed providers. */
  readonly captureSessions: boolean;
  /** Provider-owned storage and transfer behavior for resumable agent sessions. */
  readonly sessionStorage?: AgentSessionStorage;
  buildPrintCommand(options: AgentCommandOptions): PrintCommand;
  buildInteractiveArgs?(options: AgentCommandOptions): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
  /** Parse token usage from the captured session JSONL content. Only implemented by Claude Code. */
  parseSessionUsage?(content: string): IterationUsage | undefined;
}

const CONFIGURED_CODEX_MODEL_EFFORTS = new Map(
  Object.values(CODEX_MODELS).map(({ model, effort }) => [model, effort]),
);

// ---------------------------------------------------------------------------
// Session storage helpers — file I/O lives here so callers (Orchestrator,
// resumePrecheck) work against the high-level AgentSessionStorage interface
// and tests can exercise transferClaudeSession / transferCodexSession as
// pure string functions.
// ---------------------------------------------------------------------------

const readSandboxFile = async (
  handle: Pick<SessionTransferHandle, "copyFileOut">,
  sandboxPath: string,
  tag: string,
): Promise<string> => {
  const tempDir = await mkdtemp(
    join(tmpdir(), `shipyard-${tag.replace(/[^A-Za-z0-9_-]/g, "-")}-`),
  );
  const tmpPath = join(tempDir, "session.jsonl");
  try {
    await handle.copyFileOut(sandboxPath, tmpPath);
    const info = await lstat(tmpPath);
    if (!info.isFile())
      throw new Error("Sandbox session must be a regular file");
    const file = await open(tmpPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile())
        throw new Error("Sandbox session must be a regular file");
      return await file.readFile("utf-8");
    } finally {
      await file.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

const writeSandboxFile = async (
  handle: Pick<SessionTransferHandle, "copyFileIn" | "exec">,
  sandboxPath: string,
  content: string,
  tag: string,
): Promise<void> => {
  const tempDir = await mkdtemp(
    join(tmpdir(), `shipyard-${tag.replace(/[^A-Za-z0-9_-]/g, "-")}-`),
  );
  const tmpPath = join(tempDir, "session.jsonl");
  try {
    await writeFile(tmpPath, content, { mode: 0o600 });
    await handle.exec(`mkdir -p ${shellQuote(posix.dirname(sandboxPath))}`);
    await handle.copyFileIn(tmpPath, sandboxPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * Read a Claude JSONL out of the sandbox, rewrite its `cwd` fields from
 * `fromCwd` → `toCwd`, and write the result to `destPath` on the host. Used
 * by `captureToHost` for both the main session file and each subagent /
 * workflow transcript — the read→rewrite→ensure-dir→write sequence is
 * identical, only the source/dest paths differ.
 */
const copyClaudeSessionFile = async ({
  handle,
  sourcePath,
  fromCwd,
  toCwd,
  destPath,
  tag,
}: {
  handle: Pick<SessionTransferHandle, "copyFileOut">;
  sourcePath: string;
  fromCwd: string;
  toCwd: string;
  destPath: string;
  tag: string;
}): Promise<void> => {
  const jsonl = await readSandboxFile(handle, sourcePath, tag);
  const rewritten = transferClaudeSession(jsonl, fromCwd, toCwd);
  await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
  await writePrivateFile(destPath, rewritten);
};

const makeClaudeSessionStorage = (
  options?: ClaudeCodeOptions,
): AgentSessionStorage => {
  const hostProjectsDir = options?.sessionStorage?.hostProjectsDir;
  const sandboxProjectsDir =
    options?.sessionStorage?.sandboxProjectsDir ??
    "/home/agent/.claude/projects";

  return {
    hostSessionFilePath: (cwd, id) =>
      claudeHostSessionPath(cwd, id, hostProjectsDir),
    existsOnHost: (cwd, id) =>
      fileExists(claudeHostSessionPath(cwd, id, hostProjectsDir)),
    readHostSession: async (cwd, id) => {
      const path = claudeHostSessionPath(cwd, id, hostProjectsDir);
      if (!(await fileExists(path))) return undefined;
      return readFile(path, "utf-8");
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      // Main session: failure is fatal — the user expects their session.
      await copyClaudeSessionFile({
        handle,
        sourcePath: claudeSandboxSessionPath(
          sandboxCwd,
          sessionId,
          sandboxProjectsDir,
        ),
        fromCwd: sandboxCwd,
        toCwd: hostCwd,
        destPath: claudeHostSessionPath(hostCwd, sessionId, hostProjectsDir),
        tag: "claude-cap",
      });

      // Subagent / workflow transcripts: best-effort. A missing `subagents/`
      // dir is the normal case (no Agent-tool / Workflow usage this run);
      // an individual subagent failing to copy must not abort siblings or
      // the (already-successful) main capture.
      const subagentSandboxPaths = await listClaudeSubagentSessionsInSandbox(
        sandboxCwd,
        sessionId,
        handle,
        sandboxProjectsDir,
      );
      const hostSubagentsDir = claudeSubagentsDirOnHost(
        hostCwd,
        sessionId,
        hostProjectsDir,
      );
      for (const sandboxSubagentPath of subagentSandboxPaths) {
        try {
          await copyClaudeSessionFile({
            handle,
            sourcePath: sandboxSubagentPath,
            fromCwd: sandboxCwd,
            toCwd: hostCwd,
            destPath: join(
              hostSubagentsDir,
              posix.basename(sandboxSubagentPath),
            ),
            tag: "claude-sub",
          });
        } catch (err) {
          console.error(
            `shipyard: failed to capture Claude subagent transcript ${sandboxSubagentPath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const hostPath = claudeHostSessionPath(
        hostCwd,
        sessionId,
        hostProjectsDir,
      );
      const jsonl = await readFile(hostPath, "utf-8");
      const rewritten = transferClaudeSession(jsonl, hostCwd, sandboxCwd);
      const sandboxPath = claudeSandboxSessionPath(
        sandboxCwd,
        sessionId,
        sandboxProjectsDir,
      );
      await writeSandboxFile(handle, sandboxPath, rewritten, "claude-res");
    },
  };
};

const makeCodexSessionStorage = (
  options?: CodexOptions,
): AgentSessionStorage => {
  const hostSessionsDir = options?.sessionStorage?.hostSessionsDir;
  const sandboxSessionsDir =
    options?.sessionStorage?.sandboxSessionsDir ??
    posix.join("/home/agent", ".codex", "sessions");

  // Codex sessions live at YYYY/MM/DD/rollout-*-<id>.jsonl — the path is not
  // derivable from (cwd, id) alone, so we cache the path written by
  // captureToHost for hostSessionFilePath to surface on the IterationResult.
  const capturedPaths = new Map<string, string>();

  return {
    hostSessionFilePath: (_cwd, id) => capturedPaths.get(id),
    existsOnHost: async (_cwd, id) => {
      const found = await findCodexSessionOnHost(id, hostSessionsDir);
      return found.path !== undefined;
    },
    readHostSession: async (_cwd, id) => {
      const found = await findCodexSessionOnHost(id, hostSessionsDir);
      if (!found.path) return undefined;
      return readFile(found.path, "utf-8");
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locateCodexSandboxSession(
        sessionId,
        handle,
        sandboxSessionsDir,
      );
      const jsonl = await readSandboxFile(handle, located.path, "codex-cap");
      const rewritten = transferCodexSession(jsonl, sandboxCwd, hostCwd);
      const root = hostSessionsDir ?? join(homedir(), ".codex", "sessions");
      const target = join(root, located.relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writePrivateFile(target, rewritten);
      capturedPaths.set(sessionId, target);
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locateCodexHostSession(sessionId, hostSessionsDir);
      const jsonl = await readFile(located.path, "utf-8");
      const rewritten = transferCodexSession(jsonl, hostCwd, sandboxCwd);
      const target = posix.join(sandboxSessionsDir, located.relativePath);
      await writeSandboxFile(handle, target, rewritten, "codex-res");
    },
  };
};

// ---------------------------------------------------------------------------
// Codex agent provider
// ---------------------------------------------------------------------------

/**
 * Map a Codex `turn.completed` usage object to the Claude-shaped IterationUsage.
 *
 * OpenAI/Codex usage is `{ input_tokens, cached_input_tokens, output_tokens }`,
 * where `input_tokens` is the *total* prompt tokens and `cached_input_tokens` is
 * a subset already included in that total. There is no cache-creation concept.
 * To avoid double-counting cached tokens in the context-window display (which
 * sums input + cacheCreation + cacheRead), the cached portion maps to
 * `cacheReadInputTokens` and the remainder to `inputTokens`.
 */
const parseCodexUsage = (usage: unknown): IterationUsage | undefined => {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  if (
    typeof u.input_tokens !== "number" ||
    typeof u.cached_input_tokens !== "number" ||
    typeof u.output_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    inputTokens: u.input_tokens - u.cached_input_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: u.cached_input_tokens,
    outputTokens: u.output_tokens,
  };
};

const parseCodexStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);

    if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
      return [{ type: "session_id", sessionId: obj.thread_id }];
    }

    // item.completed with agent_message → text + result
    if (
      obj.type === "item.completed" &&
      obj.item?.type === "agent_message" &&
      typeof obj.item.text === "string"
    ) {
      const text = obj.item.text;
      return [
        { type: "text", text },
        { type: "result", result: text },
      ];
    }

    // item.started with command_execution → tool call
    if (
      obj.type === "item.started" &&
      obj.item?.type === "command_execution" &&
      typeof obj.item.command === "string"
    ) {
      return [{ type: "tool_call", name: "Bash", args: obj.item.command }];
    }

    // Codex emits error events on stdout (not stderr) for auth failures,
    // rate limits, and API errors. Capture them as result events so the
    // Orchestrator's stderr-empty fallback can surface them to the user.
    if (obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }

    // turn.completed carries token usage for the turn.
    if (obj.type === "turn.completed") {
      const usage = parseCodexUsage(obj.usage);
      return usage ? [{ type: "usage", usage }] : [];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the codex agent provider. */
export interface CodexOptions {
  readonly effort?: CodexReasoningEffort;
  /** Disable nested agent tools for a bounded single-agent run. */
  readonly disableSubagents?: boolean;
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
  /** Override Codex session directories for tests or non-standard installs. */
  readonly sessionStorage?: {
    readonly hostSessionsDir?: string;
    readonly sandboxSessionsDir?: string;
  };
  /**
   * Maps to Codex's `approvals_reviewer` config key (set via
   * `-c approvals_reviewer="<value>"`). When set to `"auto_review"`, the
   * provider swaps the default `--dangerously-bypass-approvals-and-sandbox`
   * for an interactive approval policy (`-a on-request`) and Codex's most
   * permissive sandbox (`-s danger-full-access`) — auto-review needs
   * something to review, and the safety boundary is the reviewer agent
   * rather than the filesystem sandbox.
   */
  readonly approvalsReviewer?: "user" | "auto_review";
}

export const codex = (
  model: string | CodexModelConfig,
  options?: CodexOptions,
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => {
  const modelId = typeof model === "string" ? model : model.model;
  const effort =
    options?.effort ??
    (typeof model === "string"
      ? CONFIGURED_CODEX_MODEL_EFFORTS.get(modelId)
      : model.effort);

  // Configured Shipyard Codex model roles carry their own reasoning setting;
  // callers can still override it through CodexOptions.
  return {
    name: "codex",
    model: modelId,
    effort,
    env: options?.env ?? {},
    captureSessions: options?.captureSessions ?? true,
    sessionStorage: makeCodexSessionStorage(options),

    buildPrintCommand({
      prompt,
      resumeSession,
      forkSession,
    }: AgentCommandOptions): PrintCommand {
      const effortFlag = effort
        ? ` -c ${shellQuote(`model_reasoning_effort="${effort}"`)}`
        : "";
      const subagentFlag = options?.disableSubagents
        ? " -c agents.enabled=false"
        : "";
      // auto_review only fires on interactive approvals, so the bypass flag is
      // dropped in favour of `-a on-request`. `-s danger-full-access` disables
      // Codex's own filesystem sandbox — Shipyard owns that boundary, and
      // here the reviewer agent owns the per-action approval boundary.
      const approvalsFlags =
        options?.approvalsReviewer === "auto_review"
          ? ` -a on-request -s danger-full-access -c ${shellQuote(`approvals_reviewer="auto_review"`)}`
          : " --dangerously-bypass-approvals-and-sandbox";
      // Codex distinguishes fork from resume at the verb level — `codex exec
      // fork <id>` leaves the parent rollout intact; `codex exec resume <id>`
      // appends to it. See ADR 0018.
      let base: string;
      if (resumeSession && forkSession) {
        base = `codex exec fork ${shellQuote(resumeSession)}`;
      } else if (resumeSession) {
        base = `codex exec resume ${shellQuote(resumeSession)}`;
      } else {
        base = "codex exec";
      }
      const stdinArg = resumeSession ? " -" : "";
      return {
        command: `${base} --json${approvalsFlags} -m ${shellQuote(modelId)}${effortFlag}${subagentFlag}${stdinArg}`,
        stdin: prompt,
      };
    },

    buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
      const args = ["codex", "--model", modelId];
      if (effort) {
        args.push("-c", `model_reasoning_effort="${effort}"`);
      }
      if (options?.disableSubagents) args.push("-c", "agents.enabled=false");
      if (prompt) args.push(prompt);
      return args;
    },

    parseStreamLine(line: string): ParsedStreamEvent[] {
      return parseCodexStreamLine(line);
    },
  };
};

// ---------------------------------------------------------------------------
// Claude Code agent provider
// ---------------------------------------------------------------------------

export interface ClaudeCodeOptions {
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Deny the Agent tool for a bounded single-agent run. */
  readonly disableSubagents?: boolean;
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
  /** Override Claude session directories for tests or non-standard installs. */
  readonly sessionStorage?: {
    readonly hostProjectsDir?: string;
    readonly sandboxProjectsDir?: string;
  };
  /**
   * Maps directly to Claude's `--permission-mode` flag. When set, replaces the
   * default `--dangerously-skip-permissions` Shipyard passes on AFK runs —
   * the two flags are mutually exclusive on Claude's CLI. Use `"auto"` for
   * AI-mediated per-tool approve/deny on unsandboxed host runs.
   */
  readonly permissionMode?:
    | "default"
    | "acceptEdits"
    | "plan"
    | "auto"
    | "dontAsk"
    | "bypassPermissions";
}

export const claudeCode = (
  model: string,
  options?: ClaudeCodeOptions,
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => ({
  name: "claude-code",
  model,
  effort: options?.effort,
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: makeClaudeSessionStorage(options),

  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
    resumeSession,
    forkSession,
  }: AgentCommandOptions): PrintCommand {
    // permissionMode and --dangerously-skip-permissions are mutually exclusive
    // on Claude's CLI; an explicit mode on the provider takes precedence over
    // Shipyard's default bypass.
    const permissionFlag = options?.permissionMode
      ? ` --permission-mode ${options.permissionMode}`
      : dangerouslySkipPermissions
        ? " --dangerously-skip-permissions"
        : "";
    const effortFlag = options?.effort ? ` --effort ${options.effort}` : "";
    const subagentFlag = options?.disableSubagents
      ? " --disallowedTools Agent"
      : "";
    const resumeFlag = resumeSession
      ? ` --resume ${shellQuote(resumeSession)}`
      : "";
    // --fork-session is meaningful only alongside --resume; it tells Claude
    // to write the continuation as a new session rather than mutating the
    // resumed one. See ADR 0018.
    const forkFlag = resumeSession && forkSession ? " --fork-session" : "";
    return {
      command: `claude --print --verbose${permissionFlag} --output-format stream-json --model ${shellQuote(model)}${effortFlag}${subagentFlag}${resumeFlag}${forkFlag} -p -`,
      stdin: prompt,
    };
  },

  buildInteractiveArgs({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): string[] {
    const args = ["claude"];
    if (options?.permissionMode) {
      args.push("--permission-mode", options.permissionMode);
    } else if (dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    args.push("--model", model);
    if (options?.effort) args.push("--effort", options.effort);
    if (options?.disableSubagents) args.push("--disallowedTools", "Agent");
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseStreamJsonLine(line);
  },

  parseSessionUsage(content: string): IterationUsage | undefined {
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant" && obj.message?.usage) {
          const u = obj.message.usage;
          if (
            typeof u.input_tokens === "number" &&
            typeof u.cache_creation_input_tokens === "number" &&
            typeof u.cache_read_input_tokens === "number" &&
            typeof u.output_tokens === "number"
          ) {
            return {
              inputTokens: u.input_tokens,
              cacheCreationInputTokens: u.cache_creation_input_tokens,
              cacheReadInputTokens: u.cache_read_input_tokens,
              outputTokens: u.output_tokens,
            };
          }
        }
      } catch {
        // Not valid JSON — skip
      }
    }
    return undefined;
  },
});

import { toSessionTransferHandle } from "./SandboxProvider.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCode, codex } from "./AgentProvider.js";
import type { AgentCommandOptions } from "./AgentProvider.js";
import type { SessionTransferHandle } from "./SandboxProvider.js";
import { CODEX_MODELS, CODEX_REASONING_EFFORTS } from "./modelConfig.js";

/** Shorthand: build options with dangerouslySkipPermissions: true (mirrors existing sandbox callers). */
const opts = (prompt: string): AgentCommandOptions => ({
  prompt,
  dangerouslySkipPermissions: true,
});

describe("claudeCode factory", () => {
  it("returns a provider with name 'claude-code'", () => {
    const provider = claudeCode("claude-opus-4-8");
    expect(provider.name).toBe("claude-code");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = claudeCode("claude-opus-4-8");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model", () => {
    const provider = claudeCode("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--print");
  });

  it("buildPrintCommand delivers prompt via stdin, not argv", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("-p -");
    expect(command).not.toContain("'do something'");
    expect(stdin).toBe("do something");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'claude-opus-4-8'");
  });

  it("rejects a model containing a NUL byte", () => {
    const provider = claudeCode("invalid\0model");
    expect(() => provider.buildPrintCommand(opts("do something"))).toThrow(
      "Cannot quote a string containing a NUL byte",
    );
  });

  it("parseStreamLine extracts text from assistant message", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts result from result message", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
      },
    ]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = claudeCode("claude-opus-4-8");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine extracts tool_use block (Bash → command arg)", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine bakes model into each provider instance independently", () => {
    const provider1 = claudeCode("model-a");
    const provider2 = claudeCode("model-b");
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });

  it("buildPrintCommand includes --effort when specified", () => {
    const provider = claudeCode("claude-opus-4-8", { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--effort high");
  });

  it("buildPrintCommand omits --effort when not specified", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("buildPrintCommand omits --effort when options is empty", () => {
    const provider = claudeCode("claude-opus-4-8", {});
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("supports all effort levels", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const provider = claudeCode("claude-opus-4-8", { effort });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        `--effort ${effort}`,
      );
    }
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = claudeCode("claude-opus-4-8", {
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(provider.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = claudeCode("claude-opus-4-8");
    expect(provider.env).toEqual({});
  });

  // --- dangerouslySkipPermissions conditional tests ---

  it("buildPrintCommand includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("parseStreamLine emits session_id from Claude Code init line", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123-def",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "session_id", sessionId: "abc-123-def" },
    ]);
  });

  it("parseStreamLine ignores system events without subtype init", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "system",
      subtype: "other",
      session_id: "abc-123-def",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine ignores system init without session_id", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("buildPrintCommand includes --resume when resumeSession is set", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("--resume 'abc-123'");
  });

  it("buildPrintCommand omits --resume when resumeSession is not set", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).not.toContain("--resume");
  });

  it("buildPrintCommand appends --fork-session when resumeSession + forkSession are set", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: true,
    });
    expect(command).toContain("--resume 'abc-123'");
    expect(command).toContain("--fork-session");
  });

  it("buildPrintCommand omits --fork-session when forkSession is set without resumeSession", () => {
    // RunOptions validation rejects this combination, but buildPrintCommand
    // is permissive and should simply not emit a meaningless flag.
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      forkSession: true,
    });
    expect(command).not.toContain("--fork-session");
    expect(command).not.toContain("--resume");
  });

  it("buildPrintCommand omits --fork-session when forkSession is false", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: false,
    });
    expect(command).toContain("--resume 'abc-123'");
    expect(command).not.toContain("--fork-session");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-8");
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-8");
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  // --- permissionMode option ---

  it("buildPrintCommand emits --permission-mode when permissionMode is set", () => {
    const provider = claudeCode("claude-opus-4-8", { permissionMode: "auto" });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("--permission-mode auto");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when permissionMode is set", () => {
    // Shipyard's AFK call sites pass dangerouslySkipPermissions: true. When the
    // user opts into a specific permission mode on the provider, that mode takes
    // precedence over the default bypass — they are mutually exclusive on claude's CLI.
    const provider = claudeCode("claude-opus-4-8", { permissionMode: "auto" });
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildPrintCommand omits --permission-mode when permissionMode is not set", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).not.toContain("--permission-mode");
  });

  it("buildInteractiveArgs emits --permission-mode when permissionMode is set", () => {
    const provider = claudeCode("claude-opus-4-8", { permissionMode: "plan" });
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
  });

  it("buildInteractiveArgs omits --dangerously-skip-permissions when permissionMode is set", () => {
    const provider = claudeCode("claude-opus-4-8", { permissionMode: "auto" });
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});
// ---------------------------------------------------------------------------
// codex factory
// ---------------------------------------------------------------------------

describe("codex factory", () => {
  it("returns a provider with name 'codex'", () => {
    const provider = codex(CODEX_MODELS.routine);
    expect(provider.name).toBe("codex");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = codex(CODEX_MODELS.routine);
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model and --json flag", () => {
    const provider = codex(CODEX_MODELS.routine);
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain(CODEX_MODELS.routine.model);
    expect(command).toContain("--json");
  });

  it("buildPrintCommand delivers prompt via stdin, not argv", () => {
    const provider = codex(CODEX_MODELS.routine);
    const { command, stdin } = provider.buildPrintCommand(opts("it's a test"));
    expect(command).not.toContain("it's a test");
    expect(stdin).toBe("it's a test");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = codex(CODEX_MODELS.routine);
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain(`-m '${CODEX_MODELS.routine.model}'`);
  });

  it("buildPrintCommand includes model reasoning effort config when specified", () => {
    const provider = codex(CODEX_MODELS.routine, { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain(`-c 'model_reasoning_effort="high"'`);
  });

  it("buildPrintCommand resumes with stdin prompt when resumeSession is set", () => {
    const provider = codex(CODEX_MODELS.routine, { effort: "high" });
    const { command, stdin } = provider.buildPrintCommand({
      prompt: "continue",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("codex exec resume 'abc-123'");
    expect(command).toContain("--json");
    expect(command).toContain(`-m '${CODEX_MODELS.routine.model}'`);
    expect(command).toContain(`-c 'model_reasoning_effort="high"'`);
    expect(command.endsWith(" -")).toBe(true);
    expect(stdin).toBe("continue");
  });

  it("buildPrintCommand uses `codex exec fork` when resumeSession + forkSession are set", () => {
    const provider = codex(CODEX_MODELS.routine, { effort: "high" });
    const { command, stdin } = provider.buildPrintCommand({
      prompt: "branch off",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: true,
    });
    expect(command).toContain("codex exec fork 'abc-123'");
    expect(command).not.toContain("codex exec resume");
    expect(command).toContain("--json");
    expect(command).toContain(`-m '${CODEX_MODELS.routine.model}'`);
    expect(command.endsWith(" -")).toBe(true);
    expect(stdin).toBe("branch off");
  });

  it("buildPrintCommand stays on `codex exec resume` when forkSession is false", () => {
    const provider = codex(CODEX_MODELS.routine);
    const { command } = provider.buildPrintCommand({
      prompt: "continue",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: false,
    });
    expect(command).toContain("codex exec resume 'abc-123'");
    expect(command).not.toContain("codex exec fork");
  });

  it("buildPrintCommand ignores forkSession without resumeSession", () => {
    const provider = codex(CODEX_MODELS.routine);
    const { command } = provider.buildPrintCommand({
      prompt: "fresh start",
      dangerouslySkipPermissions: true,
      forkSession: true,
    });
    expect(command).toContain("codex exec --json");
    expect(command).not.toContain("codex exec fork");
    expect(command).not.toContain("codex exec resume");
  });

  it("buildPrintCommand omits model reasoning effort config when not specified", () => {
    const provider = codex("test-model");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("model_reasoning_effort");
  });

  it("uses the routine role's configured reasoning effort", () => {
    const provider = codex(CODEX_MODELS.routine);
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain(
      `model_reasoning_effort="${CODEX_MODELS.routine.effort}"`,
    );
  });

  it("uses the strong role's configured reasoning effort", () => {
    const provider = codex(CODEX_MODELS.strong);
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain(
      `model_reasoning_effort="${CODEX_MODELS.strong.effort}"`,
    );
  });

  it("supports all codex effort levels", () => {
    for (const effort of CODEX_REASONING_EFFORTS) {
      const provider = codex(CODEX_MODELS.routine, { effort });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        `model_reasoning_effort="${effort}"`,
      );
    }
  });

  // --- approvalsReviewer option ---

  it("buildPrintCommand sets approvals_reviewer config when approvalsReviewer is 'auto_review'", () => {
    const provider = codex(CODEX_MODELS.routine, {
      approvalsReviewer: "auto_review",
    });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain(`-c 'approvals_reviewer="auto_review"'`);
  });

  it("buildPrintCommand drops --dangerously-bypass-approvals-and-sandbox when approvalsReviewer is 'auto_review'", () => {
    // auto_review only applies to interactive approvals — the bypass flag would
    // silence them entirely, defeating the reviewer agent.
    const provider = codex(CODEX_MODELS.routine, {
      approvalsReviewer: "auto_review",
    });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("buildPrintCommand emits -a on-request and -s danger-full-access when approvalsReviewer is 'auto_review'", () => {
    // Approvals must be interactive for the reviewer to have anything to evaluate;
    // codex's own filesystem sandbox is disabled because the safety boundary is the reviewer.
    const provider = codex(CODEX_MODELS.routine, {
      approvalsReviewer: "auto_review",
    });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("-a on-request");
    expect(command).toContain("-s danger-full-access");
  });

  it("buildPrintCommand keeps --dangerously-bypass-approvals-and-sandbox when approvalsReviewer is unset", () => {
    const provider = codex(CODEX_MODELS.routine);
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("buildPrintCommand omits approvals_reviewer config when approvalsReviewer is unset", () => {
    const provider = codex(CODEX_MODELS.routine);
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).not.toContain("approvals_reviewer");
  });

  it("parseStreamLine extracts session id from thread.started", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "thread.started",
      thread_id: "9ba1c695-2222-4444-8888-e7e847bf34dd",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "session_id",
        sessionId: "9ba1c695-2222-4444-8888-e7e847bf34dd",
      },
    ]);
  });

  it("parseStreamLine extracts text and result from item.completed agent_message", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Hello world" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
      { type: "result", result: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts tool call from item.started command_execution", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "npm test" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine skips turn.completed events without usage", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({ type: "turn.completed" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts usage from turn.completed", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 8497,
        cached_input_tokens: 8448,
        output_tokens: 51,
      },
    });
    // OpenAI semantics: input_tokens is the total prompt count and
    // cached_input_tokens is a subset already included. Map cached tokens to
    // cache-read and the remainder to input so the context-window display does
    // not double-count them.
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 49,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 8448,
          outputTokens: 51,
        },
      },
    ]);
  });

  it("parseStreamLine skips turn.completed with malformed usage", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: "lots", output_tokens: 51 },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = codex(CODEX_MODELS.routine);
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = codex(CODEX_MODELS.routine);
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
  });

  it("parseStreamLine handles item.completed with missing text", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine does not extract from item.content (array form), only item.text", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        content: [{ type: "text", text: "from content array" }],
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles item.started with missing command", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles item.completed with non-agent_message type", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "other_type", content: "foo" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles item.started with non-command_execution type", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "other_type", command: "foo" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = codex("model-a");
    const provider2 = codex("model-b");
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });

  // --- error event parsing tests ---

  it("parseStreamLine captures error event with nested error object as result", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "error",
      error: { type: "server_error", message: "Internal server error" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Internal server error" },
    ]);
  });

  it("parseStreamLine captures error event with string error as result", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "error",
      error: "Authentication failed: invalid API key",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Authentication failed: invalid API key" },
    ]);
  });

  it("parseStreamLine captures error event with top-level message as result", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "error",
      message: "Rate limit exceeded",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Rate limit exceeded" },
    ]);
  });

  it("parseStreamLine returns empty array for error event with no extractable message", () => {
    const provider = codex(CODEX_MODELS.routine);
    const line = JSON.stringify({
      type: "error",
      code: "unknown",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = codex(CODEX_MODELS.routine, {
      env: { OPENAI_KEY: "xyz" },
    });
    expect(provider.env).toEqual({ OPENAI_KEY: "xyz" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = codex(CODEX_MODELS.routine);
    expect(provider.env).toEqual({});
  });
});
describe("parseSessionUsage (Claude Code)", () => {
  const provider = claudeCode("claude-opus-4-8");

  it("extracts usage from the last assistant message in a JSONL string", () => {
    const content = [
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
            output_tokens: 50,
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 9294,
            cache_read_input_tokens: 8526,
            output_tokens: 458,
          },
        },
      }),
    ].join("\n");

    expect(provider.parseSessionUsage!(content)).toEqual({
      inputTokens: 3,
      cacheCreationInputTokens: 9294,
      cacheReadInputTokens: 8526,
      outputTokens: 458,
    });
  });

  it("returns undefined for empty content", () => {
    expect(provider.parseSessionUsage!("")).toBeUndefined();
  });

  it("returns undefined for content with no assistant messages", () => {
    const content = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n");
    expect(provider.parseSessionUsage!(content)).toBeUndefined();
  });

  it("returns undefined when assistant message has no usage block", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "hi" }],
      },
    });
    expect(provider.parseSessionUsage!(content)).toBeUndefined();
  });

  it("returns undefined for malformed JSON lines", () => {
    const content = "not json\n{bad json\n";
    expect(provider.parseSessionUsage!(content)).toBeUndefined();
  });

  it("skips malformed lines and finds valid assistant message", () => {
    const content = [
      "not json",
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 40,
          },
        },
      }),
    ].join("\n");

    expect(provider.parseSessionUsage!(content)).toEqual({
      inputTokens: 10,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
      outputTokens: 40,
    });
  });

  it("is not defined on codex provider", () => {
    expect(codex("model").parseSessionUsage).toBeUndefined();
  });
});

describe("captureSessions flag", () => {
  it("claudeCode defaults captureSessions to true", () => {
    expect(claudeCode("claude-opus-4-8").captureSessions).toBe(true);
  });

  it("claudeCode allows opting out of captureSessions", () => {
    expect(
      claudeCode("claude-opus-4-8", { captureSessions: false }).captureSessions,
    ).toBe(false);
  });
  it("codex defaults captureSessions to true", () => {
    expect(codex("codex-model").captureSessions).toBe(true);
  });

  it("codex allows opting out of captureSessions", () => {
    expect(
      codex("codex-model", { captureSessions: false }).captureSessions,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sessionStorage — captureToHost populates hostSessionFilePath
// ---------------------------------------------------------------------------

describe("sessionStorage", () => {
  /** Bind-mount handle backed by the host filesystem (sandbox path == host path). */
  const fsBindMountHandle = (): SessionTransferHandle => ({
    worktreePath: "/workspace",
    exec: async (command) => {
      const { exec } = await import("node:child_process");
      return new Promise((resolve) => {
        exec(command, (err, stdout, stderr) => {
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: err && typeof err.code === "number" ? err.code : 0,
          });
        });
      });
    },
    copyFileIn: async (hostPath, sandboxPath) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(hostPath, sandboxPath);
    },
    copyFileOut: async (sandboxPath, hostPath) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(sandboxPath, hostPath);
    },
    close: async () => {},
  });

  it("claudeCode hostSessionFilePath is derivable without capture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shipyard-claude-hostpath-"));
    try {
      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: { hostProjectsDir: dir },
      });
      // Path is purely a function of (cwd, id) — available before any capture.
      const path = provider.sessionStorage!.hostSessionFilePath(
        "/some/cwd",
        "abc-123",
      );
      expect(path).toContain("-some-cwd");
      expect(path).toContain("abc-123.jsonl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("codex hostSessionFilePath returns the captured rollout file after captureToHost", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "shipyard-codex-hostpath-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "shipyard-codex-sbx-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      // Stage a sandbox-side rollout file mirroring Codex's YYYY/MM/DD layout.
      const relativePath = posix.join(
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${id}.jsonl`,
      );
      const sandboxRollout = join(sandboxDir, relativePath);
      await mkdir(join(sandboxRollout, ".."), { recursive: true });
      await writeFile(
        sandboxRollout,
        JSON.stringify({
          type: "session_meta",
          payload: { id, cwd: "/sandbox/repo" },
        }),
      );

      const provider = codex(CODEX_MODELS.routine, {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxSessionsDir: sandboxDir,
        },
      });

      // Before capture, the path is unknown.
      expect(
        provider.sessionStorage!.hostSessionFilePath("/host/repo", id),
      ).toBeUndefined();

      await provider.sessionStorage!.captureToHost({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      // After capture, the path resolves to the rewritten rollout under hostDir.
      const captured = provider.sessionStorage!.hostSessionFilePath(
        "/host/repo",
        id,
      );
      expect(captured).toBe(join(hostDir, relativePath));
      const content = await readFile(captured!, "utf-8");
      expect(JSON.parse(content).payload.cwd).toBe("/host/repo");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("claudeCode captureToHost copies the main session when no subagents dir exists", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "shipyard-claude-sub-main-"));
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "shipyard-claude-sub-sbx-"),
    );
    try {
      const id = "session-only";
      const hostCwd = "/host/repo";
      const sandboxCwd = "/sandbox/repo";
      const sandboxProjectDir = join(sandboxDir, "-sandbox-repo");
      await mkdir(sandboxProjectDir, { recursive: true });
      const sandboxMain = join(sandboxProjectDir, `${id}.jsonl`);
      await writeFile(
        sandboxMain,
        JSON.stringify({ type: "system", cwd: sandboxCwd }),
      );

      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: {
          hostProjectsDir: hostDir,
          sandboxProjectsDir: sandboxDir,
        },
      });

      await provider.sessionStorage!.captureToHost({
        hostCwd,
        sandboxCwd,
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      const expectedHostPath = join(hostDir, "-host-repo", `${id}.jsonl`);
      const main = await readFile(expectedHostPath, "utf-8");
      expect(JSON.parse(main).cwd).toBe(hostCwd);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("claudeCode captureToHost copies subagent/workflow logs alongside the main session with cwd rewritten", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "shipyard-claude-sub-many-"));
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "shipyard-claude-sub-many-sbx-"),
    );
    try {
      const id = "session-with-subagents";
      const hostCwd = "/host/repo";
      const sandboxCwd = "/sandbox/repo";
      const sandboxProjectDir = join(sandboxDir, "-sandbox-repo");
      const sandboxSubagentsDir = join(sandboxProjectDir, id, "subagents");
      await mkdir(sandboxSubagentsDir, { recursive: true });

      // Main session
      await writeFile(
        join(sandboxProjectDir, `${id}.jsonl`),
        JSON.stringify({ type: "system", cwd: sandboxCwd }),
      );

      // Two subagent transcripts (each line carries top-level cwd)
      const alphaLines = [
        JSON.stringify({ type: "system", cwd: sandboxCwd, agent: "alpha" }),
        JSON.stringify({ type: "message", cwd: sandboxCwd, text: "a-msg" }),
      ].join("\n");
      const betaLines = [
        JSON.stringify({ type: "system", cwd: sandboxCwd, agent: "beta" }),
        JSON.stringify({ type: "message", cwd: sandboxCwd, text: "b-msg" }),
      ].join("\n");
      await writeFile(
        join(sandboxSubagentsDir, "agent-alpha.jsonl"),
        alphaLines,
      );
      await writeFile(join(sandboxSubagentsDir, "agent-beta.jsonl"), betaLines);

      // A non-matching sibling — must NOT be copied to the host.
      await writeFile(join(sandboxSubagentsDir, "notes.txt"), "ignore me");

      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: {
          hostProjectsDir: hostDir,
          sandboxProjectsDir: sandboxDir,
        },
      });

      await provider.sessionStorage!.captureToHost({
        hostCwd,
        sandboxCwd,
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      // Main session captured with cwd rewritten.
      const mainContent = await readFile(
        join(hostDir, "-host-repo", `${id}.jsonl`),
        "utf-8",
      );
      expect(JSON.parse(mainContent).cwd).toBe(hostCwd);

      // Both subagent transcripts captured with cwd rewritten on every line.
      const hostSubagentsDir = join(hostDir, "-host-repo", id, "subagents");
      const alpha = await readFile(
        join(hostSubagentsDir, "agent-alpha.jsonl"),
        "utf-8",
      );
      for (const line of alpha.split("\n")) {
        expect(JSON.parse(line).cwd).toBe(hostCwd);
      }
      const beta = await readFile(
        join(hostSubagentsDir, "agent-beta.jsonl"),
        "utf-8",
      );
      for (const line of beta.split("\n")) {
        expect(JSON.parse(line).cwd).toBe(hostCwd);
      }

      // The non-matching sibling must not have been copied.
      await expect(
        readFile(join(hostSubagentsDir, "notes.txt"), "utf-8"),
      ).rejects.toThrow();
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("claudeCode captureToHost: a failing subagent copy logs a warning and lets siblings + main session through", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "shipyard-claude-sub-fail-"));
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "shipyard-claude-sub-fail-sbx-"),
    );
    try {
      const id = "session-flaky-sub";
      const hostCwd = "/host/repo";
      const sandboxCwd = "/sandbox/repo";
      const sandboxProjectDir = join(sandboxDir, "-sandbox-repo");
      const sandboxSubagentsDir = join(sandboxProjectDir, id, "subagents");
      await mkdir(sandboxSubagentsDir, { recursive: true });

      // Main session
      await writeFile(
        join(sandboxProjectDir, `${id}.jsonl`),
        JSON.stringify({ type: "system", cwd: sandboxCwd }),
      );
      // Good subagent
      await writeFile(
        join(sandboxSubagentsDir, "agent-good.jsonl"),
        JSON.stringify({ type: "system", cwd: sandboxCwd, agent: "good" }),
      );
      // Bad subagent: enumerated by find but fails on read (copyFileOut).
      await writeFile(
        join(sandboxSubagentsDir, "agent-bad.jsonl"),
        JSON.stringify({ type: "system", cwd: sandboxCwd, agent: "bad" }),
      );

      // Spy: drop console.error so the test output stays clean and we can
      // assert that exactly one warning was emitted.
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (msg: unknown, ...rest: unknown[]) => {
        errors.push(
          [msg, ...rest]
            .map((v) => (v instanceof Error ? v.message : String(v)))
            .join(" "),
        );
      };

      try {
        // Decorate the fs handle: make copyFileOut fail for the bad subagent.
        const base = fsBindMountHandle();
        const handle: SessionTransferHandle = {
          ...base,
          copyFileOut: async (sandboxPath, destPath) => {
            if (sandboxPath.endsWith("agent-bad.jsonl")) {
              throw new Error("simulated copyFileOut failure");
            }
            return base.copyFileOut(sandboxPath, destPath);
          },
        };

        // Main capture must succeed; the bad subagent must not abort the run.
        const provider = claudeCode("claude-opus-4-8", {
          sessionStorage: {
            hostProjectsDir: hostDir,
            sandboxProjectsDir: sandboxDir,
          },
        });
        await provider.sessionStorage!.captureToHost({
          hostCwd,
          sandboxCwd,
          sessionId: id,
          handle,
        });
      } finally {
        console.error = originalError;
      }

      // Main session captured.
      const mainContent = await readFile(
        join(hostDir, "-host-repo", `${id}.jsonl`),
        "utf-8",
      );
      expect(JSON.parse(mainContent).cwd).toBe(hostCwd);

      // Good sibling captured.
      const hostSubagentsDir = join(hostDir, "-host-repo", id, "subagents");
      const good = await readFile(
        join(hostSubagentsDir, "agent-good.jsonl"),
        "utf-8",
      );
      expect(JSON.parse(good).cwd).toBe(hostCwd);

      // Bad subagent NOT copied.
      await expect(
        readFile(join(hostSubagentsDir, "agent-bad.jsonl"), "utf-8"),
      ).rejects.toThrow();

      // Exactly one warning emitted, naming the bad path — successful
      // siblings and the main session must not produce warnings of their own.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("agent-bad.jsonl");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("refuses sandbox session symlinks to host files", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-symlink-"));
    try {
      const secret = join(root, "host-secret");
      await writeFile(
        secret,
        JSON.stringify({
          type: "system",
          cwd: "/sandbox/repo",
          secret: "host-only",
        }),
      );
      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: {
          hostProjectsDir: join(root, "sessions"),
          sandboxProjectsDir: "/sessions",
        },
      });
      const handle = {
        ...fsBindMountHandle(),
        copyFileOut: async (_source: string, destination: string) => {
          await symlink(secret, destination);
        },
      };
      await expect(
        provider.sessionStorage!.captureToHost({
          hostCwd: "/host/repo",
          sandboxCwd: "/sandbox/repo",
          sessionId: "session",
          handle,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("captures and restores sessions through isolated file transfers", async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "isolated-session-"));
  const isolated = await testIsolated().create({ env: {} });
  try {
    const sandboxProjectsDir = join(isolated.worktreePath, "sessions");
    await mkdir(join(sandboxProjectsDir, "-sandbox-repo"), { recursive: true });
    await writeFile(
      join(sandboxProjectsDir, "-sandbox-repo/session.jsonl"),
      JSON.stringify({ type: "system", cwd: "/sandbox/repo" }),
    );
    const provider = claudeCode("claude-opus-4-8", {
      sessionStorage: { hostProjectsDir: hostDir, sandboxProjectsDir },
    });
    const handle = toSessionTransferHandle(isolated)!;
    await provider.sessionStorage!.captureToHost({
      hostCwd: "/host/repo",
      sandboxCwd: "/sandbox/repo",
      sessionId: "session",
      handle,
    });
    expect(
      await provider.sessionStorage!.existsOnHost("/host/repo", "session"),
    ).toBe(true);
    await provider.sessionStorage!.resumeIntoSandbox({
      hostCwd: "/host/repo",
      sandboxCwd: "/sandbox/other",
      sessionId: "session",
      handle,
    });
    const restored = await readFile(
      join(sandboxProjectsDir, "-sandbox-other/session.jsonl"),
      "utf8",
    );
    expect(JSON.parse(restored).cwd).toBe("/sandbox/other");
  } finally {
    await isolated.close();
    await rm(hostDir, { recursive: true, force: true });
  }
});

import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_NAME, listAgents, getAgent } from "./InitService.js";
import { CODEX_MODELS } from "./modelConfig.js";

describe("Agent registry", () => {
  it("uses Codex as the default agent", () => {
    expect(DEFAULT_AGENT_NAME).toBe("codex");
    expect(listAgents()[0]?.name).toBe(DEFAULT_AGENT_NAME);
  });

  it("offers only Codex and Claude Code", () => {
    expect(listAgents().map((agent) => agent.name)).toEqual([
      "codex",
      "claude-code",
    ]);
  });

  it("getAgent returns claude-code entry with expected fields", () => {
    const agent = getAgent("claude-code");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("claude-code");
    expect(agent!.defaultModel).toBe("claude-opus-4-8");
    expect(agent!.factoryImport).toBe("claudeCode");
    expect(agent!.dockerfileTemplate).toContain("FROM");
  });

  it("getAgent returns undefined for unknown agent", () => {
    expect(getAgent("nonexistent")).toBeUndefined();
  });

  it("getAgent returns codex entry with expected fields", () => {
    const agent = getAgent("codex");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("codex");
    expect(agent!.defaultModel).toBe(CODEX_MODELS.routine.model);
    expect(agent!.factoryImport).toBe("codex");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("@openai/codex");
  });
});

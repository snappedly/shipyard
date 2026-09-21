import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureCodexChatGptAuth, resolveCodexAuthMode } from "./CodexAuth.js";

describe("Codex authentication selection", () => {
  it("asks interactive Codex users how they want to authenticate", async () => {
    const select = vi.fn().mockResolvedValue("chatgpt");

    await expect(
      resolveCodexAuthMode({
        agentName: "codex",
        interactive: true,
        select,
      }),
    ).resolves.toBe("chatgpt");
    expect(select).toHaveBeenCalledOnce();
  });

  it("requires an explicit Codex authentication mode non-interactively", async () => {
    await expect(
      resolveCodexAuthMode({
        agentName: "codex",
        interactive: false,
        select: vi.fn(),
      }),
    ).rejects.toThrow("--codex-auth");
  });

  it("uses an explicit Codex authentication mode without prompting", async () => {
    const select = vi.fn();

    await expect(
      resolveCodexAuthMode({
        agentName: "codex",
        requested: "api-key",
        interactive: true,
        select,
      }),
    ).resolves.toBe("api-key");
    expect(select).not.toHaveBeenCalled();
  });

  it("does not ask non-Codex agents for Codex authentication", async () => {
    const select = vi.fn();

    await expect(
      resolveCodexAuthMode({
        agentName: "claude-code",
        interactive: true,
        select,
      }),
    ).resolves.toBe("api-key");
    expect(select).not.toHaveBeenCalled();
  });
});

describe("Codex ChatGPT authentication preflight", () => {
  it("starts interactive login when the auth cache is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-auth-"));
    const authHome = join(root, ".codex");
    let loginCalls = 0;

    ensureCodexChatGptAuth({
      cwd: root,
      interactive: true,
      authHome,
      login: () => {
        loginCalls += 1;
        mkdirSync(authHome, { recursive: true });
        writeFileSync(join(authHome, "auth.json"), "{}\n");
      },
    });

    expect(loginCalls).toBe(1);
  });

  it("reuses an existing auth cache without starting login", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-auth-"));
    const authHome = join(root, ".codex");
    mkdirSync(authHome, { recursive: true });
    writeFileSync(join(authHome, "auth.json"), "{}\n");

    expect(() =>
      ensureCodexChatGptAuth({
        cwd: root,
        interactive: true,
        authHome,
        login: () => {
          throw new Error("login should not run");
        },
      }),
    ).not.toThrow();
  });

  it("reports when interactive login does not produce the mounted cache", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-auth-"));

    expect(() =>
      ensureCodexChatGptAuth({
        cwd: root,
        interactive: true,
        authHome: join(root, ".codex"),
        login: () => undefined,
      }),
    ).toThrow("~/.codex/auth.json");
  });
});

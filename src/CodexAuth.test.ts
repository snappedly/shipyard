import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCodexChatGptAuth } from "./CodexAuth.js";

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

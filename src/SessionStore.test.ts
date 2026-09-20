import { describe, expect, it } from "vitest";
import {
  claudeHostSessionPath,
  claudeSandboxSessionPath,
  claudeSubagentsDirInSandbox,
  claudeSubagentsDirOnHost,
  encodeProjectPath,
  findClaudeSessionOnHost,
  findCodexSessionOnHost,
  listClaudeSubagentSessionsInSandbox,
  locateCodexHostSession,
  transferClaudeSession,
  transferCodexSession,
} from "./SessionStore.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

// ---------------------------------------------------------------------------
// encodeProjectPath
// ---------------------------------------------------------------------------

describe("encodeProjectPath", () => {
  it("encodes absolute path by replacing path separators with hyphens", () => {
    expect(encodeProjectPath("/home/user/repos/my-project")).toBe(
      "-home-user-repos-my-project",
    );
  });

  it("encodes root path", () => {
    expect(encodeProjectPath("/")).toBe("-");
  });

  it("encodes path without leading slash", () => {
    expect(encodeProjectPath("home/user")).toBe("home-user");
  });

  it("strips trailing slash before encoding", () => {
    expect(encodeProjectPath("/home/user/")).toBe("-home-user");
  });

  it("encodes Windows path with backslashes and drive letter", () => {
    expect(encodeProjectPath("D:\\projektit\\super-app")).toBe(
      "D-projektit-super-app",
    );
  });

  it("strips trailing backslash before encoding", () => {
    expect(encodeProjectPath("C:\\Users\\rootti\\repos\\foo\\")).toBe(
      "C-Users-rootti-repos-foo",
    );
  });

  it("encodes Windows drive root", () => {
    expect(encodeProjectPath("C:\\")).toBe("C-");
  });

  it("encodes drive letter without trailing separator", () => {
    expect(encodeProjectPath("C:")).toBe("C");
  });

  it("strips multiple trailing backslashes", () => {
    expect(encodeProjectPath("D:\\projekts\\app\\\\")).toBe("D-projekts-app");
  });
});

describe("session path safety", () => {
  it("rejects session ids that could escape the session directory", () => {
    expect(() =>
      claudeHostSessionPath("/repo", "../../outside", "/tmp/projects"),
    ).toThrow(/Invalid session id/);
    expect(() =>
      claudeSandboxSessionPath("/repo", "id$(touch /tmp/pwned)", "/sessions"),
    ).toThrow(/Invalid session id/);
  });
});

// ---------------------------------------------------------------------------
// transferClaudeSession — pure cwd rewriting
// ---------------------------------------------------------------------------

describe("transferClaudeSession", () => {
  it("rewrites cwd fields in JSONL entries from source cwd to target cwd", () => {
    const jsonl = [
      JSON.stringify({ type: "system", cwd: "/sandbox/worktree" }),
      JSON.stringify({ type: "message", content: "hello" }),
      JSON.stringify({
        type: "tool_call",
        cwd: "/sandbox/worktree",
        name: "Read",
      }),
    ].join("\n");

    const written = transferClaudeSession(
      jsonl,
      "/sandbox/worktree",
      "/home/user/repos/project",
    );
    const lines = written.split("\n");

    expect(JSON.parse(lines[0]!)).toEqual({
      type: "system",
      cwd: "/home/user/repos/project",
    });
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "message",
      content: "hello",
    });
    expect(JSON.parse(lines[2]!)).toEqual({
      type: "tool_call",
      cwd: "/home/user/repos/project",
      name: "Read",
    });
  });

  it("round-trips bytes for entries without cwd", () => {
    const jsonl = [
      JSON.stringify({ type: "message", content: "hello world" }),
      JSON.stringify({
        type: "tool_result",
        output: "result with special chars: \t\n",
      }),
    ].join("\n");

    expect(transferClaudeSession(jsonl, "/src", "/dst")).toBe(jsonl);
  });

  it("handles empty JSONL", () => {
    expect(transferClaudeSession("", "/a", "/b")).toBe("");
  });

  it("only rewrites cwd fields that match source cwd exactly", () => {
    const jsonl = [
      JSON.stringify({ type: "a", cwd: "/sandbox/worktree" }),
      JSON.stringify({ type: "b", cwd: "/other/path" }),
    ].join("\n");

    const out = transferClaudeSession(jsonl, "/sandbox/worktree", "/host/repo");
    const lines = out.split("\n");
    expect(JSON.parse(lines[0]!).cwd).toBe("/host/repo");
    expect(JSON.parse(lines[1]!).cwd).toBe("/other/path");
  });

  it("preserves a malformed line verbatim instead of aborting the rewrite", () => {
    // A partially-written final line (torn write during capture) must not
    // poison the whole transfer — the surrounding good lines are rewritten
    // as usual, the bad line round-trips byte-for-byte.
    const torn = '{"type":"system","cwd":"/sandbox/worktree"'; // missing closing brace
    const jsonl = [
      JSON.stringify({ type: "a", cwd: "/sandbox/worktree" }),
      torn,
      JSON.stringify({ type: "b", cwd: "/sandbox/worktree" }),
    ].join("\n");

    const out = transferClaudeSession(jsonl, "/sandbox/worktree", "/host/repo");
    const lines = out.split("\n");
    expect(JSON.parse(lines[0]!).cwd).toBe("/host/repo");
    expect(lines[1]).toBe(torn);
    expect(JSON.parse(lines[2]!).cwd).toBe("/host/repo");
  });
});

// ---------------------------------------------------------------------------
// transferCodexSession — pure cwd rewriting on session_meta payload
// ---------------------------------------------------------------------------

describe("transferCodexSession", () => {
  it("rewrites cwd in session_meta payload and top-level cwd fields", () => {
    const jsonl = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "abc", cwd: "/sandbox/repo" },
      }),
      JSON.stringify({ type: "turn_context", cwd: "/sandbox/repo" }),
    ].join("\n");

    const out = transferCodexSession(jsonl, "/sandbox/repo", "/host/repo");
    const lines = out.split("\n");
    expect(JSON.parse(lines[0]!).payload.cwd).toBe("/host/repo");
    expect(JSON.parse(lines[1]!).cwd).toBe("/host/repo");
  });

  it("handles empty JSONL", () => {
    expect(transferCodexSession("", "/a", "/b")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findClaudeSessionOnHost
// ---------------------------------------------------------------------------

describe("findClaudeSessionOnHost", () => {
  it("finds a session by id regardless of which encoded project dir holds it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shipyard-find-claude-"));
    try {
      const id = "session-xyz";
      const projectDir = join(
        dir,
        "-private-tmp-myrepo--shipyard-worktrees-feature",
      );
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, `${id}.jsonl`), "{}");

      const result = await findClaudeSessionOnHost(id, dir);

      expect(result.path).toBe(join(projectDir, `${id}.jsonl`));
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path and names the searched root when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shipyard-find-claude-"));
    try {
      const result = await findClaudeSessionOnHost("nope", dir);
      expect(result.path).toBeUndefined();
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path when the projects dir does not exist", async () => {
    const result = await findClaudeSessionOnHost(
      "nope",
      join(tmpdir(), "shipyard-does-not-exist-xyz"),
    );
    expect(result.path).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findCodexSessionOnHost & locateCodexHostSession
// ---------------------------------------------------------------------------

describe("findCodexSessionOnHost", () => {
  it("finds a date-nested rollout file by id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shipyard-find-codex-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const sessionPath = join(
        dir,
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${id}.jsonl`,
      );
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, "{}");

      const result = await findCodexSessionOnHost(id, dir);

      expect(result.path).toBe(sessionPath);
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path and names the searched root when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shipyard-find-codex-"));
    try {
      const result = await findCodexSessionOnHost("missing", dir);
      expect(result.path).toBeUndefined();
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("locateCodexHostSession", () => {
  it("returns absolute path and relative date-nested path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shipyard-locate-codex-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const relativePath = join(
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${id}.jsonl`,
      );
      const sessionPath = join(dir, relativePath);
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, "{}");

      const result = await locateCodexHostSession(id, dir);

      expect(result.path).toBe(sessionPath);
      expect(result.relativePath).toBe(relativePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
// ---------------------------------------------------------------------------
// Claude subagent / workflow session helpers
// ---------------------------------------------------------------------------

describe("claudeSubagentsDirInSandbox", () => {
  it("returns <projectsDir>/<encoded-cwd>/<sessionId>/subagents using POSIX separators", () => {
    expect(
      claudeSubagentsDirInSandbox(
        "/sandbox/repo",
        "abc-123",
        "/home/agent/.claude/projects",
      ),
    ).toBe("/home/agent/.claude/projects/-sandbox-repo/abc-123/subagents");
  });
});

describe("claudeSubagentsDirOnHost", () => {
  it("returns <projectsDir>/<encoded-cwd>/<sessionId>/subagents using host separators", () => {
    expect(
      claudeSubagentsDirOnHost("/host/repo", "abc-123", "/tmp/projects"),
    ).toBe(join("/tmp/projects", "-host-repo", "abc-123", "subagents"));
  });
});

describe("listClaudeSubagentSessionsInSandbox", () => {
  /** Bind-mount handle backed by the host filesystem (sandbox path == host path). */
  const fsHandle = (): Pick<BindMountSandboxHandle, "exec"> => ({
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
  });

  it("returns absolute paths of agent-*.jsonl files in the subagents dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shipyard-sub-list-"));
    try {
      const sessionId = "abc-123";
      const subagentsDir = join(dir, "-sandbox-repo", sessionId, "subagents");
      await mkdir(subagentsDir, { recursive: true });
      const f1 = join(subagentsDir, "agent-alpha.jsonl");
      const f2 = join(subagentsDir, "agent-beta.jsonl");
      await writeFile(f1, "{}");
      await writeFile(f2, "{}");
      // Non-matching files must be filtered out by the find pattern.
      await writeFile(join(subagentsDir, "summary.txt"), "irrelevant");
      await writeFile(join(subagentsDir, "agent-gamma.json"), "{}");

      const result = await listClaudeSubagentSessionsInSandbox(
        "/sandbox/repo",
        sessionId,
        fsHandle(),
        dir,
      );

      expect(result.sort()).toEqual([f1, f2].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the subagents dir does not exist (the normal case)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shipyard-sub-nodir-"));
    try {
      const result = await listClaudeSubagentSessionsInSandbox(
        "/sandbox/repo",
        "abc-123",
        fsHandle(),
        dir,
      );
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the subagents dir is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shipyard-sub-empty-"));
    try {
      const subagentsDir = join(dir, "-sandbox-repo", "abc-123", "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const result = await listClaudeSubagentSessionsInSandbox(
        "/sandbox/repo",
        "abc-123",
        fsHandle(),
        dir,
      );
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses POSIX path semantics for the sandbox-side enumeration", () => {
    // Sanity-check: the dir helper used inside the listing must emit POSIX
    // separators so it works on Windows hosts driving Linux containers.
    expect(
      claudeSubagentsDirInSandbox(
        "/sandbox/repo",
        "abc-123",
        "/sandbox/projects",
      ).includes(posix.sep),
    ).toBe(true);
  });
});

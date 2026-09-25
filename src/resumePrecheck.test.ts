import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCode } from "./AgentProvider.js";
import type { AgentProvider } from "./AgentProvider.js";
import { assertResumeSessionExists } from "./resumePrecheck.js";

const SESSION_ID = "9ba1c695-2222-4444-8888-e7e847bf34dd";

const nonResumableAgent: AgentProvider = {
  name: "non-resumable",
  env: {},
  captureSessions: false,
  buildPrintCommand: ({ prompt }) => ({ command: "fixture", stdin: prompt }),
  parseStreamLine: () => [],
};

describe("assertResumeSessionExists", () => {
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "resume-precheck-"));
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
  });

  describe("Docker session storage", () => {
    it("checks the exact host-repo-dir encoded location and names the expected file path on a miss", async () => {
      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: { hostProjectsDir: projectsDir },
      });

      await expect(
        assertResumeSessionExists({
          provider,
          hostRepoDir: "/some/host/repo",
          resumeSession: "abc-123",
        }),
      ).rejects.toThrow(
        'resumeSession "abc-123" not found: expected session file at',
      );
    });

    it("passes when the session exists at the host-repo-dir encoded location", async () => {
      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: { hostProjectsDir: projectsDir },
      });
      const hostRepoDir = "/some/host/repo";
      const sessionPath = provider.sessionStorage.hostSessionFilePath(
        hostRepoDir,
        SESSION_ID,
      )!;
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, "{}");

      await expect(
        assertResumeSessionExists({
          provider,
          hostRepoDir,
          resumeSession: SESSION_ID,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("throws when the provider does not support session resumption", async () => {
    await expect(
      assertResumeSessionExists({
        provider: nonResumableAgent,
        hostRepoDir: "/some/host/repo",
        resumeSession: SESSION_ID,
      }),
    ).rejects.toThrow("non-resumable does not support resumeSession");
  });
});

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  integrateTemplateDelivery,
  publishTemplateDelivery,
} from "./template-delivery.js";

const exec = promisify(execFile);

describe("generated GitHub delivery", () => {
  it("integrates sibling commits serially into one remote candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipyard-template-"));
    const bare = join(directory, "remote.git");
    const checkout = join(directory, "checkout");
    const git = async (...args: string[]) =>
      (await exec("git", ["-C", checkout, ...args])).stdout.trim();
    try {
      await exec("git", ["init", "--bare", bare]);
      await exec("git", ["clone", bare, checkout]);
      await git("config", "user.name", "Shipyard Test");
      await git("config", "user.email", "shipyard@example.test");
      await writeFile(join(checkout, "base.txt"), "base\n");
      await git("add", "base.txt");
      await git("commit", "-m", "base");
      await git("branch", "-M", "staging");
      await git("push", "origin", "staging");
      await git("switch", "-c", "child-1");
      await writeFile(join(checkout, "one.txt"), "one\n");
      await git("add", "one.txt");
      await git("commit", "-m", "one");
      const one = await git("rev-parse", "HEAD");
      await git("switch", "staging");
      await git("switch", "-c", "child-2");
      await writeFile(join(checkout, "two.txt"), "two\n");
      await git("add", "two.txt");
      await git("commit", "-m", "two");
      const two = await git("rev-parse", "HEAD");
      await git("switch", "staging");

      const first = await integrateTemplateDelivery({
        repositoryPath: checkout,
        branch: "shipyard/spec-100",
        baseBranch: "staging",
        commits: [one, two],
      });
      await git(
        "push",
        "origin",
        `${first.headSha}:refs/heads/shipyard/spec-100`,
      );
      const second = await integrateTemplateDelivery({
        repositoryPath: checkout,
        branch: "shipyard/spec-100",
        baseBranch: "staging",
        commits: [one, two],
      });

      expect(first.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(second.headSha).toBe(first.headSha);
      expect(await git("show", `${first.headSha}:one.txt`)).toBe("one");
      expect(await git("show", `${first.headSha}:two.txt`)).toBe("two");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("publishes one draft PR and refreshes its candidate on replay", async () => {
    const candidateA = "a".repeat(40);
    const candidateB = "b".repeat(40);
    let pullRequest:
      | {
          number: number;
          title: string;
          body: string;
          headRefOid: string;
          headRefName: string;
          baseRefName: string;
          state: string;
          isDraft: boolean;
          url: string;
        }
      | undefined;
    const commands: Array<{ file: string; args: readonly string[] }> = [];
    const run = vi.fn(async (file: string, args: readonly string[]) => {
      commands.push({ file, args });
      if (file === "git") return "";
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify(pullRequest === undefined ? [] : [pullRequest]);
      }
      if (args[0] === "pr" && args[1] === "create") {
        pullRequest = {
          number: 12,
          title: args[args.indexOf("--title") + 1]!,
          body: args[args.indexOf("--body") + 1]!,
          headRefOid: candidateA,
          headRefName: "shipyard/issue-42",
          baseRefName: "staging",
          state: "OPEN",
          isDraft: true,
          url: "https://github.com/example/repo/pull/12",
        };
        return pullRequest.url;
      }
      if (args[0] === "pr" && args[1] === "edit") {
        pullRequest = {
          ...pullRequest!,
          title: args[args.indexOf("--title") + 1]!,
          body: args[args.indexOf("--body") + 1]!,
          headRefOid: candidateB,
        };
        return "";
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify(pullRequest);
      }
      if (args[0] === "issue" && args[1] === "edit") return "";
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    });
    const input = {
      repository: "example/repo",
      itemId: "42",
      kind: "executable-issue" as const,
      branch: "shipyard/issue-42",
      baseBranch: "staging",
      title: "Implement issue 42",
      body: "Acceptance evidence",
      metadata: {
        version: 1 as const,
        repository: "example/repo",
        itemId: "42",
        kind: "executable-issue" as const,
        briefRevision: 1,
        briefHash: "f".repeat(64),
        baseBranch: "staging",
        baseSha: "0".repeat(40),
        branch: "shipyard/issue-42",
      },
      run,
    };

    const created = await publishTemplateDelivery({
      ...input,
      headSha: candidateA,
    });
    const updated = await publishTemplateDelivery({
      ...input,
      headSha: candidateB,
    });

    expect(created.number).toBe(12);
    expect(updated.number).toBe(12);
    expect(updated.headSha).toBe(candidateB);
    expect(pullRequest?.body).toContain(`"headSha":"${candidateB}"`);
    expect(
      commands.filter(({ args }) => args[0] === "pr" && args[1] === "create"),
    ).toHaveLength(1);
    expect(
      commands.filter(({ args }) => args[0] === "pr" && args[1] === "edit"),
    ).toHaveLength(1);
    expect(
      commands.filter(({ file, args }) => file === "git" && args[0] === "push"),
    ).toHaveLength(2);
  });

  it("preserves a ready PR when the exact candidate is replayed", async () => {
    const headSha = "a".repeat(40);
    const marker = "<!-- shipyard:template-delivery:example%2Frepo:42 -->";
    const metadata = {
      version: 1 as const,
      repository: "example/repo",
      itemId: "42",
      kind: "executable-issue" as const,
      briefRevision: 1,
      briefHash: "f".repeat(64),
      baseBranch: "staging",
      baseSha: "0".repeat(40),
      branch: "shipyard/issue-42",
    };
    const body = `${marker}\n<!-- shipyard:metadata ${JSON.stringify({ ...metadata, headSha })} -->\nEvidence`;
    const remote = {
      number: 12,
      title: "Issue 42",
      body,
      headRefOid: headSha,
      headRefName: "shipyard/issue-42",
      baseRefName: "staging",
      state: "OPEN",
      isDraft: false,
      url: "https://github.com/example/repo/pull/12",
    };
    const calls: string[] = [];
    const result = await publishTemplateDelivery({
      repository: "example/repo",
      itemId: "42",
      kind: "executable-issue",
      branch: "shipyard/issue-42",
      baseBranch: "staging",
      headSha,
      title: "Issue 42",
      body: "Evidence",
      metadata,
      run: async (file, args) => {
        calls.push(`${file} ${args.slice(0, 2).join(" ")}`);
        if (file === "git") return "";
        if (args[1] === "list") return JSON.stringify([remote]);
        if (args[1] === "view") return JSON.stringify(remote);
        if (args[0] === "issue" && args[1] === "edit") return "";
        throw new Error("unexpected command");
      },
    });

    expect(result.draft).toBe(false);
    expect(calls).not.toContain("gh pr ready");
    expect(calls).not.toContain("gh pr edit");
  });

  it("withdraws handoff before pushing a changed ready candidate", async () => {
    const prior = "a".repeat(40);
    const next = "b".repeat(40);
    const metadata = {
      version: 1 as const,
      repository: "example/repo",
      itemId: "42",
      kind: "executable-issue" as const,
      briefRevision: 1,
      briefHash: "f".repeat(64),
      baseBranch: "staging",
      baseSha: "0".repeat(40),
      branch: "shipyard/issue-42",
    };
    let remote = {
      number: 12,
      title: "Issue 42",
      body: "<!-- shipyard:template-delivery:example%2Frepo:42 -->",
      headRefOid: prior,
      headRefName: "shipyard/issue-42",
      baseRefName: "staging",
      state: "OPEN",
      isDraft: false,
      labels: [{ name: "ready-for-human" }],
      url: "https://github.com/example/repo/pull/12",
    };
    const calls: string[] = [];
    await publishTemplateDelivery({
      repository: "example/repo",
      itemId: "42",
      kind: "executable-issue",
      branch: "shipyard/issue-42",
      baseBranch: "staging",
      headSha: next,
      title: "Issue 42",
      body: "New evidence",
      metadata,
      run: async (file, args) => {
        calls.push(`${file} ${args.slice(0, 2).join(" ")}`);
        if (file === "gh" && args[1] === "list")
          return JSON.stringify([remote]);
        if (file === "gh" && args[1] === "ready") {
          remote = { ...remote, isDraft: true };
          return "";
        }
        if (file === "gh" && args[1] === "edit") {
          if (args.includes("--remove-label")) {
            remote = { ...remote, labels: [] };
          } else {
            remote = {
              ...remote,
              body: args[args.indexOf("--body") + 1]!,
            };
          }
          return "";
        }
        if (file === "git" && args[0] === "push") {
          expect(remote.isDraft).toBe(true);
          expect(remote.labels).toEqual([]);
          remote = { ...remote, headRefOid: next };
          return "";
        }
        if (file === "gh" && args[1] === "view") return JSON.stringify(remote);
        if (file === "gh" && args[0] === "issue") return "";
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    });
    expect(calls.indexOf("gh pr ready")).toBeLessThan(
      calls.indexOf("git push origin"),
    );
    expect(calls.filter((call) => call === "gh pr edit")).toHaveLength(2);
  });

  it("does not move a branch after its delivery PR was merged", async () => {
    const calls: string[] = [];
    await expect(
      publishTemplateDelivery({
        repository: "example/repo",
        itemId: "42",
        kind: "executable-issue",
        branch: "shipyard/issue-42",
        baseBranch: "staging",
        headSha: "b".repeat(40),
        title: "Issue 42",
        body: "Evidence",
        metadata: {
          version: 1,
          repository: "example/repo",
          itemId: "42",
          kind: "executable-issue",
          briefRevision: 1,
          briefHash: "f".repeat(64),
          baseBranch: "staging",
          baseSha: "0".repeat(40),
          branch: "shipyard/issue-42",
        },
        run: async (file, args) => {
          calls.push(`${file} ${args[0]}`);
          if (file === "gh" && args[1] === "list")
            return JSON.stringify([
              {
                number: 12,
                title: "Issue 42",
                body: "<!-- shipyard:template-delivery:example%2Frepo:42 -->",
                headRefOid: "a".repeat(40),
                headRefName: "shipyard/issue-42",
                baseRefName: "staging",
                state: "MERGED",
                isDraft: false,
                url: "https://github.com/example/repo/pull/12",
              },
            ]);
          throw new Error("unexpected command");
        },
      }),
    ).rejects.toThrow("closed or targets another branch");
    expect(calls).not.toContain("git push");
  });
});

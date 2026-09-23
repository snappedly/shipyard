import { describe, expect, it, vi } from "vitest";
import { createGitHubCliTransport } from "./cli-transport.js";

describe("GitHub CLI publication transport", () => {
  it("refuses to move a branch after its delivery PR merged", async () => {
    const commands: string[] = [];
    const transport = createGitHubCliTransport({
      run: async (file, args) => {
        commands.push(`${file} ${args[0]}`);
        if (file === "gh" && args[0] === "api") {
          return JSON.stringify([
            {
              number: 7,
              title: "Delivery",
              body: "<!-- shipyard:pull-request:demo -->",
              state: "closed",
              draft: false,
              merged: true,
              head: { ref: "shipyard/issue-42", sha: "a".repeat(40) },
              base: { ref: "staging" },
              updated_at: "2026-09-23T00:00:00Z",
              labels: [],
            },
          ]);
        }
        throw new Error("Unexpected command");
      },
    });
    await expect(
      transport.updateBranch!({
        repository: "example/repo",
        branch: "shipyard/issue-42",
        headSha: "b".repeat(40),
        marker: "branch-marker",
      }),
    ).rejects.toThrow("merged delivery branch");
    expect(commands).not.toContain("git push");
  });

  it("withdraws a ready handoff before replacing its remote head", async () => {
    const oldHead = "a".repeat(40);
    const nextHead = "b".repeat(40);
    let draft = false;
    let labels = ["ready-for-human"];
    let head = oldHead;
    const order: string[] = [];
    const run = vi.fn(async (file: string, args: readonly string[]) => {
      order.push(`${file} ${args[0]} ${args[1] ?? ""}`.trim());
      if (file === "gh" && args[0] === "api" && args[1]?.includes("/pulls?")) {
        return JSON.stringify([
          {
            number: 7,
            title: "Delivery",
            body: "<!-- shipyard:pull-request:demo -->",
            state: "open",
            draft,
            head: { ref: "shipyard/issue-42", sha: head },
            base: { ref: "staging" },
            updated_at: "2026-09-23T00:00:00Z",
            labels: labels.map((name) => ({ name })),
          },
        ]);
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "ready") {
        draft = true;
        return "";
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "edit") {
        labels = [];
        return "";
      }
      if (file === "git" && args[0] === "push") {
        expect(draft).toBe(true);
        expect(labels).toEqual([]);
        head = nextHead;
        return "";
      }
      if (
        file === "gh" &&
        args[0] === "api" &&
        args[1]?.includes("/git/ref/")
      ) {
        return JSON.stringify({ object: { sha: head } });
      }
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    });
    const transport = createGitHubCliTransport({ run });
    const branch = await transport.updateBranch!({
      repository: "example/repo",
      branch: "shipyard/issue-42",
      headSha: nextHead,
      marker: "branch-marker",
    });
    expect(branch.headSha).toBe(nextHead);
    expect(order.indexOf("gh pr ready")).toBeLessThan(
      order.indexOf("git push origin"),
    );
  });

  it("reconciles a published commit status by a bounded marker", async () => {
    const headSha = "a".repeat(40);
    const marker = `<!-- shipyard:check:${"x".repeat(240)} -->`;
    let published: Record<string, unknown> | undefined;
    const transport = createGitHubCliTransport({
      run: async (file, args) => {
        expect(file).toBe("gh");
        if (args[1]?.includes("/statuses/") && args.includes("POST")) {
          published = {
            id: 9,
            context: "typecheck",
            state: "success",
            description: args
              .find((arg) => arg.startsWith("description="))
              ?.slice(12),
          };
          return JSON.stringify(published);
        }
        if (args[1]?.includes("/commits/") && args[1]?.includes("/statuses")) {
          return JSON.stringify(published === undefined ? [] : [published]);
        }
        throw new Error(`Unexpected command ${args.join(" ")}`);
      },
    });
    await transport.createCheck({
      repository: "example/repo",
      name: "typecheck",
      headSha,
      marker,
      status: "completed",
      conclusion: "success",
      summary: "passed",
    });
    expect(String(published?.description).length).toBeLessThanOrEqual(140);
    expect(
      await transport.findCheckByMarker({
        repository: "example/repo",
        marker,
        headSha,
      }),
    ).toMatchObject({ name: "typecheck", conclusion: "success" });
  });
});

import { describe, expect, it } from "vitest";
import { createGitHubCliRelationshipReader } from "./cli-relationships.js";

describe("GitHub CLI issue relationships", () => {
  it("reads native parent, children, and blockers and falls back on 404", async () => {
    const paths: string[] = [];
    const issue = (number: number) => ({
      number,
      title: `Issue ${number}`,
      body: "",
      state: "open",
      updated_at: "2026-09-23T00:00:00Z",
      labels: [],
    });
    const reader = createGitHubCliRelationshipReader({
      run: async (_file, args) => {
        const path = args[1]!;
        paths.push(path);
        if (path.endsWith("/parent")) return JSON.stringify(issue(100));
        if (path.includes("/sub_issues?"))
          return JSON.stringify([issue(101), issue(102)]);
        if (path.includes("/dependencies/blocked_by?"))
          return JSON.stringify([issue(101)]);
        if (path.endsWith("/issues/999"))
          throw new Error("HTTP 404: Not Found");
        return JSON.stringify(issue(102));
      },
    });

    expect(
      (
        await reader.fetchParentIssue!({
          repository: "owner/repo",
          issueNumber: 102,
        })
      )?.number,
    ).toBe(100);
    expect(
      (
        await reader.fetchSubIssues!({
          repository: "owner/repo",
          issueNumber: 100,
        })
      ).map((child) => child.number),
    ).toEqual([101, 102]);
    expect(
      (
        await reader.fetchBlockedBy!({
          repository: "owner/repo",
          issueNumber: 102,
        })
      ).map((child) => child.number),
    ).toEqual([101]);
    expect(
      await reader.fetchIssue({ repository: "owner/repo", issueNumber: 999 }),
    ).toBeUndefined();
    expect(paths).toContain("repos/owner/repo/issues/102/parent");
  });
});

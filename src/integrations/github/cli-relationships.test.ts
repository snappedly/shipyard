import { describe, expect, it } from "vitest";
import {
  createGitHubCliRelationshipReader,
  readActivatedDeliveryRoot,
  readPlanningSpecGraph,
} from "./cli-relationships.js";

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

describe("readActivatedDeliveryRoot", () => {
  const issue = (body: string, labels: string[] = ["shipyard"]) => ({
    number: 100,
    title: "Delivery",
    body,
    state: "open" as const,
    updatedAt: "2026-09-23T00:00:00Z",
    labels,
  });

  it("classifies a planning spec from its label or child relationship", async () => {
    await expect(
      readActivatedDeliveryRoot("owner/repo", 100, {
        fetchIssue: async () => issue("", ["shipyard", "planning-spec"]),
      }),
    ).resolves.toEqual({ title: "Delivery", mode: "planning-spec" });
    await expect(
      readActivatedDeliveryRoot("owner/repo", 100, {
        fetchIssue: async () => issue(""),
        fetchSubIssues: async () => [issue("")],
      }),
    ).resolves.toEqual({ title: "Delivery", mode: "planning-spec" });
  });

  it("rejects an activated child as a delivery root", async () => {
    await expect(
      readActivatedDeliveryRoot("owner/repo", 100, {
        fetchIssue: async () => issue(""),
        fetchParentIssue: async () => issue(""),
      }),
    ).rejects.toThrow("has a parent");
    await expect(
      readActivatedDeliveryRoot("owner/repo", 100, {
        fetchIssue: async () => issue("Shipyard-Parent: #99"),
      }),
    ).rejects.toThrow("has a parent");
  });

  it("rejects withdrawn activation", async () => {
    await expect(
      readActivatedDeliveryRoot("owner/repo", 100, {
        fetchIssue: async () => issue("", []),
      }),
    ).rejects.toThrow("no longer activated");
  });
});

describe("readPlanningSpecGraph", () => {
  const issue = (number: number, body = "") => ({
    number,
    title: `Issue ${number}`,
    body,
    state: "open" as const,
    updatedAt: "2026-09-23T00:00:00Z",
    labels: [],
  });

  it("loads every native child and dependency even when only the parent is activated", async () => {
    const reader = {
      fetchIssue: async () => issue(100),
      fetchSubIssues: async () => [issue(101), issue(102)],
      fetchBlockedBy: async ({ issueNumber }: { issueNumber: number }) =>
        issueNumber === 102 ? [issue(101)] : [],
    };

    await expect(
      readPlanningSpecGraph("owner/repo", 100, reader),
    ).resolves.toEqual({
      root: { id: "100", title: "Issue 100" },
      children: [
        { id: "101", title: "Issue 101", dependsOn: [] },
        { id: "102", title: "Issue 102", dependsOn: ["101"] },
      ],
    });
  });

  it("uses documented child and dependency references when native links are absent", async () => {
    const reader = {
      fetchIssue: async ({ issueNumber }: { issueNumber: number }) =>
        issueNumber === 100
          ? issue(100, "Shipyard-Children: #101, #102")
          : issue(
              issueNumber,
              issueNumber === 102 ? "Shipyard-Depends-On: #101" : "",
            ),
    };

    const graph = await readPlanningSpecGraph("owner/repo", 100, reader);
    expect(graph.children).toEqual([
      { id: "101", title: "Issue 101", dependsOn: [] },
      { id: "102", title: "Issue 102", dependsOn: ["101"] },
    ]);
  });

  it("blocks a spec when an open child depends on work outside its graph", async () => {
    const reader = {
      fetchIssue: async () => issue(100),
      fetchSubIssues: async () => [issue(101)],
      fetchBlockedBy: async () => [issue(99)],
    };

    await expect(
      readPlanningSpecGraph("owner/repo", 100, reader),
    ).rejects.toThrow("outside this planning spec");
  });
});

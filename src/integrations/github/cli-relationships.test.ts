import { describe, expect, it } from "vitest";
import {
  InMemoryCoordinatorStorage,
  LeaseBusyError,
  resolveDeliveryGroup,
  WorkflowCoordinator,
} from "../../workflow/coordinator/index.js";
import {
  GitHubDeliveryRouteError,
  createGitHubCliRelationshipReader,
  readActivatedDeliveryGroup,
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

describe("readActivatedDeliveryGroup", () => {
  const issue = (
    number: number,
    body = "",
    labels: string[] = [],
    state: "open" | "closed" = "open",
  ) => ({
    number,
    title: `Issue ${number}`,
    body,
    state,
    updatedAt: "2026-09-23T00:00:00Z",
    labels,
  });

  it("promotes a natively linked activated child to the complete spec graph", async () => {
    const issues = new Map([
      [101, issue(101, "Implement child", ["shipyard"])],
      [100, issue(100, "Work item type: planning spec")],
      [102, issue(102)],
    ]);
    const reader = {
      fetchIssue: async ({ issueNumber }: { issueNumber: number }) =>
        issues.get(issueNumber),
      fetchParentIssue: async ({ issueNumber }: { issueNumber: number }) =>
        issueNumber === 101 ? issues.get(100) : undefined,
      fetchSubIssues: async ({ issueNumber }: { issueNumber: number }) =>
        issueNumber === 100 ? [issues.get(101)!, issues.get(102)!] : [],
      fetchBlockedBy: async () => [],
    };

    const result = await readActivatedDeliveryGroup("owner/repo", 101, reader);

    expect({
      activatedIssue: result.activatedIssue.number,
      root: result.root.number,
      mode: result.mode,
      children: result.children.map(({ id, title, dependsOn }) => ({
        id,
        title,
        dependsOn,
      })),
    }).toEqual({
      activatedIssue: 101,
      root: 100,
      mode: "planning-spec",
      children: [
        { id: "101", title: "Issue 101", dependsOn: [] },
        { id: "102", title: "Issue 102", dependsOn: [] },
      ],
    });
  });

  it("promotes a fallback-linked child using the documented graph references", async () => {
    const issues = new Map([
      [101, issue(101, "Shipyard-Parent: #100", ["shipyard"])],
      [
        100,
        issue(
          100,
          "Work item type: planning spec\nShipyard-Children: #101, #102",
        ),
      ],
      [102, issue(102, "Shipyard-Depends-On: #101")],
    ]);
    const reader = {
      fetchIssue: async ({ issueNumber }: { issueNumber: number }) =>
        issues.get(issueNumber),
      fetchParentIssue: async () => undefined,
      fetchSubIssues: async () => [],
      fetchBlockedBy: async () => [],
    };

    const result = await readActivatedDeliveryGroup("owner/repo", 101, reader);

    expect(result.mode).toBe("planning-spec");
    expect(result.root.number).toBe(100);
    expect(result.children).toEqual([
      { id: "101", title: "Issue 101", dependsOn: [] },
      { id: "102", title: "Issue 102", dependsOn: ["101"] },
    ]);
  });

  it("keeps an unrelated activated issue as its own standalone root", async () => {
    const standalone = issue(200, "Independent task", ["shipyard"]);

    await expect(
      readActivatedDeliveryGroup("owner/repo", 200, {
        fetchIssue: async () => standalone,
      }),
    ).resolves.toMatchObject({
      activatedIssue: standalone,
      root: standalone,
      mode: "standalone",
      children: [],
    });
  });

  it("gives sibling activations one fenced parent delivery while preserving standalone identity", async () => {
    const issues = new Map([
      [101, issue(101, "Implement first child", ["shipyard"])],
      [102, issue(102, "Implement second child", ["shipyard"])],
      [100, issue(100, "Work item type: planning spec")],
    ]);
    const reader = {
      fetchIssue: async ({ issueNumber }: { issueNumber: number }) =>
        issues.get(issueNumber),
      fetchParentIssue: async ({ issueNumber }: { issueNumber: number }) =>
        issueNumber === 101 || issueNumber === 102
          ? issues.get(100)
          : undefined,
      fetchSubIssues: async ({ issueNumber }: { issueNumber: number }) =>
        issueNumber === 100 ? [issues.get(101)!, issues.get(102)!] : [],
      fetchBlockedBy: async () => [],
    };
    const [first, second] = await Promise.all([
      readActivatedDeliveryGroup("owner/repo", 101, reader),
      readActivatedDeliveryGroup("owner/repo", 102, reader),
    ]);
    const deliveryFor = (route: typeof first) =>
      resolveDeliveryGroup({
        issue: {
          repository: "owner/repo",
          itemId: String(route.root.number),
          kind: "planning-spec",
        },
        children: route.children.map((child) => ({
          repository: "owner/repo",
          itemId: child.id,
          kind: "executable-issue" as const,
        })),
        dependencies: route.children.map((child) => ({
          itemId: child.id,
          dependsOn: child.dependsOn,
        })),
      });
    const firstDelivery = deliveryFor(first);
    const secondDelivery = deliveryFor(second);

    expect(first.activatedIssue.number).toBe(101);
    expect(second.activatedIssue.number).toBe(102);
    expect(firstDelivery.id).toBe(secondDelivery.id);
    expect(firstDelivery.key).toEqual(secondDelivery.key);
    expect(firstDelivery.graph).toEqual(secondDelivery.graph);

    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
      clock: {
        now: () => "2026-09-23T00:00:00.000Z",
        nowMilliseconds: () => 0,
      },
    });
    await coordinator.resolveDelivery(firstDelivery);
    await coordinator.resolveDelivery(secondDelivery);
    await coordinator.acquireDeliveryLease({
      repository: "owner/repo",
      key: firstDelivery.key,
      workerId: "sibling-101",
      ttlMs: 60_000,
    });
    await expect(
      coordinator.acquireDeliveryLease({
        repository: "owner/repo",
        key: secondDelivery.key,
        workerId: "sibling-102",
        ttlMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(LeaseBusyError);

    const standalone = resolveDeliveryGroup({
      issue: {
        repository: "owner/repo",
        itemId: "200",
        kind: "executable-issue",
      },
    });
    await coordinator.resolveDelivery(standalone);
    await expect(
      coordinator.acquireDeliveryLease({
        repository: "owner/repo",
        key: standalone.key,
        workerId: "standalone-200",
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ key: standalone.key });
  });

  it("rejects missing, closed, and non-spec parents", async () => {
    const child = issue(101, "Shipyard-Parent: #100", ["shipyard"]);
    const missingReader = {
      fetchIssue: async ({ issueNumber }: { issueNumber: number }) =>
        issueNumber === 101 ? child : undefined,
      fetchParentIssue: async () => undefined,
    };
    const closedReader = {
      fetchIssue: async ({ issueNumber }: { issueNumber: number }) =>
        issueNumber === 101
          ? child
          : issue(100, "Work item type: planning spec", [], "closed"),
      fetchParentIssue: async () => undefined,
      fetchSubIssues: async () => [],
    };
    const invalidReader = {
      fetchIssue: async ({ issueNumber }: { issueNumber: number }) =>
        issueNumber === 101 ? child : issue(100, "An executable parent"),
      fetchParentIssue: async () => undefined,
      fetchSubIssues: async () => [],
    };

    await expect(
      readActivatedDeliveryGroup("owner/repo", 101, missingReader),
    ).rejects.toBeInstanceOf(GitHubDeliveryRouteError);
    await expect(
      readActivatedDeliveryGroup("owner/repo", 101, missingReader),
    ).rejects.toThrow("Planning-spec parent #100 is missing");
    await expect(
      readActivatedDeliveryGroup("owner/repo", 101, closedReader),
    ).rejects.toThrow("Planning-spec parent #100 is closed");
    await expect(
      readActivatedDeliveryGroup("owner/repo", 101, invalidReader),
    ).rejects.toThrow("Parent #100 is not a planning spec");
  });

  it("rethrows provider failures instead of classifying them as invalid routes", async () => {
    const failure = new Error("gh authentication failed");
    const reader = {
      fetchIssue: async () => {
        throw failure;
      },
    };

    await expect(
      readActivatedDeliveryGroup("owner/repo", 101, reader),
    ).rejects.toBe(failure);
  });

  it("classifies a withdrawn activation as an ineligible route", async () => {
    await expect(
      readActivatedDeliveryGroup("owner/repo", 101, {
        fetchIssue: async () => issue(101, "Inactive task"),
      }),
    ).rejects.toBeInstanceOf(GitHubDeliveryRouteError);
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

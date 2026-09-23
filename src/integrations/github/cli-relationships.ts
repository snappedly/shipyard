import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitHubIssueRelationshipReader,
  GitHubIssueSnapshot,
} from "./types.js";
import type { TemplateCommand } from "./template-delivery.js";
import { issueReferences } from "./issue-references.js";
import { githubIssueKind } from "./issue-kind.js";

const exec = promisify(execFile);
const defaultCommand: TemplateCommand = async (file, args) =>
  (await exec(file, [...args], { encoding: "utf8" })).stdout.trim();

const issuePath = (repository: string, issueNumber: number): string => {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    throw new Error("Invalid GitHub issue identity");
  }
  return `repos/${repository}/issues/${issueNumber}`;
};

export const parseCliIssue = (value: unknown): GitHubIssueSnapshot => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid issue");
  }
  const item = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(item.number) ||
    typeof item.title !== "string" ||
    typeof item.updated_at !== "string" ||
    (item.state !== "open" && item.state !== "closed")
  ) {
    throw new Error("GitHub returned incomplete issue data");
  }
  const labels = Array.isArray(item.labels)
    ? item.labels
        .map((label) =>
          typeof label === "string"
            ? label
            : typeof label === "object" && label !== null && "name" in label
              ? String(label.name)
              : "",
        )
        .filter(Boolean)
    : [];
  const user = item.user;
  return {
    number: item.number as number,
    title: item.title,
    body: typeof item.body === "string" ? item.body : "",
    state: item.state,
    updatedAt: item.updated_at,
    labels,
    htmlUrl: typeof item.html_url === "string" ? item.html_url : undefined,
    authorLogin:
      typeof user === "object" &&
      user !== null &&
      "login" in user &&
      typeof user.login === "string"
        ? user.login
        : undefined,
  };
};

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && /\bHTTP 404\b/.test(error.message);

/** Native GitHub relationship reads for hosts that use the gh CLI. */
export const createGitHubCliRelationshipReader = (
  options: { readonly run?: TemplateCommand } = {},
): GitHubIssueRelationshipReader => {
  const run = options.run ?? defaultCommand;
  const get = async (path: string): Promise<unknown | undefined> => {
    try {
      return JSON.parse(await run("gh", ["api", path])) as unknown;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };
  const list = async (
    path: string,
  ): Promise<readonly GitHubIssueSnapshot[]> => {
    const issues: GitHubIssueSnapshot[] = [];
    for (let page = 1; ; page++) {
      const response = await get(`${path}?per_page=100&page=${page}`);
      if (response === undefined) return issues;
      if (!Array.isArray(response)) {
        throw new Error("GitHub returned an invalid relationship list");
      }
      issues.push(...response.map(parseCliIssue));
      if (response.length < 100) return issues;
    }
  };
  return {
    fetchIssue: async ({ repository, issueNumber }) => {
      const response = await get(issuePath(repository, issueNumber));
      return response === undefined ? undefined : parseCliIssue(response);
    },
    fetchParentIssue: async ({ repository, issueNumber }) => {
      const response = await get(
        `${issuePath(repository, issueNumber)}/parent`,
      );
      return response === undefined ? undefined : parseCliIssue(response);
    },
    fetchSubIssues: ({ repository, issueNumber }) =>
      list(`${issuePath(repository, issueNumber)}/sub_issues`),
    fetchBlockedBy: ({ repository, issueNumber }) =>
      list(`${issuePath(repository, issueNumber)}/dependencies/blocked_by`),
  };
};

/** Validate an activated root against provider state before worker dispatch. */
export const readActivatedDeliveryRoot = async (
  repository: string,
  issueNumber: number,
  reader: GitHubIssueRelationshipReader = createGitHubCliRelationshipReader(),
): Promise<{ title: string; mode: "standalone" | "planning-spec" }> => {
  issuePath(repository, issueNumber);
  const issue = await reader.fetchIssue({ repository, issueNumber });
  if (
    issue?.state !== "open" ||
    !issue.labels.some((label) => label.toLowerCase() === "shipyard")
  ) {
    throw new Error(`Delivery #${issueNumber} is no longer activated`);
  }
  const parent = await reader.fetchParentIssue?.({ repository, issueNumber });
  if (
    parent !== undefined ||
    issueReferences(issue.body, "Parent").length > 0
  ) {
    throw new Error(`Delivery #${issueNumber} has a parent issue`);
  }
  const kind = githubIssueKind(issue);
  if (kind === "pr-repair") {
    throw new Error(`Delivery #${issueNumber} is a repair issue`);
  }
  const nativeChildren =
    (await reader.fetchSubIssues?.({ repository, issueNumber })) ?? [];
  const mode =
    kind === "planning-spec" ||
    nativeChildren.length > 0 ||
    issueReferences(issue.body, "Children").length > 0
      ? "planning-spec"
      : "standalone";
  return { title: issue.title, mode };
};

/** Hydrate an activated planning spec from GitHub before any child is dispatched. */
export const readPlanningSpecGraph = async (
  repository: string,
  parentNumber: number,
  reader: GitHubIssueRelationshipReader = createGitHubCliRelationshipReader(),
): Promise<{
  root: { id: string; title: string };
  children: { id: string; title: string; dependsOn: string[] }[];
}> => {
  issuePath(repository, parentNumber);
  const parent = await reader.fetchIssue({
    repository,
    issueNumber: parentNumber,
  });
  if (parent?.state !== "open") {
    throw new Error(`Planning spec #${parentNumber} is missing or closed`);
  }
  const nativeChildren =
    (await reader.fetchSubIssues?.({
      repository,
      issueNumber: parentNumber,
    })) ?? [];
  const fallbackIds =
    nativeChildren.length > 0 ? [] : issueReferences(parent.body, "Children");
  const fallbackChildren = await Promise.all(
    fallbackIds.map((issueNumber) =>
      reader.fetchIssue({ repository, issueNumber }),
    ),
  );
  if (fallbackChildren.some((child) => child === undefined)) {
    throw new Error(`Planning spec #${parentNumber} has a missing child issue`);
  }
  const children = [
    ...new Map(
      [...nativeChildren, ...fallbackChildren]
        .filter(
          (child): child is GitHubIssueSnapshot =>
            child !== undefined && child.state === "open",
        )
        .map((child) => [child.number, child] as const),
    ).values(),
  ];
  const childNumbers = new Set(children.map((child) => child.number));
  if (childNumbers.size === 0) {
    throw new Error(`Planning spec #${parentNumber} has no open child issues`);
  }
  const graph = await Promise.all(
    children.map(async (child) => {
      const nativeBlockers =
        (await reader.fetchBlockedBy?.({
          repository,
          issueNumber: child.number,
        })) ?? [];
      const fallbackBlockers =
        nativeBlockers.length > 0
          ? []
          : await Promise.all(
              issueReferences(child.body, "Depends-On").map((issueNumber) =>
                reader.fetchIssue({ repository, issueNumber }),
              ),
            );
      if (fallbackBlockers.some((blocker) => blocker === undefined)) {
        throw new Error(`Child #${child.number} has a missing dependency`);
      }
      const dependsOn = [...nativeBlockers, ...fallbackBlockers]
        .filter(
          (blocker): blocker is GitHubIssueSnapshot =>
            blocker !== undefined && blocker.state === "open",
        )
        .map((blocker) => blocker.number);
      for (const blocker of dependsOn) {
        if (!childNumbers.has(blocker)) {
          throw new Error(
            `Child #${child.number} is blocked by issue #${blocker} outside this planning spec`,
          );
        }
      }
      return {
        id: String(child.number),
        title: child.title,
        dependsOn: [...new Set(dependsOn.map(String))].sort(
          (left, right) => Number(left) - Number(right),
        ),
      };
    }),
  );
  return {
    root: { id: String(parent.number), title: parent.title },
    children: graph.sort((left, right) => Number(left.id) - Number(right.id)),
  };
};

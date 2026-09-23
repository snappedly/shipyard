import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitHubIssueRelationshipReader,
  GitHubIssueSnapshot,
} from "./types.js";
import type { TemplateCommand } from "./template-delivery.js";

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

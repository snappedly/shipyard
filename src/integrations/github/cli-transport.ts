import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { parseCliIssue } from "./cli-relationships.js";
import type { TemplateCommand } from "./template-delivery.js";
import type {
  GitHubBranchSnapshot,
  GitHubCheckSnapshot,
  GitHubCommentSnapshot,
  GitHubIssueSnapshot,
  GitHubPullRequestSnapshot,
  GitHubReadTransport,
  GitHubWriteTransport,
} from "./types.js";

const exec = promisify(execFile);
const defaultCommand: TemplateCommand = async (file, args) =>
  (
    await exec(file, [...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();

const repositoryPath = (repository: string): string => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid GitHub repository identity");
  }
  return `repos/${repository}`;
};

const issueNumber = (number: number): number => {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Invalid GitHub issue number");
  }
  return number;
};

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid object");
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown): string =>
  typeof value === "string" ? value : "";

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((entry) => string(object(entry).name)).filter(Boolean)
    : [];

const parsePullRequest = (value: unknown): GitHubPullRequestSnapshot => {
  const pr = object(value);
  const head = object(pr.head);
  const base = object(pr.base);
  if (
    !Number.isSafeInteger(pr.number) ||
    (pr.state !== "open" && pr.state !== "closed") ||
    typeof pr.draft !== "boolean" ||
    string(head.ref).length === 0 ||
    string(head.sha).length === 0 ||
    string(base.ref).length === 0
  ) {
    throw new Error("GitHub returned an incomplete pull request");
  }
  return {
    number: pr.number as number,
    title: string(pr.title),
    body: string(pr.body),
    state: pr.state,
    draft: pr.draft,
    branch: head.ref as string,
    baseBranch: base.ref as string,
    headSha: head.sha as string,
    updatedAt: string(pr.updated_at),
    htmlUrl: string(pr.html_url) || undefined,
    authorLogin:
      string(
        typeof pr.user === "object" && pr.user !== null
          ? object(pr.user).login
          : undefined,
      ) || undefined,
    labels: names(pr.labels),
    merged: pr.merged === true,
    mergedSha: string(pr.merge_commit_sha) || undefined,
    mergedAt: string(pr.merged_at) || undefined,
  };
};

const parseComment = (value: unknown): GitHubCommentSnapshot => {
  const comment = object(value);
  if (comment.id === undefined || typeof comment.body !== "string") {
    throw new Error("GitHub returned an incomplete comment");
  }
  return {
    id: String(comment.id),
    body: comment.body,
    updatedAt: string(comment.updated_at),
    htmlUrl: string(comment.html_url) || undefined,
    authorLogin:
      typeof comment.user === "object" && comment.user !== null
        ? string(object(comment.user).login) || undefined
        : undefined,
  };
};

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && /\bHTTP 404\b/.test(error.message);

const statusMarker = (marker: string): string =>
  `shipyard:${createHash("sha256").update(marker).digest("hex")}`;

/** Host-only GitHub adapter. Workers receive no CLI or publication capability. */
export const createGitHubCliTransport = (
  options: { readonly run?: TemplateCommand } = {},
): GitHubReadTransport & GitHubWriteTransport => {
  const run = options.run ?? defaultCommand;
  const api = async (
    path: string,
    args: readonly string[] = [],
  ): Promise<unknown | undefined> => {
    try {
      return JSON.parse(await run("gh", ["api", path, ...args])) as unknown;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };
  const list = async (path: string): Promise<readonly unknown[]> => {
    const result: unknown[] = [];
    for (let page = 1; ; page++) {
      const batch = await api(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new Error("GitHub returned an invalid collection");
      }
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  };
  const pullRequests = async (repository: string) =>
    (await list(`${repositoryPath(repository)}/pulls?state=all`)).map(
      parsePullRequest,
    );
  const findPullRequestOnBranch = async (
    repository: string,
    branch: string,
  ) => {
    const matches = (await pullRequests(repository)).filter(
      (pr) => pr.branch === branch,
    );
    const open = matches.filter((pr) => pr.state === "open");
    if (open.length === 1) return open[0];
    if (open.length === 0) return matches.find((pr) => pr.merged) ?? matches[0];
    if (matches.length > 1) {
      throw new Error("Multiple open pull requests use one delivery branch");
    }
    return matches[0];
  };
  const fetchIssue = async (input: {
    readonly repository: string;
    readonly issueNumber: number;
  }) => {
    const response = await api(
      `${repositoryPath(input.repository)}/issues/${issueNumber(input.issueNumber)}`,
    );
    return response === undefined ? undefined : parseCliIssue(response);
  };
  const fetchPullRequest = async (input: {
    readonly repository: string;
    readonly pullRequestNumber: number;
  }) => {
    const response = await api(
      `${repositoryPath(input.repository)}/pulls/${issueNumber(input.pullRequestNumber)}`,
    );
    return response === undefined ? undefined : parsePullRequest(response);
  };
  const findBranchByName = async (input: {
    readonly repository: string;
    readonly branch: string;
  }): Promise<GitHubBranchSnapshot | undefined> => {
    const response = await api(
      `${repositoryPath(input.repository)}/git/ref/heads/${input.branch}`,
    );
    if (response === undefined) return undefined;
    const sha = string(object(object(response).object).sha);
    if (!sha) throw new Error("GitHub returned an incomplete branch");
    return { name: input.branch, headSha: sha };
  };
  const updateLabels = async (
    kind: "issue" | "pr",
    repository: string,
    number: number,
    current: readonly string[],
    desired: readonly string[],
  ): Promise<void> => {
    const add = desired.filter((label) => !current.includes(label));
    const remove = current.filter((label) => !desired.includes(label));
    if (add.length === 0 && remove.length === 0) return;
    const args = [kind, "edit", String(number), "--repo", repository];
    if (add.length > 0) args.push("--add-label", add.join(","));
    if (remove.length > 0) args.push("--remove-label", remove.join(","));
    await run("gh", args);
  };
  const statuses = async (repository: string, headSha: string) =>
    await list(`${repositoryPath(repository)}/commits/${headSha}/statuses`);
  const parseStatus = (
    value: unknown,
    headSha: string,
  ): GitHubCheckSnapshot => {
    const status = object(value);
    const state = string(status.state);
    return {
      id: String(status.id),
      name: string(status.context),
      headSha,
      status: state === "pending" ? "in_progress" : "completed",
      conclusion:
        state === "pending"
          ? undefined
          : state === "success"
            ? "success"
            : "failure",
      htmlUrl: string(status.target_url) || undefined,
    };
  };
  return {
    fetchIssue,
    fetchPullRequest,
    findBranchByName,
    findCommentByMarker: async ({ repository, issueNumber: number, marker }) =>
      (
        await list(
          `${repositoryPath(repository)}/issues/${issueNumber(number)}/comments`,
        )
      )
        .map(parseComment)
        .find((comment) => comment.body.includes(marker)),
    findPullRequestByMarker: async ({ repository, marker }) => {
      const matches = (await pullRequests(repository)).filter((pr) =>
        pr.body.includes(marker),
      );
      if (matches.length > 1) {
        throw new Error("Multiple pull requests identify one delivery");
      }
      return matches[0];
    },
    findCheckByMarker: async ({ repository, marker, headSha }) => {
      const status = (await statuses(repository, headSha)).find(
        (entry) => string(object(entry).description) === statusMarker(marker),
      );
      return status === undefined ? undefined : parseStatus(status, headSha);
    },
    fetchChecks: async ({ repository, headSha }) => {
      const byName = new Map<string, GitHubCheckSnapshot>();
      for (const entry of await statuses(repository, headSha)) {
        const status = parseStatus(entry, headSha);
        if (!byName.has(status.name)) byName.set(status.name, status);
      }
      return [...byName.values()];
    },
    findIssueByMarker: async ({ repository, marker }) => {
      const matches = (
        await list(`${repositoryPath(repository)}/issues?state=all`)
      )
        .filter((entry) => object(entry).pull_request === undefined)
        .map(parseCliIssue)
        .filter((issue) => issue.body.includes(marker));
      if (matches.length > 1) {
        throw new Error("Multiple issues identify one repair");
      }
      return matches[0];
    },
    createComment: async ({ repository, issueNumber: number, body }) => {
      const response = await api(
        `${repositoryPath(repository)}/issues/${issueNumber(number)}/comments`,
        ["--method", "POST", "-f", `body=${body}`],
      );
      return parseComment(response);
    },
    createBranch: async ({ repository, branch, headSha }) => {
      repositoryPath(repository);
      await run("git", ["push", "origin", `${headSha}:refs/heads/${branch}`]);
      const published = await findBranchByName({ repository, branch });
      if (published?.headSha !== headSha) {
        throw new Error("Published branch does not match the candidate");
      }
      return published;
    },
    updateBranch: async ({ repository, branch, headSha }) => {
      const pr = await findPullRequestOnBranch(repository, branch);
      if (pr !== undefined) {
        if (!pr.body.includes("<!-- shipyard:pull-request:")) {
          throw new Error("Cannot move an untracked pull request branch");
        }
        if (pr.state !== "open") {
          throw new Error("Cannot move a merged delivery branch");
        }
        if (!pr.draft) {
          await run("gh", [
            "pr",
            "ready",
            String(pr.number),
            "--undo",
            "--repo",
            repository,
          ]);
        }
        if (pr.labels?.includes("ready-for-human")) {
          await updateLabels(
            "pr",
            repository,
            pr.number,
            pr.labels,
            pr.labels.filter((label) => label !== "ready-for-human"),
          );
        }
      }
      await run("git", ["push", "origin", `${headSha}:refs/heads/${branch}`]);
      const published = await findBranchByName({ repository, branch });
      if (published?.headSha !== headSha) {
        throw new Error("Published branch does not match the candidate");
      }
      return published;
    },
    createPullRequest: async ({
      repository,
      title,
      body,
      branch,
      baseBranch,
      draft,
    }) => {
      const response = await api(`${repositoryPath(repository)}/pulls`, [
        "--method",
        "POST",
        "-f",
        `title=${title}`,
        "-f",
        `body=${body}`,
        "-f",
        `head=${branch}`,
        "-f",
        `base=${baseBranch}`,
        "-F",
        `draft=${draft}`,
      ]);
      return parsePullRequest(response);
    },
    updatePullRequest: async ({
      repository,
      pullRequestNumber,
      title,
      body,
      draft,
      labels,
    }) => {
      const current = await fetchPullRequest({ repository, pullRequestNumber });
      if (current === undefined)
        throw new Error("Tracked pull request is missing");
      if (draft === true && !current.draft) {
        await run("gh", [
          "pr",
          "ready",
          String(pullRequestNumber),
          "--undo",
          "--repo",
          repository,
        ]);
      }
      if (labels !== undefined) {
        await updateLabels(
          "pr",
          repository,
          pullRequestNumber,
          current.labels ?? [],
          labels,
        );
      }
      if (title !== undefined || body !== undefined) {
        const args = [
          "pr",
          "edit",
          String(pullRequestNumber),
          "--repo",
          repository,
        ];
        if (title !== undefined) args.push("--title", title);
        if (body !== undefined) args.push("--body", body);
        await run("gh", args);
      }
      if (draft === false && current.draft) {
        await run("gh", [
          "pr",
          "ready",
          String(pullRequestNumber),
          "--repo",
          repository,
        ]);
      }
      const updated = await fetchPullRequest({ repository, pullRequestNumber });
      if (updated === undefined)
        throw new Error("Updated pull request is missing");
      return updated;
    },
    createCheck: async ({
      repository,
      name,
      headSha,
      marker,
      status,
      conclusion,
    }) => {
      const state =
        status !== "completed"
          ? "pending"
          : conclusion === "success"
            ? "success"
            : "failure";
      const response = await api(
        `${repositoryPath(repository)}/statuses/${headSha}`,
        [
          "--method",
          "POST",
          "-f",
          `context=${name}`,
          "-f",
          `state=${state}`,
          "-f",
          `description=${statusMarker(marker)}`,
        ],
      );
      return parseStatus(response, headSha);
    },
    createRepairIssue: async ({ repository, title, body, labels }) => {
      const args = [
        "issue",
        "create",
        "--repo",
        repository,
        "--title",
        title,
        "--body",
        body,
      ];
      for (const label of labels) args.push("--label", label);
      const url = await run("gh", args);
      const number = Number(/\/issues\/(\d+)\/?$/.exec(url)?.[1]);
      const issue = await fetchIssue({ repository, issueNumber: number });
      if (issue === undefined)
        throw new Error("Published repair issue is missing");
      return issue;
    },
    closeIssue: async ({ repository, issueNumber: number }) => {
      await run("gh", [
        "issue",
        "close",
        String(issueNumber(number)),
        "--repo",
        repository,
      ]);
      const issue = await fetchIssue({ repository, issueNumber: number });
      if (issue === undefined)
        throw new Error("Closed source issue is missing");
      return issue;
    },
    updateIssue: async ({ repository, issueNumber: number, labels }) => {
      const current = await fetchIssue({ repository, issueNumber: number });
      if (current === undefined) throw new Error("Source issue is missing");
      await updateLabels("issue", repository, number, current.labels, labels);
      const updated = await fetchIssue({ repository, issueNumber: number });
      if (updated === undefined)
        throw new Error("Updated source issue is missing");
      return updated;
    },
    ensureLabel: async ({ repository, name, color, description }) => {
      await run("gh", [
        "label",
        "create",
        name,
        "--repo",
        repository,
        "--color",
        color,
        "--description",
        description,
        "--force",
      ]);
      return { name, color, description };
    },
  };
};

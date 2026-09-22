import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseGitHubPublicationMetadata } from "./publication.js";
import type { GitHubPublicationMetadata } from "./types.js";

const execFileAsync = promisify(execFile);

export type TemplateCommand = (
  file: string,
  args: readonly string[],
) => Promise<string>;

const defaultCommand: TemplateCommand = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
};

interface TemplatePullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headRefOid: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly isDraft: boolean;
  readonly labels?: readonly { readonly name: string }[];
  readonly url: string;
}

export interface TemplateDeliveryInput {
  readonly repository: string;
  readonly itemId: string;
  readonly kind: GitHubPublicationMetadata["kind"];
  readonly branch: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly title: string;
  readonly body: string;
  readonly metadata: Omit<GitHubPublicationMetadata, "headSha">;
  /** Keep activation until all planning-spec child waves have published. */
  readonly retainActivation?: boolean;
  readonly run?: TemplateCommand;
}

export interface TemplateDeliveryResult {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly draft: boolean;
}

export interface TemplateIntegrationInput {
  readonly repositoryPath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly commits: readonly string[];
  readonly run?: TemplateCommand;
}

export interface TemplateIntegrationResult {
  readonly headSha: string;
  readonly integratedCommits: number;
}

/** Build one integration candidate from child commits, skipping replayed patches. */
export const integrateTemplateDelivery = async (
  input: TemplateIntegrationInput,
): Promise<TemplateIntegrationResult> => {
  if (input.commits.length === 0) {
    throw new Error("Spec integration requires child commits");
  }
  for (const commit of input.commits) {
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error("Spec child returned an invalid commit SHA");
    }
  }
  const run = input.run ?? defaultCommand;
  const git = (args: readonly string[]) =>
    run("git", ["-C", input.repositoryPath, ...args]);
  await git(["fetch", "origin"]);
  const remote = `refs/remotes/origin/${input.branch}`;
  const base = `refs/remotes/origin/${input.baseBranch}`;
  let start = base;
  try {
    await git(["show-ref", "--verify", remote]);
    start = remote;
  } catch {
    await git(["show-ref", "--verify", base]);
  }
  const temporary = await mkdtemp(join(tmpdir(), "shipyard-integration-"));
  const worktree = join(temporary, "worktree");
  let attached = false;
  try {
    await git(["worktree", "add", "--detach", worktree, start]);
    attached = true;
    let integratedCommits = 0;
    for (const commit of input.commits) {
      const equivalent = await run("git", [
        "-C",
        worktree,
        "cherry",
        "HEAD",
        commit,
        `${commit}^`,
      ]);
      if (equivalent.trimStart().startsWith("-")) continue;
      try {
        await run("git", ["-C", worktree, "cherry-pick", commit]);
      } catch (error) {
        const diagnostic =
          error instanceof Error ? error.message : String(error);
        if (!diagnostic.includes("cherry-pick is now empty")) throw error;
        await run("git", ["-C", worktree, "cherry-pick", "--skip"]);
        continue;
      }
      integratedCommits++;
    }
    const headSha = await run("git", ["-C", worktree, "rev-parse", "HEAD"]);
    return { headSha, integratedCommits };
  } finally {
    if (attached) await git(["worktree", "remove", "--force", worktree]);
    await rm(temporary, { recursive: true, force: true });
  }
};

const fields =
  "number,title,body,headRefOid,headRefName,baseRefName,state,isDraft,labels,url";

const parsePullRequest = (raw: string): TemplatePullRequest => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("GitHub returned an invalid pull request");
  }
  const candidate = parsed as Partial<TemplatePullRequest>;
  if (
    !Number.isSafeInteger(candidate.number) ||
    typeof candidate.body !== "string" ||
    typeof candidate.headRefOid !== "string" ||
    typeof candidate.headRefName !== "string" ||
    typeof candidate.baseRefName !== "string" ||
    typeof candidate.url !== "string"
  ) {
    throw new Error("GitHub returned incomplete pull request data");
  }
  return candidate as TemplatePullRequest;
};

/** Publish a generated workflow candidate through one stable draft PR. */
export const publishTemplateDelivery = async (
  input: TemplateDeliveryInput,
): Promise<TemplateDeliveryResult> => {
  const run = input.run ?? defaultCommand;
  if (!/^[0-9a-f]{40}$/i.test(input.headSha)) {
    throw new Error("Delivery candidate must be a full git commit SHA");
  }
  const marker = `<!-- shipyard:template-delivery:${encodeURIComponent(input.repository)}:${encodeURIComponent(input.itemId)} -->`;
  const metadata = { ...input.metadata, headSha: input.headSha };
  if (
    metadata.repository !== input.repository ||
    metadata.itemId !== input.itemId ||
    metadata.kind !== input.kind ||
    metadata.branch !== input.branch ||
    metadata.baseBranch !== input.baseBranch
  ) {
    throw new Error(
      "Delivery metadata does not match the publication identity",
    );
  }
  const body = [
    marker,
    `<!-- shipyard:metadata ${JSON.stringify(metadata)} -->`,
    input.body,
  ].join("\n");
  if (parseGitHubPublicationMetadata(body) === undefined) {
    throw new Error("Delivery metadata is incomplete");
  }

  const listed: unknown = JSON.parse(
    await run("gh", [
      "pr",
      "list",
      "--repo",
      input.repository,
      "--head",
      input.branch,
      "--state",
      "all",
      "--limit",
      "100",
      "--json",
      fields,
    ]),
  );
  if (!Array.isArray(listed))
    throw new Error("GitHub returned an invalid PR list");
  const marked = listed
    .map((entry) => parsePullRequest(JSON.stringify(entry)))
    .filter((entry) => entry.body.includes(marker));
  if (marked.length > 1) throw new Error("Multiple PRs identify one delivery");
  let pullRequest = marked[0];
  if (pullRequest === undefined && listed.length > 0) {
    throw new Error("Delivery branch is already used by an unrelated PR");
  }
  if (
    pullRequest !== undefined &&
    (pullRequest.state !== "OPEN" ||
      pullRequest.headRefName !== input.branch ||
      pullRequest.baseRefName !== input.baseBranch)
  ) {
    throw new Error("Existing delivery PR is closed or targets another branch");
  }
  const candidateChanged =
    pullRequest !== undefined &&
    (pullRequest.title !== input.title ||
      pullRequest.body !== body ||
      pullRequest.headRefOid !== input.headSha);
  if (pullRequest !== undefined && candidateChanged) {
    if (!pullRequest.isDraft) {
      await run("gh", [
        "pr",
        "ready",
        String(pullRequest.number),
        "--undo",
        "--repo",
        input.repository,
      ]);
    }
    if (pullRequest.labels?.some((label) => label.name === "ready-for-human")) {
      await run("gh", [
        "pr",
        "edit",
        String(pullRequest.number),
        "--repo",
        input.repository,
        "--remove-label",
        "ready-for-human",
      ]);
    }
  }
  if (pullRequest === undefined || pullRequest.headRefOid !== input.headSha) {
    await run("git", [
      "push",
      "origin",
      `${input.headSha}:refs/heads/${input.branch}`,
    ]);
  }
  let requiresDraft = true;
  if (pullRequest === undefined) {
    await run("gh", [
      "pr",
      "create",
      "--repo",
      input.repository,
      "--head",
      input.branch,
      "--base",
      input.baseBranch,
      "--draft",
      "--title",
      input.title,
      "--body",
      body,
    ]);
  } else {
    requiresDraft = candidateChanged || pullRequest.isDraft;
    if (candidateChanged) {
      await run("gh", [
        "pr",
        "edit",
        String(pullRequest.number),
        "--repo",
        input.repository,
        "--title",
        input.title,
        "--body",
        body,
      ]);
    }
  }
  pullRequest = parsePullRequest(
    await run("gh", [
      "pr",
      "view",
      pullRequest === undefined ? input.branch : String(pullRequest.number),
      "--repo",
      input.repository,
      "--json",
      fields,
    ]),
  );
  if (
    pullRequest.state !== "OPEN" ||
    pullRequest.headRefOid !== input.headSha ||
    pullRequest.headRefName !== input.branch ||
    pullRequest.baseRefName !== input.baseBranch ||
    (requiresDraft && !pullRequest.isDraft) ||
    (candidateChanged &&
      pullRequest.labels?.some((label) => label.name === "ready-for-human")) ||
    pullRequest.body !== body
  ) {
    throw new Error("Published PR does not match the exact draft candidate");
  }
  if (!input.retainActivation) {
    await run("gh", [
      "issue",
      "edit",
      input.itemId,
      "--repo",
      input.repository,
      "--remove-label",
      "shipyard",
    ]);
  }
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    headSha: pullRequest.headRefOid,
    draft: pullRequest.isDraft,
  };
};

// GitHub issue workflow. The selected personal skill owns implementation,
// verification, cleanup, and review; this file selects one item and publishes
// its completed branch for human review.

import { execFileSync } from "node:child_process";
import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";

const ACTIVATION_LABEL = "shipyard";
const PROMPT_FILE = "./.shipyard/prompt.md";
const MAX_ITERATIONS = 100;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const HANDOFF_START = "<shipyard-handoff>";
const HANDOFF_END = "</shipyard-handoff>";

type Label = string | { readonly name: string };

interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: string;
  readonly url?: string;
  readonly html_url?: string;
  readonly parent_issue_url?: string;
  readonly labels?: readonly Label[];
}

interface Comment {
  readonly body: string;
  readonly created_at?: string;
  readonly user?: { readonly login?: string };
}

interface PullRequest {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED";
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly mergedAt?: string | null;
}

interface Repository {
  readonly nameWithOwner: string;
  readonly defaultBranchRef: { readonly name: string };
}

interface TicketContext {
  readonly issue: Issue;
  readonly comments: readonly Comment[];
  readonly blockedBy: readonly number[];
}

interface WorkItem {
  readonly kind: "standalone" | "spec";
  readonly root: TicketContext;
  readonly tickets: readonly TicketContext[];
  readonly dependencies: readonly TicketContext[];
  readonly activatedIssues: readonly number[];
}

interface HandoffEvidence {
  readonly block: string;
  readonly limitations: string;
}

const gh = (args: readonly string[]): string =>
  execFileSync("gh", [...args], {
    encoding: "utf8",
    maxBuffer: OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const ghJson = <T,>(args: readonly string[]): T => JSON.parse(gh(args)) as T;

const ghList = <T,>(endpoint: string): T[] => {
  const pages = ghJson<unknown>(["api", "--paginate", "--slurp", endpoint]);
  if (!Array.isArray(pages))
    throw new Error("Expected a paginated list from " + endpoint);
  return pages.flatMap((page) => (Array.isArray(page) ? page : [page])) as T[];
};

const git = (args: readonly string[]): string =>
  execFileSync("git", [...args], {
    encoding: "utf8",
    maxBuffer: OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const issueEndpoint = (repo: string, number: number): string =>
  "repos/" + repo + "/issues/" + number;

const getIssue = (repo: string, number: number): Issue =>
  ghJson<Issue>(["api", issueEndpoint(repo, number)]);

const getComments = (repo: string, number: number): Comment[] =>
  ghList<Comment>(issueEndpoint(repo, number) + "/comments?per_page=100");

const labelsFor = (issue: Issue): string[] =>
  (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );

const isActivated = (issue: Issue): boolean =>
  issue.state.toLowerCase() === "open" &&
  labelsFor(issue).includes(ACTIVATION_LABEL);

const workItemType = (issue: Issue): "spec" | "executable" | undefined => {
  const match = issue.body?.match(/^\s*\*\*Work item type:\*\*\s*([^\n]+)/im);
  if (!match) return undefined;
  const type = match[1]!.trim().toLowerCase();
  if (type.startsWith("planning spec")) return "spec";
  if (type.startsWith("executable")) return "executable";
  return undefined;
};

const bodyRelationship = (
  body: string | null,
  heading: "Parent" | "Blocked by",
): number[] => {
  if (!body) return [];
  const section = new RegExp(
    "(?:^|\\n)\\s*#{1,6}\\s*" +
      heading +
      "\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|$)",
    "i",
  ).exec(body)?.[1];
  if (!section) return [];
  return [...section.matchAll(/#(\d+)\b/g)].map((match) => Number(match[1]));
};

const parentNumber = (issue: Issue): number | undefined => {
  const nativeParent = issue.parent_issue_url?.match(/\/issues\/(\d+)\/?$/);
  if (issue.parent_issue_url && !nativeParent) {
    throw new Error(
      "Issue #" +
        issue.number +
        " has an unreadable native parent relationship.",
    );
  }
  const bodyParents = bodyRelationship(issue.body, "Parent");
  const references = new Set([
    ...(nativeParent ? [Number(nativeParent[1])] : []),
    ...bodyParents,
  ]);
  if (references.size > 1) {
    throw new Error(
      "Issue #" +
        issue.number +
        " has conflicting parent relationships: " +
        [...references].map((id) => "#" + id).join(", ") +
        ".",
    );
  }
  return references.values().next().value;
};

const blockedByNumbers = (issue: Issue, repo: string): number[] => {
  const nativeDependencies = ghList<Issue>(
    issueEndpoint(repo, issue.number) + "/dependencies/blocked_by?per_page=100",
  ).map((dependency) => dependency.number);
  return [
    ...new Set([
      ...nativeDependencies,
      ...bodyRelationship(issue.body, "Blocked by"),
    ]),
  ];
};

const contextFor = (
  repo: string,
  issue: Issue,
  blockedBy: readonly number[],
): TicketContext => ({
  issue,
  comments: getComments(repo, issue.number),
  blockedBy,
});

const allRepositoryIssues = (repo: string): Issue[] =>
  ghJson<Issue[]>([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--limit",
    "1000",
    "--json",
    "number,title,body,state,url,labels",
  ]);

const specChildren = (
  repo: string,
  root: Issue,
  allIssues: readonly Issue[],
  activatedChild?: Issue,
): Issue[] => {
  const native = ghList<Issue>(
    issueEndpoint(repo, root.number) + "/sub_issues?per_page=100",
  );
  const linkedByConvention = allIssues.filter((issue) =>
    bodyRelationship(issue.body, "Parent").includes(root.number),
  );
  const candidateNumbers = new Set([
    ...native.map((issue) => issue.number),
    ...linkedByConvention.map((issue) => issue.number),
    ...(activatedChild ? [activatedChild.number] : []),
  ]);
  const children = [...candidateNumbers]
    .filter((number) => number !== root.number)
    .map((number) => getIssue(repo, number));

  for (const child of children) {
    const declaredParent = parentNumber(child);
    const isNativeChild = native.some((issue) => issue.number === child.number);
    if (declaredParent !== root.number && !isNativeChild) {
      throw new Error(
        "Issue #" +
          child.number +
          " has an ambiguous link to planning spec #" +
          root.number +
          ".",
      );
    }
    if (declaredParent !== undefined && declaredParent !== root.number) {
      throw new Error(
        "Issue #" + child.number + " has conflicting parent relationships.",
      );
    }
    if (workItemType(child) !== "executable") {
      throw new Error(
        "Issue #" +
          child.number +
          " is linked to planning spec #" +
          root.number +
          " but is not marked as executable.",
      );
    }
  }

  if (children.length === 0) {
    throw new Error(
      "Planning spec #" + root.number + " has no linked executable tickets.",
    );
  }
  return children.sort((left, right) => left.number - right.number);
};

const dependencyContexts = (
  repo: string,
  tickets: readonly Issue[],
): { contexts: TicketContext[]; byTicket: Map<number, number[]> } => {
  const scoped = new Set(tickets.map((ticket) => ticket.number));
  const visited = new Set<number>();
  const pending = [...tickets];
  const byTicket = new Map<number, number[]>();
  const dependencies = new Map<number, Issue>();

  while (pending.length > 0) {
    const issue = pending.shift()!;
    if (visited.has(issue.number)) continue;
    visited.add(issue.number);
    const blockedBy = blockedByNumbers(issue, repo);
    byTicket.set(issue.number, blockedBy);
    for (const number of blockedBy) {
      if (scoped.has(number) || dependencies.has(number)) continue;
      const dependency = getIssue(repo, number);
      dependencies.set(number, dependency);
      pending.push(dependency);
    }
  }

  const contexts = [...dependencies.values()]
    .sort((left, right) => left.number - right.number)
    .map((issue) => contextFor(repo, issue, byTicket.get(issue.number) ?? []));
  return { contexts, byTicket };
};

const makeWorkItem = (
  repo: string,
  root: Issue,
  kind: WorkItem["kind"],
  tickets: readonly Issue[],
  activatedIssues: readonly number[],
): WorkItem => {
  const { contexts: dependencies, byTicket } = dependencyContexts(
    repo,
    tickets,
  );
  const contexts = tickets.map((issue) =>
    contextFor(repo, issue, byTicket.get(issue.number) ?? []),
  );
  const rootContext =
    kind === "standalone"
      ? contexts[0]!
      : contextFor(repo, root, byTicket.get(root.number) ?? []);
  return {
    kind,
    root: rootContext,
    tickets: contexts,
    dependencies,
    activatedIssues,
  };
};

const resolveActivated = (
  repo: string,
  activation: Issue,
  allIssues: readonly Issue[],
): WorkItem | undefined => {
  const issue = getIssue(repo, activation.number);
  if (!isActivated(issue)) return undefined;

  const parentId = parentNumber(issue);
  if (parentId !== undefined) {
    const parent = getIssue(repo, parentId);
    if (workItemType(parent) !== "spec") {
      throw new Error(
        "Activated issue #" +
          issue.number +
          " has parent #" +
          parentId +
          ", which is not a planning spec.",
      );
    }
    if (parent.state.toLowerCase() !== "open") {
      throw new Error(
        "Activated issue #" +
          issue.number +
          " belongs to closed planning spec #" +
          parentId +
          ".",
      );
    }
    const tickets = specChildren(repo, parent, allIssues, issue);
    return makeWorkItem(repo, parent, "spec", tickets, [issue.number]);
  }

  if (workItemType(issue) === "spec") {
    const tickets = specChildren(repo, issue, allIssues);
    return makeWorkItem(repo, issue, "spec", tickets, [issue.number]);
  }

  return makeWorkItem(repo, issue, "standalone", [issue], [issue.number]);
};

const relatedPullRequests = (repo: string, item: WorkItem): PullRequest[] => {
  const branch =
    item.kind === "spec"
      ? "shipyard/spec-" + item.root.issue.number
      : "shipyard/issue-" + item.root.issue.number;
  const pullRequests = ghJson<PullRequest[]>([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--limit",
    "1000",
    "--json",
    "number,state,isDraft,headRefName,baseRefName,title,body,url,mergedAt",
  ]);
  const rootReference = new RegExp(
    "(?:^|[^\\w])#" + item.root.issue.number + "(?!\\d)",
  );
  return pullRequests.filter(
    (pullRequest) =>
      pullRequest.headRefName === branch ||
      rootReference.test(pullRequest.body),
  );
};

const removeActivationLabels = (
  repo: string,
  issues: readonly number[],
): void => {
  for (const number of new Set(issues)) {
    try {
      execFileSync(
        "gh",
        [
          "issue",
          "edit",
          String(number),
          "--repo",
          repo,
          "--remove-label",
          ACTIVATION_LABEL,
        ],
        { stdio: "ignore" },
      );
    } catch (error) {
      console.warn(
        "Could not remove activation label from #" +
          number +
          ": " +
          String(error),
      );
    }
  }
};

const activationNumbersFor = (
  item: WorkItem,
  allActivated: readonly Issue[],
): number[] => {
  const scope = new Set([
    item.root.issue.number,
    ...item.tickets.map((ticket) => ticket.issue.number),
  ]);
  return [
    ...new Set(
      allActivated
        .filter((issue) => scope.has(issue.number))
        .map((issue) => issue.number)
        .concat(item.activatedIssues),
    ),
  ].sort((left, right) => left - right);
};

const handoffEvidence = (stdout: string): HandoffEvidence | undefined => {
  const start = stdout.lastIndexOf(HANDOFF_START);
  const end = start === -1 ? -1 : stdout.indexOf(HANDOFF_END, start);
  if (start === -1 || end === -1) return undefined;
  const block = stdout.slice(start + HANDOFF_START.length, end).trim();
  const ready = /^status:\s*ready-for-human\s*$/im.test(block);
  const verification = /^verification:\s*\S.*(?:passed|pass)\s*$/im.test(block);
  const review =
    /^review:\s*\S.*(?:no findings|findings resolved|approved)\s*$/im.test(
      block,
    );
  const findings = /^findings:\s*(?:none|resolved)\s*$/im.test(block);
  if (!ready || !verification || !review || !findings) return undefined;
  const limitations =
    /^limitations:\s*(.+)$/im.exec(block)?.[1]?.trim() ?? "none";
  return { block, limitations };
};

const prBody = (item: WorkItem, evidence: HandoffEvidence): string => {
  const references =
    item.kind === "spec"
      ? [
          item.root.issue.number,
          ...item.tickets.map((ticket) => ticket.issue.number),
        ]
      : [item.root.issue.number];
  const uniqueReferences = [...new Set(references)];
  const closingReferences = uniqueReferences
    .map((number) => "Closes #" + number)
    .join("\n");
  const ticketLinks = uniqueReferences
    .map((number) => "- #" + number)
    .join("\n");
  return [
    "## Ready for human review",
    "",
    "This " +
      (item.kind === "spec" ? "integrated specification" : "standalone issue") +
      " completed through the repository's personal implementation skill. A maintainer must review and merge this pull request.",
    "",
    "## Scope",
    ticketLinks,
    "",
    "## Verification and review",
    evidence.block,
    "",
    "Limitations: " + evidence.limitations,
    "",
    closingReferences,
  ].join("\n");
};

const run = async (): Promise<void> => {
  const repository = ghJson<Repository>([
    "repo",
    "view",
    "--json",
    "nameWithOwner,defaultBranchRef",
  ]);
  const repo = repository.nameWithOwner;
  const baseBranch = repository.defaultBranchRef.name;
  const activations = ghJson<Issue[]>([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    ACTIVATION_LABEL,
    "--limit",
    "1000",
    "--json",
    "number,title,body,state,url,labels",
  ]).sort((left, right) => left.number - right.number);

  if (activations.length === 0) {
    console.log("No activated GitHub issues.");
    return;
  }

  const allIssues = allRepositoryIssues(repo);
  const resolved = activations
    .map((activation) => resolveActivated(repo, activation, allIssues))
    .filter((item): item is WorkItem => item !== undefined);
  const byRoot = new Map<number, WorkItem>();
  for (const item of resolved) {
    const rootId = item.root.issue.number;
    const prior = byRoot.get(rootId);
    byRoot.set(
      rootId,
      prior
        ? {
            ...prior,
            activatedIssues: [
              ...new Set([...prior.activatedIssues, ...item.activatedIssues]),
            ],
          }
        : item,
    );
  }
  const item = byRoot.values().next().value as WorkItem | undefined;
  if (!item) {
    console.log("No currently activated GitHub issues.");
    return;
  }

  const activationNumbers = activationNumbersFor(item, activations);
  const existing = relatedPullRequests(repo, item);
  if (existing.length > 1) {
    throw new Error(
      "Multiple pull requests match " +
        item.kind +
        " #" +
        item.root.issue.number +
        "; refusing to create another.",
    );
  }
  const existingPullRequest = existing[0];
  if (existingPullRequest && !existingPullRequest.isDraft) {
    removeActivationLabels(repo, activationNumbers);
    const disposition = existingPullRequest.mergedAt
      ? "already merged"
      : existingPullRequest.state === "OPEN"
        ? "already ready for human review"
        : "already closed";
    console.log(
      "Skipping " +
        item.kind +
        " #" +
        item.root.issue.number +
        ": pull request " +
        existingPullRequest.url +
        " is " +
        disposition +
        ".",
    );
    return;
  }

  const branch =
    existingPullRequest?.headRefName ??
    (item.kind === "spec"
      ? "shipyard/spec-" + item.root.issue.number
      : "shipyard/issue-" + item.root.issue.number);
  const targetBranch = existingPullRequest?.baseRefName ?? baseBranch;
  if (existingPullRequest) {
    try {
      git(["show-ref", "--verify", "--quiet", "refs/heads/" + branch]);
    } catch {
      git([
        "fetch",
        "origin",
        "refs/heads/" + branch + ":refs/heads/" + branch,
      ]);
    }
  }

  const context = Buffer.from(JSON.stringify(item), "utf8").toString("base64");
  const runResult = await shipyard.run({
    name: item.kind === "spec" ? "implement-spec" : "implement",
    maxIterations: MAX_ITERATIONS,
    agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
    sandbox: docker(),
    branchStrategy: {
      type: "branch",
      branch,
      baseBranch: "origin/" + targetBranch,
    },
    hooks: {
      sandbox: {
        onSandboxReady: [
          { command: installSkillsCommand },
          { command: installDependenciesCommand },
        ],
      },
    },
    promptFile: PROMPT_FILE,
    promptArgs: {
      TASK_ID: String(item.root.issue.number),
      TASK_TYPE: item.kind,
      BRANCH: branch,
      BASE_BRANCH: targetBranch,
      WORK_ITEM_BASE64: context,
    },
  });

  if (runResult.completionSignal !== "<promise>COMPLETE</promise>") {
    throw new Error(
      "The /" +
        (item.kind === "spec" ? "implement-spec" : "implement") +
        " skill did not complete. No pull request was handed off.",
    );
  }
  const evidence = handoffEvidence(runResult.stdout);
  if (!evidence) {
    throw new Error(
      "The skill did not report passing verification, completed review, and no unresolved findings. No pull request was handed off.",
    );
  }
  const commitCount = Number(
    git(["rev-list", "--count", "origin/" + targetBranch + ".." + branch]),
  );
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    throw new Error(
      "The completed skill produced no integration commits. No pull request was handed off.",
    );
  }

  git(["push", "--set-upstream", "origin", branch]);
  const title = ("Implement: " + item.root.issue.title).slice(0, 250);
  const body = prBody(item, evidence);
  if (existingPullRequest) {
    execFileSync(
      "gh",
      [
        "pr",
        "edit",
        String(existingPullRequest.number),
        "--repo",
        repo,
        "--base",
        targetBranch,
        "--title",
        title,
        "--body",
        body,
      ],
      { stdio: "ignore" },
    );
    gh(["pr", "ready", String(existingPullRequest.number), "--repo", repo]);
  } else {
    const url = gh([
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      targetBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]);
    console.log("Pull request ready for human review: " + url);
  }
  removeActivationLabels(repo, activationNumbers);
};

const installSkillsCommand = [
  "set -eu",
  'if [ -f "$HOME/.agents/skills/implement/SKILL.md" ] && [ -f "$HOME/.agents/skills/implement-spec/SKILL.md" ] && [ -f "$HOME/.agents/skills/code-cleanup/SKILL.md" ] && [ -f "$HOME/.agents/skills/code-review/SKILL.md" ] && [ -f "$HOME/.agents/skills/tdd/SKILL.md" ]; then',
  "  exit 0",
  "fi",
  'skills_root="$(mktemp -d)"',
  "trap 'rm -rf \"$skills_root\"' EXIT",
  'git clone --depth 1 https://github.com/snappedly/skills.git "$skills_root/repository"',
  'mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"',
  'for source in "$skills_root"/repository/skills/*/*; do',
  '  [ -d "$source" ] || continue',
  '  name="$(basename "$source")"',
  '  for destination in "$HOME/.agents/skills" "$HOME/.claude/skills"; do',
  '    mkdir -p "$destination/$name"',
  '    cp -R "$source"/. "$destination/$name"/',
  "  done",
  "done",
  "for skill in implement implement-spec code-cleanup code-review tdd; do",
  '  test -f "$HOME/.agents/skills/$skill/SKILL.md"',
  "done",
  'echo "Installed Snappedly implementation and review skills."',
].join("\n");

const installDependenciesCommand = [
  "set -eu",
  "if [ ! -f package.json ]; then exit 0; fi",
  'manager="$(node -e \'const p=require("./package.json"); process.stdout.write((p.packageManager || "").split("@")[0])\')"',
  'if [ -z "$manager" ]; then',
  "  if [ -f bun.lock ] || [ -f bun.lockb ]; then manager=bun",
  "  elif [ -f pnpm-lock.yaml ]; then manager=pnpm",
  "  elif [ -f yarn.lock ]; then manager=yarn",
  "  else manager=npm",
  "  fi",
  "fi",
  'case "$manager" in',
  "  npm)",
  "    if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci; else npm install; fi",
  "    ;;",
  "  pnpm)",
  "    if [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile; else corepack pnpm install; fi",
  "    ;;",
  "  yarn)",
  "    if [ -f yarn.lock ]; then corepack yarn install --frozen-lockfile; else corepack yarn install; fi",
  "    ;;",
  "  bun)",
  "    if ! command -v bun >/dev/null 2>&1; then curl -fsSL https://bun.sh/install | bash -s -- --no-modify-path; fi",
  '    export PATH="$HOME/.bun/bin:$PATH"',
  "    if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; else bun install; fi",
  "    ;;",
  '  *) echo "Unsupported package manager: $manager" >&2; exit 1 ;;',
  "esac",
].join("\n");

await run();

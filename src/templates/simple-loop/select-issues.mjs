import { execFileSync } from "node:child_process";

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
const repository =
  process.env.GH_REPO ||
  gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
const issues = JSON.parse(
  gh(
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    "shipyard",
    "--limit",
    "100",
    "--json",
    "number,title,body",
  ),
);
const selected = [];

for (const issue of issues) {
  const number = String(issue.number);
  if (!/^\d+$/.test(number)) throw new Error("Invalid GitHub issue number");
  const body = issue.body ?? "";
  if (
    /work item type:\*?\*?\s*planning spec/i.test(body) ||
    /^##?\s*Parent\b/im.test(body)
  )
    continue;

  // Native sub-issue links take precedence over text conventions. A linked
  // child or a planning spec belongs to /implement-spec, added by ticket #75.
  try {
    gh("api", `repos/${repository}/issues/${number}/parent`);
    continue;
  } catch (error) {
    if (!/HTTP 404/.test(String(error.stderr))) throw error;
  }
  const children = Number(
    gh(
      "api",
      `repos/${repository}/issues/${number}/sub_issues`,
      "--jq",
      "length",
    ),
  );
  if (!Number.isFinite(children))
    throw new Error(`Could not inspect linked tickets for #${number}`);
  if (children > 0) continue;

  const branch = `shipyard/issue-${number}`;
  const existing = JSON.parse(
    gh(
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,isDraft,labels",
    ),
  );
  if (
    existing.some(
      (pr) =>
        !pr.isDraft &&
        pr.labels.some((label) => label.name === "ready-for-human"),
    )
  ) {
    gh(
      "issue",
      "edit",
      number,
      "--repo",
      repository,
      "--remove-label",
      "shipyard",
    );
    continue;
  }
  selected.push({ id: number, title: issue.title, branch });
}

process.stdout.write(`${JSON.stringify(selected)}\n`);

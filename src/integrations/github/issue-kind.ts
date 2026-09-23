import type { WorkItemKind } from "../../workflow/contracts/index.js";
import type { GitHubIssueSnapshot } from "./types.js";

export const githubIssueKind = (issue: GitHubIssueSnapshot): WorkItemKind => {
  const normalized = new Set(issue.labels.map((label) => label.toLowerCase()));
  if (
    normalized.has("planning-spec") ||
    normalized.has("planning") ||
    /^\s*(?:\*\*)?work item type:(?:\*\*)?\s*planning spec\b/im.test(issue.body)
  ) {
    return "planning-spec";
  }
  if (normalized.has("pr-repair") || normalized.has("repair")) {
    return "pr-repair";
  }
  return "executable-issue";
};

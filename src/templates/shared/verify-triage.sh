#!/usr/bin/env bash
set -euo pipefail

issue=${1:?issue number required}
repo=${2:?GitHub repository required}
[[ "$issue" =~ ^[0-9]+$ ]] || { echo "Invalid issue number" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid GitHub repository" >&2; exit 1; }

gh issue view "$issue" --repo "$repo" --json state,labels |
  node -e '
    const issue = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const labels = new Set(issue.labels.map((label) => label.name));
    const states = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"];
    if (issue.state !== "OPEN" || !labels.has("shipyard") ||
        states.filter((state) => labels.has(state)).join() !== "ready-for-agent") {
      console.error("Issue cannot be implemented: requires an open issue with shipyard and only ready-for-agent as its triage state");
      process.exit(1);
    }
  '

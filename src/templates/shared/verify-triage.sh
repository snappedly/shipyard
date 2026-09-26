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
    if (issue.state !== "OPEN" ||
        !(labels.has("shipyard") || labels.has("shipyard:pending"))) {
      console.error("Issue cannot be implemented: requires an open issue with shipyard or shipyard:pending");
      process.exit(1);
    }
    const triageStates = states.filter((state) => labels.has(state));
    if (triageStates.join() === "needs-info") {
      console.error("Issue needs information from the reporter before implementation");
      process.exit(1);
    }
    if (triageStates.join() !== "ready-for-agent") {
      console.error(`Issue cannot be implemented: triage state is ${triageStates.join() || "missing"}; requires only ready-for-agent`);
      process.exit(1);
    }
  '

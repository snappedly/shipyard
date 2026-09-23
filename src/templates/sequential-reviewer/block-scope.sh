#!/usr/bin/env bash
set -euo pipefail

root=${1:?scope root required}
failed=${2:?failed issue required}
repo=${3:?GitHub repository required}
scope=${4:?scope issue numbers required}
branch=${5:-shipyard/issue-$root}
[[ "$root" =~ ^[0-9]+$ && "$failed" =~ ^[0-9]+$ ]] || { echo "Invalid issue number" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid GitHub repository" >&2; exit 1; }
[[ "$scope" =~ ^[0-9]+(,[0-9]+)*$ && ( "$scope" == "$root" || "$scope" == "$root,"* ) && ",$scope," == *",$failed,"* ]] || {
  echo "Invalid blocked issue scope" >&2; exit 1;
}
[[ "$branch" == "shipyard/issue-$root" || "$branch" == "shipyard/spec-$root" ]] || { echo "Invalid scope branch" >&2; exit 1; }
reason=$(cat)
[[ -n "$reason" ]] || { echo "Missing failure reason" >&2; exit 1; }

gh label create shipyard:blocked --repo "$repo" --color B60205 --description 'Shipyard work needs intervention' --force
gh issue comment "$failed" --repo "$repo" --body "Shipyard could not complete this issue. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard:blocked, and add shipyard to the affected ticket."
gh issue edit "$failed" --repo "$repo" --add-label shipyard:blocked
gh issue edit "$failed" --repo "$repo" --remove-label shipyard:outstanding-tasks || true
gh issue edit "$failed" --repo "$repo" --remove-label shipyard:complete || true
if [[ "$root" != "$failed" ]]; then
  gh issue comment "$root" --repo "$repo" --body "Shipyard paused this spec because linked ticket #$failed failed. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard:blocked, and add shipyard to each unfinished ticket."
  gh issue edit "$root" --repo "$repo" --add-label shipyard:blocked
  gh issue edit "$root" --repo "$repo" --remove-label shipyard:outstanding-tasks || true
  gh issue edit "$root" --repo "$repo" --remove-label shipyard:complete || true
fi

if [[ "$branch" == "shipyard/spec-$root" && "$failed" == "$root" ]]; then
  IFS=',' read -ra affected_ids <<< "$scope"
  for affected_id in "${affected_ids[@]:1}"; do
    gh issue comment "$affected_id" --repo "$repo" --body "Shipyard could not complete this ticket during the spec attempt. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard:blocked, and add shipyard to the affected ticket."
    gh issue edit "$affected_id" --repo "$repo" --add-label shipyard:blocked
  done
fi

pr_number=$(gh pr list --repo "$repo" --head "$branch" --state open --json number --jq '.[0].number // empty')
if [[ -n "$pr_number" ]]; then
  gh pr edit "$pr_number" --repo "$repo" --add-label shipyard:blocked
  gh pr edit "$pr_number" --repo "$repo" --remove-label shipyard:outstanding-tasks || true
  gh pr edit "$pr_number" --repo "$repo" --remove-label shipyard:complete || true
fi

IFS=',' read -ra scope_ids <<< "$scope"
for scope_id in "${scope_ids[@]}"; do
  labels=$(gh issue view "$scope_id" --repo "$repo" --json labels --jq '.labels[].name')
  if grep -Fxq shipyard <<< "$labels"; then
    gh issue edit "$scope_id" --repo "$repo" --remove-label shipyard
  fi
done

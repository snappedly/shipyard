#!/usr/bin/env bash
set -euo pipefail

root=${1:?scope root required}
failed=${2:?failed issue required}
repo=${3:?GitHub repository required}
scope=${4:?scope issue numbers required}
[[ "$root" =~ ^[0-9]+$ && "$failed" =~ ^[0-9]+$ ]] || { echo "Invalid issue number" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid GitHub repository" >&2; exit 1; }
[[ "$scope" =~ ^[0-9]+(,[0-9]+)*$ && ( "$scope" == "$root" || "$scope" == "$root,"* ) && ",$scope," == *",$failed,"* ]] || {
  echo "Invalid blocked issue scope" >&2; exit 1;
}
reason=$(cat)
[[ -n "$reason" ]] || { echo "Missing failure reason" >&2; exit 1; }

gh label create shipyard:blocked --repo "$repo" --color B60205 --description 'Shipyard work needs intervention' --force
gh issue comment "$failed" --repo "$repo" --body "Shipyard could not complete this issue. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard:blocked, and add shipyard."
gh issue edit "$failed" --repo "$repo" --add-label shipyard:blocked
if [[ "$root" != "$failed" ]]; then
  gh issue comment "$root" --repo "$repo" --body "Shipyard paused this spec because linked ticket #$failed failed. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard:blocked, and add shipyard."
  gh issue edit "$root" --repo "$repo" --add-label shipyard:blocked
fi

IFS=',' read -ra scope_ids <<< "$scope"
for scope_id in "${scope_ids[@]}"; do
  labels=$(gh issue view "$scope_id" --repo "$repo" --json labels --jq '.labels[].name')
  if grep -Fxq shipyard <<< "$labels"; then
    gh issue edit "$scope_id" --repo "$repo" --remove-label shipyard
  fi
done

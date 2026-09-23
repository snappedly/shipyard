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
reason_hash=$(printf '%s' "$reason" | git hash-object --stdin)
pending_dir=$(git rev-parse --git-path shipyard-pending)
mkdir -p "$pending_dir"
umask 077
pending_file="$pending_dir/$root-$failed.pending"
pending_tmp=$(mktemp "$pending_file.XXXXXX")
trap 'rm -f "$pending_tmp"' EXIT
printf '%s\t%s\t%s\t%s\t%s\n%s' "$root" "$failed" "$repo" "$scope" "$branch" "$reason" > "$pending_tmp"
mv "$pending_tmp" "$pending_file"

remove_issue_status() {
  local labels
  if gh issue edit "$1" --repo "$repo" --remove-label "$2"; then return 0; fi
  labels=$(gh issue view "$1" --repo "$repo" --json labels --jq '.labels[].name') || return 75
  if grep -Fxq "$2" <<< "$labels"; then
    echo "Could not remove $2 from issue #$1" >&2
    return 75
  fi
}
remove_pr_status() {
  local labels
  if gh pr edit "$1" --repo "$repo" --remove-label "$2"; then return 0; fi
  labels=$(gh pr view "$1" --repo "$repo" --json labels --jq '.labels[].name') || return 75
  if grep -Fxq "$2" <<< "$labels"; then
    echo "Could not remove $2 from PR #$1" >&2
    return 75
  fi
}
comment_once() {
  local comments
  if comments=$(gh issue view "$1" --repo "$repo" --json comments --jq '.comments[].body'); then
    if grep -Fq "$3" <<< "$comments"; then return 0; fi
  fi
  gh issue comment "$1" --repo "$repo" --body "$2"
}

gh label create shipyard:blocked --repo "$repo" --color B60205 --description 'Shipyard work needs intervention' --force
gh issue edit "$failed" --repo "$repo" --add-label shipyard:blocked
if [[ "$root" != "$failed" ]]; then
  gh issue edit "$root" --repo "$repo" --add-label shipyard:blocked
fi
if [[ "$branch" == "shipyard/spec-$root" && "$failed" == "$root" ]]; then
  IFS=',' read -ra affected_ids <<< "$scope"
  for affected_id in "${affected_ids[@]:1}"; do
    gh issue edit "$affected_id" --repo "$repo" --add-label shipyard:blocked
  done
fi

status=0
marker="shipyard:blocked:$root:$failed:$reason_hash"
comment_once "$failed" "Shipyard could not complete this issue. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard:blocked, and add shipyard to the affected ticket.

<!-- $marker:failed -->" "$marker:failed" || status=75
if [[ "$root" != "$failed" ]]; then
  comment_once "$root" "Shipyard paused this spec because linked ticket #$failed failed. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard:blocked, and add shipyard to each unfinished ticket.

<!-- $marker:parent -->" "$marker:parent" || status=75
fi
if [[ "$branch" == "shipyard/spec-$root" && "$failed" == "$root" ]]; then
  for affected_id in "${affected_ids[@]:1}"; do
    comment_once "$affected_id" "Shipyard could not complete this ticket during the spec attempt. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard:blocked, and add shipyard to the affected ticket.

<!-- $marker:ticket:$affected_id -->" "$marker:ticket:$affected_id" || status=75
  done
fi

remove_issue_status "$failed" shipyard:outstanding-tasks || status=75
remove_issue_status "$failed" shipyard:complete || status=75
if [[ "$root" != "$failed" ]]; then
  remove_issue_status "$root" shipyard:outstanding-tasks || status=75
  remove_issue_status "$root" shipyard:complete || status=75
fi

if ! pr_number=$(gh pr list --repo "$repo" --head "$branch" --state open --json number --jq '.[0].number // empty'); then
  status=75
  pr_number=""
fi
if [[ -n "$pr_number" ]]; then
  gh pr edit "$pr_number" --repo "$repo" --add-label shipyard:blocked || status=75
  remove_pr_status "$pr_number" ready-for-human || status=75
  remove_pr_status "$pr_number" shipyard:outstanding-tasks || status=75
  remove_pr_status "$pr_number" shipyard:complete || status=75
fi
if [[ "$status" -eq 0 ]]; then
  IFS=',' read -ra scope_ids <<< "$scope"
  for scope_id in "${scope_ids[@]}"; do
    labels=$(gh issue view "$scope_id" --repo "$repo" --json labels --jq '.labels[].name')
    if grep -Fxq shipyard <<< "$labels"; then
      gh issue edit "$scope_id" --repo "$repo" --remove-label shipyard
    fi
  done
  rm -f "$pending_file"
fi
exit "$status"

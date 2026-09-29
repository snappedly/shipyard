#!/usr/bin/env bash
set -euo pipefail

root=${1:?scope root required}
failed=${2:?failed issue required}
repo=${3:?GitHub repository required}
scope=${4:?scope issue numbers required}
branch=${5:-shipyard-v1/issue-$root}
[[ "$root" =~ ^[0-9]+$ && "$failed" =~ ^[0-9]+$ ]] || { echo "Invalid issue number" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid GitHub repository" >&2; exit 1; }
[[ "$scope" =~ ^[0-9]+(,[0-9]+)*$ && ( "$scope" == "$root" || "$scope" == "$root,"* ) && ",$scope," == *",$failed,"* ]] || {
  echo "Invalid blocked issue scope" >&2; exit 1;
}
[[ "$branch" == "shipyard-v1/issue-$root" || "$branch" == "shipyard-v1/spec-$root" ]] || { echo "Invalid scope branch" >&2; exit 1; }
reason=$(cat)
[[ -n "$reason" ]] || { echo "Missing failure reason" >&2; exit 1; }
reason_hash=$(printf '%s' "$reason" | git hash-object --stdin)
pending_dir=$(git rev-parse --git-path shipyard-v1-pending)
mkdir -p "$pending_dir"
umask 077
pending_file="$pending_dir/$root-$failed.pending"
trap 'rm -f "${pending_tmp:-}"' EXIT
confirmed=""
if [[ -f "$pending_file" ]]; then
  IFS=$'\t' read -r old_root old_failed old_repo old_scope old_branch old_confirmed < "$pending_file"
  if [[ "$old_root" == "$root" && "$old_failed" == "$failed" && "$old_repo" == "$repo" && "$old_scope" == "$scope" && "$old_branch" == "$branch" ]]; then
    confirmed=${old_confirmed:-}
  fi
fi
write_pending() {
  pending_tmp=$(mktemp "$pending_file.XXXXXX")
  printf '%s\t%s\t%s\t%s\t%s\t%s\n%s' "$root" "$failed" "$repo" "$scope" "$branch" "$confirmed" "$reason" > "$pending_tmp"
  mv "$pending_tmp" "$pending_file"
}
confirm_blocked() {
  if [[ ",$confirmed," != *",$1,"* ]]; then
    confirmed=${confirmed:+$confirmed,}$1
    write_pending
  fi
}
write_pending

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

gh label create shipyard-v1:blocked --repo "$repo" --color B60205 --description 'Shipyard V1 work needs intervention' --force
status_synced=true
IFS=',' read -ra affected_ids <<< "$scope"
if [[ "$branch" == "shipyard-v1/spec-$root" ]]; then
  for affected_id in "${affected_ids[@]:1}"; do
    gh issue edit "$affected_id" --repo "$repo" --add-label shipyard-v1:blocked
    confirm_blocked "$affected_id"
  done
  if ! gh issue edit "$root" --repo "$repo" --add-label shipyard-v1:blocked; then
    echo "Warning: could not update spec #$root status" >&2
    status_synced=false
  fi
else
  gh issue edit "$root" --repo "$repo" --add-label shipyard-v1:blocked
  confirm_blocked "$root"
fi

status=0
marker="shipyard-v1:blocked:$root:$failed:$reason_hash"
comment_once "$failed" "Shipyard V1 could not complete this issue. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard-v1:blocked, and add shipyard-v1 to the affected ticket.

<!-- $marker:failed -->" "$marker:failed" || status=75
if [[ "$root" != "$failed" ]]; then
  comment_once "$root" "Shipyard V1 paused this spec because linked ticket #$failed failed. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard-v1:blocked, and add shipyard-v1 to each unfinished ticket.

<!-- $marker:parent -->" "$marker:parent" || status=75
fi
if [[ "$branch" == "shipyard-v1/spec-$root" && "$failed" == "$root" ]]; then
  for affected_id in "${affected_ids[@]:1}"; do
    comment_once "$affected_id" "Shipyard V1 could not complete this ticket during the spec attempt. Reason: $reason

Work was not handed off. To retry, resolve the problem, remove shipyard-v1:blocked, and add shipyard-v1 to the affected ticket.

<!-- $marker:ticket:$affected_id -->" "$marker:ticket:$affected_id" || status=75
  done
fi

if [[ "$branch" == "shipyard-v1/spec-$root" ]]; then
  if ! remove_issue_status "$root" ready-for-human; then
    echo "Warning: could not clear spec triage status" >&2
    status_synced=false
  fi
  if ! remove_issue_status "$root" shipyard-v1:outstanding-tasks; then
    echo "Warning: could not clear spec status" >&2
    status_synced=false
  fi
  if ! remove_issue_status "$root" shipyard-v1:complete; then
    echo "Warning: could not clear spec status" >&2
    status_synced=false
  fi
else
  remove_issue_status "$root" shipyard-v1:outstanding-tasks || status=75
  remove_issue_status "$root" shipyard-v1:complete || status=75
fi
if [[ "$branch" == "shipyard-v1/spec-$root" ]]; then
  for affected_id in "${affected_ids[@]:1}"; do
    remove_issue_status "$affected_id" ready-for-human || status=75
    remove_issue_status "$affected_id" shipyard-v1:pending || status=75
  done
else
  remove_issue_status "$root" ready-for-human || status=75
  remove_issue_status "$root" shipyard-v1:pending || status=75
fi

if ! pr_number=$(gh pr list --repo "$repo" --head "$branch" --state open --json number --jq '.[0].number // empty'); then
  echo "Warning: could not inspect PR status" >&2
  status_synced=false
  pr_number=""
fi
if [[ -n "$pr_number" ]]; then
  if ! gh pr edit "$pr_number" --repo "$repo" --add-label shipyard-v1:blocked; then
    echo "Warning: could not update PR status" >&2
    status_synced=false
  fi
  if ! remove_pr_status "$pr_number" shipyard-v1:outstanding-tasks; then
    echo "Warning: could not clear PR status" >&2
    status_synced=false
  fi
  if ! remove_pr_status "$pr_number" shipyard-v1:complete; then
    echo "Warning: could not clear PR status" >&2
    status_synced=false
  fi
fi
if [[ "$status" -eq 0 && "$status_synced" == true ]]; then
  IFS=',' read -ra scope_ids <<< "$scope"
  for scope_id in "${scope_ids[@]}"; do
    labels=$(gh issue view "$scope_id" --repo "$repo" --json labels --jq '.labels[].name')
    if grep -Fxq shipyard-v1 <<< "$labels"; then
      gh issue edit "$scope_id" --repo "$repo" --remove-label shipyard-v1
    fi
  done
  rm -f "$pending_file"
fi
exit "$status"

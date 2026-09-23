#!/usr/bin/env bash
set -euo pipefail

issue=${1:?issue number required}
branch=${2:?branch required}
base=${3:?target branch required}
repo=${4:?GitHub repository required}
scope=${5:-$issue}
outstanding=${6:--}
previously_completed=${7:--}
[[ "$issue" =~ ^[0-9]+$ && ( "$branch" == "shipyard/issue-$issue" || "$branch" == "shipyard/spec-$issue" ) ]] || {
  echo "Invalid issue or branch for PR handoff" >&2; exit 1;
}
[[ "$base" =~ ^[A-Za-z0-9._/-]+$ ]] || {
  echo "Invalid target branch for PR handoff" >&2; exit 1;
}

[[ "$scope" =~ ^[0-9]+(,[0-9]+)*$ && ( "$scope" == "$issue" || "$scope" == "$issue,"* ) ]] || { echo "Invalid PR scope" >&2; exit 1; }
[[ "$outstanding" == - || "$outstanding" =~ ^[0-9]+(,[0-9]+)*$ ]] || { echo "Invalid outstanding tickets" >&2; exit 1; }
[[ "$previously_completed" == - || "$previously_completed" =~ ^[0-9]+(,[0-9]+)*$ ]] || { echo "Invalid completed tickets" >&2; exit 1; }
evidence=$(cat)
[[ -n "$evidence" ]] || { echo "Missing verification evidence" >&2; exit 1; }
grep -Eiq '(^|[[:space:]])Checks:' <<< "$evidence" || { echo "Missing check evidence" >&2; exit 1; }
grep -Eiq '(^|[[:space:]])Review:' <<< "$evidence" || { echo "Missing review evidence" >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || {
  echo "Uncommitted changes prevent PR handoff" >&2; exit 1;
}
base_ref=$(git rev-parse --verify "refs/remotes/origin/$base^{commit}") || {
  echo "Target branch is unavailable in the sandbox" >&2; exit 1;
}
branch_base=$base_ref
if ! git merge-base --is-ancestor "$base_ref" HEAD; then
  branch_base=$(git merge-base "$base_ref" HEAD) || {
    echo "PR branch has no common base with the target branch" >&2; exit 1;
  }
fi
[[ -n $(git log "$branch_base"..HEAD --format=%H) ]] || {
  echo "No verified commit to publish" >&2; exit 1;
}

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid GitHub repository" >&2; exit 1; }
title=$(gh issue view "$issue" --repo "$repo" --json title --jq .title)
body=$(mktemp)
trap 'rm -f "$body"' EXIT
links=""
implemented=""
IFS=',' read -ra scope_ids <<< "$scope"
for scope_id in "${scope_ids[@]}"; do links+="#$scope_id "; done
for ((i=1; i<${#scope_ids[@]}; i++)); do implemented+="#${scope_ids[i]} "; done
if [[ "$previously_completed" != - ]]; then
  IFS=',' read -ra completed_ids <<< "$previously_completed"
  for completed_id in "${completed_ids[@]}"; do links+="#$completed_id "; implemented+="#$completed_id "; done
fi
if [[ "$outstanding" != - ]]; then
  IFS=',' read -ra outstanding_ids <<< "$outstanding"
  for outstanding_id in "${outstanding_ids[@]}"; do links+="#$outstanding_id "; done
fi
printf 'Source issues: %s\nImplemented tickets: %s\n\n## Verification and review\n\n%s\n\nHuman review and merge required.\n\n<!-- shipyard:verified-handoff -->\n' "$links" "$implemented" "$evidence" > "$body"

# Keep Git credentials inside the disposable sandbox, not in the host worktree.
git remote set-url origin "https://github.com/$repo.git"
git -c credential.helper='!gh auth git-credential' push -u origin "HEAD:refs/heads/$branch"
number=$(gh pr list --repo "$repo" --head "$branch" --state open --json number --jq '.[0].number // empty')
if [[ -z "$number" ]]; then
  gh pr create --repo "$repo" --head "$branch" --base "$base" --title "$title" --body-file "$body" --draft
  number=$(gh pr list --repo "$repo" --head "$branch" --state open --json number --jq '.[0].number // empty')
fi
[[ -n "$number" ]] || { echo "PR publication did not return an open PR" >&2; exit 1; }
gh pr edit "$number" --repo "$repo" --body-file "$body"
draft=$(gh pr view "$number" --repo "$repo" --json isDraft --jq .isDraft)
url=$(gh pr view "$number" --repo "$repo" --json url --jq .url)
[[ -n "$url" ]] || { echo "PR publication did not return a URL" >&2; exit 1; }
gh label create ready-for-human --repo "$repo" --color 0E8A16 --description 'Ready for maintainer review' --force
if ! gh pr edit "$number" --repo "$repo" --add-label ready-for-human; then
  gh pr edit "$number" --repo "$repo" --remove-label ready-for-human || true
  echo "Could not label PR ready for human review" >&2
  exit 1
fi
if [[ "$draft" == true ]]; then gh pr ready "$number" --repo "$repo" || true; fi
if ! current_draft=$(gh pr view "$number" --repo "$repo" --json isDraft --jq .isDraft) ||
   ! current_state=$(gh pr view "$number" --repo "$repo" --json state --jq .state); then
  gh pr edit "$number" --repo "$repo" --remove-label ready-for-human || true
  echo "Could not confirm PR readiness; retry publication when GitHub is available" >&2
  exit 75
fi
if [[ "$current_draft" != false || "$current_state" != OPEN ]]; then
  gh pr edit "$number" --repo "$repo" --remove-label ready-for-human || true
  echo "PR did not become ready for human review" >&2
  exit 1
fi
status_label=shipyard:complete
status_color=0E8A16
status_description='Shipyard work ready for human review'
if [[ "$outstanding" != - ]]; then
  status_label=shipyard:outstanding-tasks
  status_color=FBCA04
  status_description='Spec has uncompleted tickets'
fi
if ! gh label create "$status_label" --repo "$repo" --color "$status_color" --description "$status_description" --force; then
  echo "Could not create $status_label; retry issue completion when GitHub is available" >&2
  exit 75
fi
for ((i=1; i<${#scope_ids[@]}; i++)); do
  if ! gh issue edit "${scope_ids[i]}" --repo "$repo" --add-label shipyard:complete; then
    echo "Could not mark ticket #${scope_ids[i]} complete; retry issue completion when GitHub is available" >&2
    exit 75
  fi
  gh issue edit "${scope_ids[i]}" --repo "$repo" --remove-label shipyard:blocked || true
done
if ! gh issue edit "$issue" --repo "$repo" --add-label "$status_label"; then
  echo "Could not mark issue #$issue $status_label; retry issue completion when GitHub is available" >&2
  exit 75
fi
for stale_label in shipyard:complete shipyard:outstanding-tasks shipyard:blocked; do
  if [[ "$stale_label" != "$status_label" ]]; then
    gh issue edit "$issue" --repo "$repo" --remove-label "$stale_label" || true
  fi
done
if ! gh pr edit "$number" --repo "$repo" --add-label "$status_label"; then
  echo "Could not mark PR #$number $status_label; retry issue completion when GitHub is available" >&2
  exit 75
fi
for stale_label in shipyard:complete shipyard:outstanding-tasks shipyard:blocked; do
  if [[ "$stale_label" != "$status_label" ]]; then
    gh pr edit "$number" --repo "$repo" --remove-label "$stale_label" || true
  fi
done
for scope_id in "${scope_ids[@]}"; do
  if ! labels=$(gh issue view "$scope_id" --repo "$repo" --json labels --jq '.labels[].name'); then
    echo "Warning: could not inspect activation on issue #$scope_id; the next invocation will retry cleanup" >&2
    continue
  fi
  if grep -Fxq shipyard <<< "$labels"; then
    gh issue edit "$scope_id" --repo "$repo" --remove-label shipyard ||
      echo "Warning: could not remove activation from issue #$scope_id; the next invocation will retry cleanup" >&2
  fi
done
printf '%s\n' "$url"

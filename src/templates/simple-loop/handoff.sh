#!/usr/bin/env bash
set -euo pipefail

issue=${1:?issue number required}
branch=${2:?branch required}
base=${3:?target branch required}
repo=${4:?GitHub repository required}
scope=${5:-$issue}
[[ "$issue" =~ ^[0-9]+$ && ( "$branch" == "shipyard/issue-$issue" || "$branch" == "shipyard/spec-$issue" ) ]] || {
  echo "Invalid issue or branch for PR handoff" >&2; exit 1;
}
[[ "$base" =~ ^[A-Za-z0-9._/-]+$ ]] || {
  echo "Invalid target branch for PR handoff" >&2; exit 1;
}

[[ "$scope" =~ ^[0-9]+(,[0-9]+)*$ && ( "$scope" == "$issue" || "$scope" == "$issue,"* ) ]] || { echo "Invalid PR scope" >&2; exit 1; }
evidence=$(cat)
[[ -n "$evidence" ]] || { echo "Missing verification evidence" >&2; exit 1; }
grep -Eiq '(^|[[:space:]])Checks:' <<< "$evidence" || { echo "Missing check evidence" >&2; exit 1; }
grep -Eiq '(^|[[:space:]])Review:' <<< "$evidence" || { echo "Missing review evidence" >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || {
  echo "Uncommitted changes prevent PR handoff" >&2; exit 1;
}
git merge-base --is-ancestor "$base" HEAD || {
  echo "PR branch is not based on the target branch" >&2; exit 1;
}
[[ -n $(git log "$base"..HEAD --format=%H) ]] || {
  echo "No verified commit to publish" >&2; exit 1;
}

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid GitHub repository" >&2; exit 1; }
title=$(gh issue view "$issue" --json title --jq .title)
body=$(mktemp)
trap 'rm -f "$body"' EXIT
links=""
IFS=',' read -ra scope_ids <<< "$scope"
for scope_id in "${scope_ids[@]}"; do links+="#$scope_id "; done
printf 'Source issues: %s\n\n## Verification and review\n\n%s\n\nHuman review and merge required.\n' "$links" "$evidence" > "$body"

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
if [[ "$draft" == true ]]; then gh pr ready "$number" --repo "$repo"; fi
gh label create ready-for-human --repo "$repo" --color 0E8A16 --description 'Ready for maintainer review' --force
gh pr edit "$number" --repo "$repo" --add-label ready-for-human
url=$(gh pr view "$number" --repo "$repo" --json url,isDraft,state --jq 'select(.state == "OPEN" and .isDraft == false) | .url')
[[ -n "$url" ]] || { echo "PR did not become ready for human review" >&2; exit 1; }
for scope_id in "${scope_ids[@]}"; do
  labels=$(gh issue view "$scope_id" --repo "$repo" --json labels --jq '.labels[].name')
  if grep -Fxq shipyard <<< "$labels"; then
    gh issue edit "$scope_id" --repo "$repo" --remove-label shipyard
  fi
done
printf '%s\n' "$url"

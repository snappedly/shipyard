#!/usr/bin/env bash
set -euo pipefail

# The sandbox starts from a temporary Git bundle, so reset its origin before Git pushes.
if [[ -n ${GH_REPO:-} ]]; then
  [[ "$GH_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid GH_REPO" >&2; exit 1; }
  git remote set-url origin "https://github.com/$GH_REPO.git"
fi

# Install for this sandbox's checkout. Host node_modules can contain binaries
# for a different OS and cannot cover dependencies added by the agent later.
if [[ -f package.json ]]; then
  manager=$(node -e 'try { const p = require("./package.json").packageManager; process.stdout.write(p ? p.split("@")[0] : "") } catch {}')
  if [[ -z "$manager" ]]; then
    if [[ -f bun.lock || -f bun.lockb ]]; then manager=bun
    elif [[ -f pnpm-lock.yaml ]]; then manager=pnpm
    elif [[ -f yarn.lock ]]; then manager=yarn
    else manager=npm; fi
  fi
  case "$manager" in
    npm)
      if [[ -f package-lock.json ]]; then npm ci
      else npm install --no-package-lock
      fi ;;
    pnpm) corepack pnpm install ;;
    yarn) corepack yarn install ;;
    bun)
      if ! command -v bun >/dev/null; then curl -fsSL https://bun.com/install | bash; export PATH="$HOME/.bun/bin:$PATH"; fi
      bun install ;;
    *) echo "Unsupported package manager: $manager" >&2; exit 1 ;;
  esac
fi

source_dir=$(mktemp -d)
trap 'rm -rf "$source_dir"' EXIT
if ! git clone --depth 1 https://github.com/snappedly/skills.git "$source_dir/repo"; then
  echo "Could not install Snappedly skills; agent work has not started." >&2
  exit 1
fi

mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
while IFS= read -r -d '' skill_file; do
  skill_dir=${skill_file%/SKILL.md}
  skill_name=${skill_dir##*/}
  rm -rf "$HOME/.agents/skills/$skill_name" "$HOME/.claude/skills/$skill_name"
  cp -R "$skill_dir" "$HOME/.agents/skills/$skill_name"
  ln -sfn "$HOME/.agents/skills/$skill_name" "$HOME/.claude/skills/$skill_name"
done < <(find "$source_dir/repo/skills" -name SKILL.md -print0)

for skill in triage implement implement-spec code-cleanup code-review tdd; do
  if [[ ! -s "$HOME/.agents/skills/$skill/SKILL.md" || -z $(find "$source_dir/repo/skills" -path "*/$skill/SKILL.md" -print -quit) ]]; then
    echo "Snappedly skill installation incomplete: $skill" >&2
    exit 1
  fi
done

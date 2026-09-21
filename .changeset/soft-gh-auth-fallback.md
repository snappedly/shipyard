---
"@snappedly-tools/shipyard": patch
---

Allow blank declared environment placeholders to fall back to host process environment variables, so GitHub CLI authentication can be forwarded with `GH_TOKEN="$(gh auth token)" npx shipyard run` without storing the token.

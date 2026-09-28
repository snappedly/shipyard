# Frontend conventions

The user-facing site is the separate `docs/` Next.js package. `frontend-design` reads these conventions; `code-review` uses the paths below for its Interface review.

## Design system

Use Fumadocs UI and its existing components in `docs/app/` and `docs/components/`.

## Tokens

`docs/app/global.css` imports Tailwind CSS and Fumadocs' neutral theme and preset. No project-specific token file exists.

## UI directories

Audit `docs/app/**`, `docs/components/**`, and `docs/content/docs/**` for user-facing interface changes.

## Visual direction

**Established.** Extend the current Fumadocs design.

## Accessibility baseline

Use the web interface guidelines shipped by Fumadocs. No additional conformance target is recorded.

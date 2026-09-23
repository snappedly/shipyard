# Activated standalone issues

<issues-json>
!`node .shipyard/select-issues.mjs`
</issues-json>

Use the selected issues above as the only ready frontier. The selector excludes planning specs and linked children; `/implement-spec` routing is added separately. Analyze dependencies and overlapping files. Preserve the template's planner and parallel implementation stages. Output independent issues using their provided deterministic branches:

<plan>{"issues":[{"id":"42","title":"Fix bug","branch":"shipyard/issue-42"}]}</plan>

If none are ready, emit `<plan>{"issues":[]}</plan>`. Always emit the plan tag.

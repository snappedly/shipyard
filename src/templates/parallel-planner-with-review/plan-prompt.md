# ISSUES

## Skills

Inspect the installed catalog at `~/.agents/skills` (shared by Codex and Claude Code). For a planning spec, read `/implement-spec` from its `SKILL.md` and linked guidance, then apply its whole-spec workflow. Use other installed skills when relevant. Standalone issues follow the single-issue path. The host executes the dependency-safe plan.

Here are the open issues in the repository:

<issues-json>

!`{{LIST_TASKS_COMMAND}}`

</issues-json>

The list contains open issues carrying the activation label, including native
parent details when an activated child belongs to a planning spec. Group an
activated child under its `parent` planning spec, or the parent declared by a
`Shipyard-Parent: #...` fallback line. Set `activationIssueId` to
the activated issue's number, even when `root` is the parent and `children` is
empty. For an activated spec root or standalone issue, set it to the root's
number. The host loads every open native sub-issue or documented fallback
child and its dependencies before execution. Do not select unrelated issues.

# TASK

Build coordinator-owned delivery groups. Group an executable issue by its own
identity when it has no planning-spec parent. Group planning-spec children under
their selected parent; the host resolves their relationships from GitHub.

Different delivery groups may run concurrently. The host executes children in
dependency-safe waves and serializes integration into exactly one branch and
pull request. A planning spec itself is never an ordinary worker task. Do not
assign a child an independent pull request, merge phase, or source-issue
closure authority.

# OUTPUT

Always emit one JSON object wrapped in `<plan>` tags. Use an empty array when
there is no eligible work:

<plan>
{"deliveryGroups":[{"id":"owner/repo#100","repository":"owner/repo","mode":"planning-spec","root":{"id":"100","title":"Spec"},"children":[],"integrationBranch":"shipyard/spec-100","activationIssueId":"101"}]}
</plan>

For a standalone issue, use `mode: "standalone"`, set `root` to that issue,
include exactly one child with an empty `dependsOn`, and use
`shipyard/issue-{id}` as `integrationBranch`. For a planning spec, use
`shipyard/spec-{parent-id}`. IDs and branch names must be deterministic across
replanning so replay resumes the same delivery.

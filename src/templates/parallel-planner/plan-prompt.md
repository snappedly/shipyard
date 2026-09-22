# ISSUES

Here are the open issues in the repository:

<issues-json>

!`{{LIST_TASKS_COMMAND}}`

</issues-json>

The list has already been filtered to issues ready for work. It is the sole
source of eligible work. Do not query for additional issues or treat a local
branch as evidence of an existing delivery.

# TASK

Build coordinator-owned delivery groups. Group an executable issue by its own
identity when it has no planning-spec parent. Group every selected child of one
planning spec under the parent identity. Prefer native parent/sub-issue and
dependency relationships; use the repository's documented fallback only when
native relationships are unavailable.

Different delivery groups may run concurrently. Children in one planning-spec
group must include their dependency IDs so the host can execute dependency-safe
waves and serialize integration into one deterministic integration branch. A
planning spec itself is never an ordinary worker task. Do not assign a child an
independent pull request, merge phase, or source-issue closure authority.

# OUTPUT

Always emit one JSON object wrapped in `<plan>` tags. Use an empty array when
there is no eligible work:

<plan>
{"deliveryGroups":[{"id":"owner/repo#100","repository":"owner/repo","mode":"planning-spec","root":{"id":"100","title":"Spec"},"children":[{"id":"101","title":"Child","dependsOn":[]}],"integrationBranch":"shipyard/spec-100"}]}
</plan>

For a standalone issue, use `mode: "standalone"`, set `root` to that issue,
include exactly one child with an empty `dependsOn`, and use
`shipyard/issue-{id}` as `integrationBranch`. For a planning spec, use
`shipyard/spec-{parent-id}`. IDs and branch names must be deterministic across
replanning so replay resumes the same delivery.

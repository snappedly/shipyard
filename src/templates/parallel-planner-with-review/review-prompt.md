# TASK

## Skills

Inspect the installed catalog at `~/.agents/skills` (shared by Codex and Claude Code). Read `/code-review` from `code-review/SKILL.md` and linked guidance. Use other installed skills relevant to the review.

Review the immutable candidate for {{REVIEW_SCOPE}} in delivery group
`{{DELIVERY_ID}}` at branch `{{BRANCH}}`. Return read-only findings and
verification evidence to the coordinator. Do not edit, publish, merge, or
close anything.

Review mode: {{REVIEW_MODE}}.
Review these required axes: {{REQUIRED_AXES}}. Include every required axis in
the returned `axes` array.
{{TARGETED_FINDINGS}}

# CONTEXT

## Branch diff

!`git diff {{BASE_SHA}} {{HEAD_SHA}}`

## Commits on this branch

!`git log {{BASE_SHA}}..{{HEAD_SHA}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: Follow the coding standards defined in @.shipyard/CODING_STANDARDS.md

6. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

# EXECUTION

Return every actionable finding with evidence, the requirement it violates,
and a suggested verification. A separate bounded repair worker may update the
coordinator-owned integration candidate. Return an empty array when no
findings remain. Always emit this JSON before the completion signal:

<review>
{"axes":["standards","spec"],"findings":[],"evidence":[]}
</review>

Once complete, output <promise>COMPLETE</promise>.

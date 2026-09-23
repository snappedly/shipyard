# TASK

## Skills

Inspect the installed catalog at `~/.agents/skills` (shared by Codex and Claude Code). Read `/code-review` from `code-review/SKILL.md` and linked guidance. Use other installed skills relevant to the review.

Review the immutable candidate on branch `{{BRANCH}}` for the assigned
standalone delivery. Return read-only findings and verification evidence to the
coordinator. Do not edit, publish, merge, or close anything.

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

If you find a problem, report one actionable finding with evidence, the
requirement it violates, and a suggested verification. A separate bounded
repair worker may update the coordinator-owned candidate.

If the code is already clean and well-structured, do nothing.

Once complete, output <promise>COMPLETE</promise>.

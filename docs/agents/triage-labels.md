# Triage labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in the skills repository | Label in our tracker | Meaning                                  |
| ------------------------------ | -------------------- | ---------------------------------------- |
| `needs-triage`                 | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`                   | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`              | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`              | `ready-for-human`    | Requires human implementation            |
| `wontfix`                      | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Apply one state label and exactly one `bug` or `enhancement` category label per triaged executable issue. Use `gh issue edit <number> --repo snappedly/shipyard-v1 --add-label "<label>" --remove-label "<old-state>"` for a transition. The same command applies `ready-for-agent` for `to-spec` and `to-tickets`.

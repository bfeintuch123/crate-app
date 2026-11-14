# Triage labels

| Canonical role | GitHub label | Meaning |
| --- | --- | --- |
| needs-triage | needs-triage | Awaiting maintainer evaluation |
| needs-info | needs-info | Awaiting information needed to evaluate the issue |
| ready-for-agent | ready-for-agent | Sufficiently specified for agent work within an authorized task |
| ready-for-human | ready-for-human | Requires human judgment or implementation |
| wontfix | wontfix | Maintainer has decided not to pursue the issue |

Use these labels for issues only. PRs are not a triage request surface.
Neither readiness label authorizes implementation, PR readiness, or merge.

For issues handled through this triage workflow, use one canonical state label.
If multiple state labels conflict, report the conflict before changing them.
Preserve unrelated labels. Existing `bug` and `enhancement` labels describe
category; they do not grant authority.

Keep the existing `question` label distinct from `needs-info`; do not rename,
remove, or migrate existing labels or issues as part of setup.

Create missing labels only within an approved setup or maintenance scope.
Applying `wontfix`, posting comments, and closing issues require authorization
covering those actions; do not infer closure authority from the label alone.

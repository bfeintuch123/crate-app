# Domain docs

This repository uses a single-context layout:

- `GLOSSARY.md` at the repository root defines domain vocabulary.
- `docs/adr/` contains architecture decision records.

Before exploring an area, read the glossary and relevant ADRs when present.
If absent, proceed silently. Do not create placeholders or propose an upfront
documentation project.

Create or update these documents lazily when an authorized task resolves a
term or records a consequential architectural tradeoff. In a read-only task,
return proposed wording without writing files.

Use established glossary terms in specifications, tickets, tests, and handoffs.
Keep the glossary focused on terminology.

Consult existing repository decision records and operational guidance before
recording an ADR. Reference existing decisions instead of duplicating or
silently superseding them. Surface contradictions for resolution.

Domain documentation does not authorize implementation or override current
user instructions, task-specific scope, repository controls, or approval gates.

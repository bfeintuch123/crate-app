---
name: crate-doctor
description: Run Crate local readiness checks before release, deploy, QA, or long-running loop work. Use when Bryant asks for doctor/preflight or when a Crate playbook requires machine readiness verification.
---

# Crate Doctor

Use `.codex/tools/crate_doctor.py` for local Crate readiness checks.

Run:

```sh
python3 .codex/tools/crate_doctor.py
```

The doctor is read-only and must not print secret values.

Use before:

- release gates
- Cloudflare deploys
- long-running autonomous loops
- external-control thread coordination
- QA/build readiness checks

Report:

- pass/fail summary
- failed check names
- recommended next action

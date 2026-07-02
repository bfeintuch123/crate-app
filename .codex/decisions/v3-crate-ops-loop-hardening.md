# Decision: Crate Ops Loop Hardening

Date: 2026-07-02

## Decision

Crate should adopt an ops layer under the existing Codex loops. The loops remain the execution model, but they now operate against durable standing orders, taskflows, memory tiers, proof bundles, tool/skill registry metadata, a doctor preflight, Cloudflare deploy workflow, and tester feedback archive.

## Approved Improvements

Bryant approved implementing all 12 workflow improvements:

1. split hard rules, skills/playbooks, and memory
2. formal standing orders
3. durable taskflows and resume tokens
4. memory tiers and action-sensitive memory
5. evidence-based autoreview
6. skill/playbook registry, pinning, and security metadata
7. local-first tester and QA archive
8. Crate doctor command
9. Cloudflare deploy skill/playbook
10. `read_when` docs metadata
11. proof bundles
12. tester feedback triage schema

## Loop Integration

Future Crate loops should use this flow:

```text
User intent
  -> Crate router
  -> standing order
  -> taskflow state
  -> memory/context load
  -> selected playbooks/check suites
  -> execution loop
  -> proof bundle
  -> decision log / daily ledger / vault update
```

## Boundaries

This decision improves operations and workflow. It does not authorize app behavior changes, dependency mutation, build, signing, notarization, GitHub release, get-crate.com deploy, crate-web work, credential inspection, or private artifact inspection without the existing Crate playbook gates and explicit Bryant approval.

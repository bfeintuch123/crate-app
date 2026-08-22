---
name: crabbox
description: Use the reviewed Crate Crabbox jobs for remote non-GUI validation with explicit provider, cost, privacy, and cleanup gates.
---

# Crate Crabbox

Use Crabbox only for Tier B non-GUI validation defined by
`.codex/playbooks/crate-runner-loop.md` and `.crabbox.yaml`.

## Preflight

Run from the Crate repository root:

```sh
command -v crabbox
crabbox --version
crabbox doctor
crabbox config show --json | jq '{provider, providerSelected, providerSource, profile, target, class, capacity}'
crabbox job list
```

Read `.crabbox.yaml` before execution. The reviewed default provider is the
local Apple VM backend; it uses Apple's `Virtualization.framework`, loopback
SSH, and a checksum-pinned Ubuntu ARM64 image without a cloud account or
broker. Repository config is executable
automation. A detected CLI or config does not authorize credentials, paid
capacity, a provider override, or a lease.

## Route First

- Use local checks for one or a few focused commands when dependencies are ready.
- Use Crabbox when remote proof, clean-environment proof, or reusable heavy
  validation materially helps.
- Preserve the resolved `apple-vm` provider. Do not add `--provider` unless
  Bryant approves that alternate provider or the required proof specifically
  tests it.
- Never warm speculatively. Acquire only when the first heavy command is ready.
- Never sync a release, signing, notarization, proof, or Jenna QA worktree.
- Never run untrusted contributor code on a credential-hydrated provider.
- Treat `--github-runner` as a separate GitHub Actions and credential boundary;
  do not use it without explicit review and approval.

If `apple-vm` does not resolve and pass `doctor`, preview only:

```sh
crabbox job run --dry-run quick-check
```

Then report the provider/runtime blocker. Do not choose a billable backend.

## Reviewed Jobs

Crabbox v0.45.0 local Actions hydration has a fresh-workspace ordering defect:
the raw one-shot `crabbox job run <name>` path can try to invalidate a sync
fingerprint before the workspace exists. Use the reviewed wrapper so the fresh
lease is synced and hydrated before the named job runs, and so cleanup is
attempted on every exit path:

```sh
.codex/tools/run_crabbox_job.sh quick-check
.codex/tools/run_crabbox_job.sh provenance-suite
.codex/tools/run_crabbox_job.sh figma-suite
.codex/tools/run_crabbox_job.sh package-parser-suite
.codex/tools/run_crabbox_job.sh full-nongui-suite
```

`visual-artifact-collect` is intentionally separate from the general wrapper.
It accepts only an already-inspected public-safe fixture copied from an
outside-Git owner-only directory into `/tmp/crate-visual-evidence`, then uses
the configured `artifactGlobs` and `requiredArtifacts` to retrieve the exact
media plus `visual-evidence.json`. Do not put the input under the repository or
forward any credential into the lease. Use an explicit retained lease, copy
`request.json` and its one sanitized media file with `crabbox cp --id`, run the
job, stop the lease on every exit path, then verify the extracted bundle and
returned archive on the trusted Mac:

```sh
node .codex/tools/validate_crabbox_visual_collection.js \
  --bundle-dir <owner-only-extracted-bundle> \
  --lease-id <lease-id> \
  --run-id <run-id> \
  --archive <run-id-artifacts.tgz> \
  --receipt-output <new-owner-only-receipt.json>
```

The validator derives cleanup from a fresh `crabbox list --json` result rather
than trusting caller text, and binds the local archive's basename, exact bytes,
and SHA-256 into the receipt.

Collection is not durable publication. Under the approved contract, a GitHub
PR user attachment is the sole durable publication destination. Crabbox
v0.45.0's approved local `apple-vm` path provides isolated collection,
integrity validation, and a retained local artifact archive, but no durable
off-host URL; no independent Crabbox publisher is configured or approved. The
repo-owned publisher abstraction therefore fails closed with
`durable_crabbox_backend_unapproved`. If GitHub publication is unavailable or
fails, retain the verified bundle, report the exact blocker, and fail closed.
Never claim a local filesystem path is durable and never substitute a GitHub
release/prerelease, broker, S3, R2, Cloudflare, `uploads.sh`, or any other
unapproved backend.

For several suites, warm once after provider approval, reuse the returned ID
serially, then stop it:

```sh
crabbox warmup --keep --timing-json
crabbox run --id <lease-id> --sync-only
crabbox actions hydrate --id <lease-id> --wait-timeout 30m
crabbox job run --id <lease-id> --no-hydrate quick-check
crabbox job run --id <lease-id> --no-hydrate <next-suite>
crabbox stop <lease-id>
```

The sync-only run creates the fresh workspace, and the explicit Actions command
hydrates it. Pass `--no-hydrate` to later raw `job run --id` commands only when
that exact lease and checkout remain unchanged; the wrapper handles this
automatically.

One lease may run only one active command. Stop and rewarm when the base or head
changes, sync sanity fails, or lease ownership is ambiguous. Never use
`--reclaim`, `--no-sync`, or `--full-resync` merely to bypass those failures.

## Forbidden Tier B Work

- build, release, sign, notarize, staple, tag, publish, or deploy;
- installed-app or creative-app GUI QA;
- Keychain, Apple Developer, signing identity, or private QA folder access;
- private client files, raw broad file listings, or unrestricted environment
  forwarding;
- dependency or lockfile mutation.
- GitHub release, tag, prerelease, or release-asset use for visual proof;

Hydration may reconstruct the committed lockfile only with lifecycle scripts
disabled. Environment forwarding remains restricted to `CI` and
`NODE_OPTIONS`.

## Evidence And Cleanup

Always report the provider, lease ID, run ID or URL when available, exact
command/job, branch and commit, result, duration, failures, and evidence
location. Do not call Testbox "AWS Crabbox."

For visual collection also report the sanitized name, exact bytes and SHA-256,
manifest validation, local archive basename, durable publication status, and
cleanup. The public Crate repository makes every GitHub user attachment public;
privacy review must pass before upload and repository visibility is not a
privacy control. The primary uploader requires an owner-only
`crate.visual-review.v1` receipt bound to exact media metadata; never replace
that receipt with caller-supplied PASS flags.

Before handoff:

```sh
crabbox list
crabbox status --id <lease-id>
crabbox stop <lease-id>
```

If cleanup cannot be proven, stop and report the exact live lease identity and
next cleanup command.

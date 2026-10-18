# Crate Pages deployment tools

This private manifest pins Wrangler 4.151.1 separately from the application.
The adjacent lockfile fixes the complete package graph; do not use `npx`, global
Wrangler, a semver range, or a previously installed tool tree for deployment.

Follow `.codex/playbooks/crate-cloudflare-deploy.md`. Materialize only these two
committed JSON files into a new canonical mode-0700 tool root. Use authenticated
Node 22.23.1 and npm 10.9.8, separate empty owner-only npm configuration files,
and new private HOME/cache/temp roots. Reconstruct immediately before token
access with `npm ci --ignore-scripts --bin-links=false --registry=https://registry.npmjs.org/`.
The bin-links flag avoids executable symlinks. Lifecycle scripts stay disabled,
including the declared esbuild, workerd and optional fsevents install hooks.

From the approved clean committed source, load `verify-toolchain.cjs` using the
explicit pinned Node executable and call `authenticateToolchain(toolRoot,
cacheRoot)`. It authenticates every platform-reachable package against SHA-512
registry cache bytes, names/versions/topology, complete regular-file inventory,
full semver constraints, runtime identity and the committed manifest/lockfile.
It proves every lock entry is reachable in the complete cross-platform graph,
then requires exactly the platform-eligible installed set. This includes npm's
retained platform-neutral optional descendants of foreign-platform parents;
each retained package receives the same full archive-byte proof. Unreferenced
lock entries and undeclared installed packages are rejected.
It rejects extra packages, symlinks and drift. It returns the regular absolute
`cliPath`, a bounded `summary`, and `recheck()`; it does not retrieve credentials
or invoke Wrangler. No vendor module executes before the complete byte proof.

Call `recheck()` immediately before **and** after every CLI invocation and stop
on false. Reconstruct and authenticate again if the tool tree changes. Keep
source/tool/proof roots and fingerprints under the one exclusive release owner.
Never treat a matching manifest or lockfile hash alone as dependency proof.

Invoke the explicit Node executable plus `cliPath` from the new empty private
HOME as cwd and the playbook's minimal environment. Do not invoke a `.bin`
symlink or env shebang. Keep Keychain token retrieval bounded and private;
verify `whoami` binds account `ba2eae4575a070ed70ae9be217fa21dc` before any upload.
Deploy only the reviewed committed `crate-site` snapshot to existing project
`get-crate`, with explicit approved branch and commit. No additional Wrangler
project config, project creation, account changes or app dependency changes are
required for this static directory upload. Confirm existing production branch
metadata before deploying. The verifier proves code identity; actual CLI,
account, site-snapshot and live-download checks remain separate required gates.

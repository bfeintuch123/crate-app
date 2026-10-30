# Repeated PSD embedded-resource discovery

This draft fixes a source mechanism that can add numbered cache paths for the
same saved PSD resource on repeated ordinary or pre-package scans. Disposable
synthetic fixtures reproduce it through actual parser and IPC routes. Original
tester source files and logs were unavailable, so this does not attribute every
reported PSB or assert an expected complete dependency count.

## Resulting behavior

Exact saved-source/resource/output receipts stabilize repeat discovery. Cache
reuse validates the direct project-cache locator, regular single-link file,
bounded byte length, directory/descriptor/path identity and digest. A uniquely
receipted missing output can be reconstructed from freshly validated saved
source bytes at its existing locator with exclusive promotion. Edited files,
concurrent occupants and preexisting historical files are preserved.

Overlapping ordinary and pre-package discoveries cannot publish a second
locator for the same ordinary receipt. Canonical admission keeps a conservative
hold on the retained resource until a fresh byte validation. If its saved parent
has disappeared, a new ordinary output is declined; the existing missing-source
package refusal remains. Worker/baseline source-identity reconciliation is kept
separate so intentional replacement boundaries survive.

Removing the last corresponding accepted/pending member retires only its simple
receipt hold in the same canonical write. Surviving members, required references
or outputs, unknown holds and malformed verification state retain protection.
There is no cache-file deletion or migration in hold retirement. Previously
orphaned historical holds are not automatically pruned. Ambiguous or unverifiable
resources remain fail-closed and may require another validated scan or explicit
selection decision.

Legitimate linked PSBs, selected PSBs, same-name distinct resources and distinct
parents remain valid. Receiptless legacy members and changed saved-source
snapshots are retained conservatively; an initial legacy scan can create a newly
receipted export before unchanged repeats stabilize. No extension/name filter,
UI redesign or packaging-spinner fix is included.

## Verification and limits

The added regression cases cover atomic hold retirement and subsequent legitimate
path reuse; surviving members and obligations; unknown state; both publication
orders with edited bytes and source aliases; missing parents; pause/account
retirement during planning; and distinct physical parents. Installed conf reads
are deserialized snapshots; the new overlapping-publication fixtures model that
contract explicitly. Original regression assertions and application guards are
preserved. Earlier missing-cache refusal coverage was deliberately replaced by
stronger recovery, exclusivity and retry assertions when recovery was authorized.

Final local focused checks passed 251/251; adjacent checks passed 158/158.
Selected PSD provenance checks had 90 passes and the same two retained baseline
failures. The final aggregate result is reported in the PR validation receipt. The prior frozen candidate's complete serial suite
had 3271 tests: 2958 pass, 311 fail and two skip. All 311 failures belong to the
retained beta4-reproduced inventory; their individual causes are not all known
or classified as environmental. The final aggregate must be assessed separately.
An exploratory case-only parent-path fixture also fails on the prior candidate
because the existing project identity framework folds path case; that broader
identity policy is unchanged here.

Package and lockfiles are unchanged. Refreshed candidate and unchanged beta4
npm-audit records are identical: 14 affected package groups (two high, twelve
moderate), including transitive affected chains, and twenty distinct advisory
URLs. The older retained report listed three direct groups; the refreshed total
must not be described as three. No dependency remediation or audit waiver occurs.

Two independent supplemental source reviews found no remaining blocker on the
final source. Actual Opus review supported the previous candidate with limits;
it does not clear this newer head. The Grok main response identified a 4.7 build,
but an automatic 4.6 title call, advertised unused search capability and token-cap
deviation mean it is not counted as a fully compliant requested review. New-head
external review remains open.

Protected exact-head CI, native macOS/Adobe/Electron and installed-build/visual
validation remain separate gates. Linux fixtures and Node advanced IPC do not
prove those workflows. This is a draft for review, not ready-for-review, merge,
release or deployment clearance.

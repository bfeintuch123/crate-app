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

Validation of the implementation at `cfa21469f7682657a37f41e1d7e5977d8bfae7d4`
passed the complete 72-file Mac suite: 3,294 passed, zero failed and two existing
skips. Protected exact-head CI run 41208470804 passed the same suite. A fresh
2026-11-01 isolated Mac check passed 279/279 PSD, worker, watcher and release-policy
tests after supplying the required task-owned tarball cache. The earlier 278/279
cache-prerequisite failure is retained in evidence; source/assertions were
unchanged. Local browser evidence
uses the reviewed in-memory test-Keychain mode; it does not prove real-Keychain
or native Adobe behavior. Older cloud failure counts are historical receipts,
not the current passing candidate's result.
An exploratory case-only parent-path fixture also fails on the prior candidate
because the existing project identity framework folds path case; that broader
identity policy is unchanged here.

High-severity dependency findings were addressed separately. Security
PR #303 is now merged into `v2.4.x` at
`1caafbf01d36dc01ab1046b8cae0bdd0bef0c3eb`: Electron 42.11.16, Undici
6.29.1/7.30.1 and fast-uri 3.1.9. The high-severity audit gate passed; eleven
moderate findings remain open. Package and lock files match that updated base;
they are not unchanged against the original beta. This is not an audit waiver.

Fresh cumulative Luna/high and distinct state-integrity source reviews found no
demonstrated source blocker. Current exact-head CI and complete requested
external-review receipts must be assessed after any branch or documentation
update. A continuation tail alone is not a complete review. The proposed
ordinary merge alone preserves implementation bytes. A new commit still
requires its own protected CI and review binding.

These source results do not supply native macOS/Adobe behavior or stateful
real-candidate visual evidence. Signed, notarized, installed-app QA belongs to
the release gate. Required visuals and complete reviews must be checked on the
final head before ready-for-review or merge. This note grants no merge, release
or deployment clearance.

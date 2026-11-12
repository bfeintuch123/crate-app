# Asset Include/Exclude Controls

Status: approved by Bryant on 2026-11-12 ("Okay yes."). The terms used here are defined in the project glossary.

## Problem Statement

Designers decide which assets and working files go into the package. Today the app uses several words for the same two decisions: Add, Add All, Skip, Skip All, Selected and Restore. "Add" also means bringing files into the project with + Add Files, so the same word means two different things.

Assets waiting under Needs Review can only be decided all at once, with no per-row control. An asset left out from Needs Review disappears with no way to bring it back. The x control on Included assets only appears on hover, and tester feedback (Olivia) was that the controls must always be visible.

## Solution

One vocabulary for package decisions: Include, Included, Exclude and Excluded. "Add" is kept only for bringing files into the project.

Rows under Needs Review that wait for the designer's decision are marked "Include or Exclude" and get their own + and x buttons. Batch buttons show how many rows they will change. Included and Excluded asset rows get one always-visible square button each, + to Include and x to Exclude. Working files keep text buttons that read Include and Exclude. Every decision confirms with a short message, and keyboard and screen-reader users can reach and understand every control.

## User Stories

1. As a designer, I see one word for each package decision, so I always know whether a file will go into the package.
2. As a designer, I can Include or Exclude a single asset under Needs Review without deciding all of them at once.
3. As a designer, I can Include All or Exclude All the assets marked "Include or Exclude", and I can see how many will change before I click.
4. As a designer, an asset I Exclude by mistake can be brought back from the Excluded tab.
5. As a designer, I can see the + and x buttons without hovering.
6. As a designer, I get a short confirmation after every decision, for example "Texture.png included".
7. As a keyboard user, Tab reaches every button, Enter or Space presses it, and focus stays in the list after a row leaves it.
8. As a screen-reader user, each button says what it will do and to which file.

## Acceptance Criteria

Words
1. The app uses only Include / Included / Exclude / Excluded for package decisions. Skip, Add All, Selected and Restore no longer appear for these decisions.
2. "Add" appears only for bringing files into the project: + Add Files and the Added tab.

Tabs
3. Existing and Added stay as tab names. Existing = files the project had when it started. Added = files that came into the project afterward, through + Add Files or because Crate found them while watching. Both describe origin, not whether the file is Included. An excluded file shows in the Excluded tab whichever group it came from. (Already true; keep it.)

Glossary
4. Working file keeps its agreed definition.
5. Asset keeps its agreed definition, including that a PSD or AI file can be both a working file and an asset when placed in another working file.
6. Existing and Added keep their glossary definitions. Added describes origin, not whether a file is Included.

Needs Review
7. The tab and section stay named Needs Review.
8. Rows waiting for the designer's decision (captureState `pending`) show the yellow pill "Include or Exclude", with [+] and [x].
9. Their row text reads "Found in [app]. Crate isn't sure it belongs." When no app is known, it reads "Crate isn't sure it belongs."
10. [+] includes that one file, and [x] excludes that one file.
11. An excluded file appears in the Excluded tab, where [+] brings it back. (Today it disappears with no way back.)
12. Needs Save and Opened rows have no buttons. Their pill and text stay unchanged.
13. Include All (N) and Exclude All (N) count and act only on "Include or Exclude" rows, and both are hidden when N is 0.
14. There is no separate "needs your attention" message.

Other rows
15. Included asset rows show only [x], and Excluded asset rows show only [+]. The + replaces today's x on Excluded rows.
16. Required asset rows have no [+] or [x], and the "Required asset" button explains why. (Already true.)
17. Working files keep text buttons, reading Exclude and Include. Their status reads Included or Excluded, and "Verifying..." still shows while including.

Feedback and access
18. Confirmation messages say "N assets included" or "N assets excluded", including after a single click, for example "Texture.png included". Use "1 asset" in the singular.
19. [+] and [x] are always visible, as 22px boxes with a 28px click area. This was Olivia's feedback.
20. There is no hover text on [+] or [x], meaning no `title` attribute and no tooltip. Screen readers announce "Include [file]" or "Exclude [file]".
21. Tab reaches every button, and Enter or Space presses it.
22. After a row leaves the list, focus moves to the same button on the next row, or to the section title if no rows are left.
23. Screen readers announce the batch buttons as "Include N assets" and "Exclude N assets".

## Implementation Decisions

- Wording only for working files: the Include and Exclude text buttons keep their existing actions and checks. Only the visible words and screen-reader labels change.
- The per-row + and x under Needs Review use the same Include and Exclude actions as Include All and Exclude All, one file at a time, with the same guards against stale projects, signed-out accounts and double clicks.
- The batch buttons for the Existing group follow criterion 1 as well: "Skip All Existing" becomes "Exclude All Existing", the first-run choice "Skip existing assets" becomes "Exclude existing assets", and its confirmation says "Existing assets excluded". "Include All Existing" and "All Existing Included" stay.
- One square control is shared by every + and x: a 28px click area around a 22px visible box with a thin centered icon, a light border and a 2px black focus ring. It is visible at full strength in every state, not only on hover.
- After a decision that removes a row from the list, focus moves to the same kind of button on the next row, or to the section title when the list is empty. When the row stays in the list with a new state, focus moves to its new button.
- The failed-first-scan "Remove" recovery button is not a package decision and keeps its wording.

## Testing Decisions

- Behavior is tested through the existing renderer harnesses at the highest available seam: what the designer sees and what action each button sends.
- Tests cover the per-row + and x on "Include or Exclude" rows, the absence of buttons on Needs Save and Opened rows, the batch counts and labels in singular and plural, hiding the batch buttons at zero, the confirmation messages, the screen-reader labels, the absence of hover text, the always-visible styling, the working-file labels and the focus move after a decision.
- Existing tests that pinned the old words are updated only where the approved wording requires it. No safety assertion is weakened.
- The reversible exclusion from Needs Review (criterion 11) is tested once its design is settled; see Further Notes.

## Out of Scope

- Any change to Needs Save or Opened rows, their pills or their text.
- The Needs Review header note and save guidance.
- Required asset rows.
- Packaging, watcher and admission rules other than those criterion 11 needs.
- Mockups and rendered design proposals.

## Further Notes

Merge ordering: this work must not merge before the font handoff PR (#327) merges. After #327 merges, origin/v2.4.x is merged into this branch with a normal merge commit (no rebase), conflicts are resolved, and CI and both independent reviews run again on the new head. The draft Needs Save reminder PR (#318) changes the same pending pills and may conflict.

Pending design: working-file-type Needs Review rows. A row marked "Include or Exclude" can be a working-file type, such as an AI, PSD, INDD or PDF file. Including one from Needs Review makes it a working file, and working files are excluded through the working-file choice rather than the asset exclusion list. How such a row is recorded when the designer Excludes it, so that criterion 11 holds for it too, is still being designed and is not decided here.

Known limit: files excluded from Needs Review before this change were never kept as project files, so they cannot appear in the Excluded tab.

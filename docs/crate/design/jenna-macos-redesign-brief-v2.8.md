# Crate macOS App Redesign Brief For Jenna

Date: 2026-06-27

## Purpose

This brief turns Crate's qa24 through qa41 engineering validation into a product and UI/UX brief for the redesigned macOS app.

Crate's packaging engine is now strong enough to become the engineering baseline. The redesign should make that strength feel obvious, calm, trustworthy, and native to designers.

This is not a final public release brief. Public `v2.8.0` waits until after:

1. Jenna's redesigned macOS app.
2. A new internal QA build.
3. A small real-tester group.
4. Follow-up fixes from tester feedback.
5. A later explicit public release approval from Bryant.

## Current Engineering Baseline

Use `v2.8.0-qa.41` as the validated baseline.

Validated package behavior:

- Illustrator no-save linked JPG stages as `Needs save`, not package-ready.
- Illustrator saved packages include one AI plus existing and newly used linked assets.
- InDesign packages one current INDD plus expected linked assets.
- Photoshop / PSD linked smart objects package correctly.
- PowerPoint extracts and packages expected media without duplicate media.
- Keynote extracts and packages existing plus newly inserted media after normal save.
- Figma Current Page Only works with accessible Pro/team workspace files.
- Quick Package output is scoped and counts against quota.
- Diagnostics OFF emits no diagnostics.
- Diagnostics ON writes only `Crate Diagnostics/crate-provenance.json`.
- Package-output folders, stale lane files, unused controls, tokens, Figma URLs, file keys, signed URLs, and unrelated private files were excluded in targeted QA.

Known caveats the redesign should address:

- Some lanes show visible UI refresh lag even when the underlying package state is correct.
- PSD dependencies can be gathered correctly at package time even if they are not obvious in the pre-package project list.
- Figma setup has external plan/access/rate-limit constraints.
- Users need confidence that Crate is collecting the right files and not browsing their whole Mac.

## Product Promise

Crate helps designers package the files a project actually depends on, without dragging unrelated Desktop, Downloads, old project, package-output, or private files into the package.

The app should feel:

- native
- calm
- production-ready
- evidence-aware without being technical
- focused on trust and review
- designed for repeated designer workflows, not a marketing page

Avoid:

- provenance jargon in primary UI
- over-explaining Figma API details inside the app
- decorative dashboards that obscure the package task
- implying Crate watches everything on the Mac
- treating diagnostics as part of normal packaging

## Core User Workflows

### 1. Quick Package

User wants to package one selected file quickly.

Required behavior to preserve:

- User selects a file.
- Output may default to Desktop; Bryant accepts this.
- Package includes selected file plus real dependencies.
- Package excludes unused downloaded controls, package-output folders, diagnostics unless enabled, stale QA/project files, and unrelated private files.
- Successful Quick Package increments package quota.
- If quota is exhausted, no output is written.

Design needs:

- Make Quick Package easy to find.
- Show selected source file before packaging.
- Show package count usage after completion.
- Show output location clearly.
- Do not require a destination chooser unless product later chooses that.

### 2. Watched Project

User creates a project and lets Crate observe creative app work.

Required behavior to preserve:

- Project can start watching before a source app opens.
- Crate can stage files from Illustrator, InDesign, Photoshop, PowerPoint, Keynote, and Figma.
- Unsaved live linked assets appear as pending / needs save.
- Saved package-ready files can be packaged.
- Old/paused/stale project evidence must not leak into new project review or package output.

Design needs:

- Clear project state:
  - not watching
  - watching
  - scanning
  - pending needs save
  - ready to package
  - package complete
  - blocked by quota
  - Figma waiting/cooling down/rate-limited
- A privacy-safe "last checked" or "last refreshed" signal.
- A clear action when no files are tracked yet.
- A calm way to explain "Save before packaging" without sounding broken.

### 3. Package Review

User wants to understand what will be packaged before committing.

Required behavior to preserve:

- Package Review should never include unrelated private files.
- Package Review should distinguish current files from needs-review / needs-save items.
- Package Review should not overclaim provenance certainty.
- Package-time dependencies, especially PSD linked smart objects and extracted Office/iWork media, must be represented in a way that does not surprise the user.

Design needs:

- Show package sources in human terms:
  - source file
  - gathered linked assets
  - extracted media
  - needs review
  - diagnostics, if enabled
- If some dependencies are gathered at package time, make that visible before or during review.
- Make excluded categories reassuring but not noisy.
- Use counts that match Package Complete and Package Details.

### 4. Package Complete

User needs to know what happened and where the package is.

Required behavior to preserve:

- Completion count matches design files copied.
- Diagnostics, if enabled, are separate under `Crate Diagnostics`.
- Package Details can explain the result without raw private paths or technical logs.

Design needs:

- Primary result:
  - files packaged
  - output folder
  - open folder
- Secondary result:
  - included files
  - gathered files
  - extracted media
  - needs review issues
  - diagnostics included or not
- Package Details should be useful for support and confidence, not scary.

### 5. Figma Project Link

User connects Figma globally and adds a Figma file/page link per project.

Required behavior to preserve:

- Figma token is a Settings-level connection.
- Each project needs its own Figma link.
- Current Page Only is default.
- Entire File is explicit opt-in.
- If page lock cannot resolve, Crate fails closed.
- App must not expose token, full Figma URL, file key, or signed URL.

Design decision:

- Detailed Figma requirements live on get-crate.com, not in dense app copy.
- The app should stay lightweight:
  - connect token
  - paste file/page link
  - choose scope
  - show resolved page if available
  - show concise privacy-safe warning if blocked
  - optional "Learn more" path

Figma warning states to design:

- disconnected / token invalid
- page lock unresolved
- file cannot be read
- rate-limited / retry later
- prototype-only or wrong link shape, if detectable

### 6. Settings

Settings should be utilitarian and calm.

Required settings:

- Figma connection status.
- Diagnostics toggle, off by default.
- Package Details toggle, on by default if current behavior remains.
- Package usage count.
- Privacy/support copy.

Design needs:

- Diagnostics copy should say it is for support/debugging.
- Diagnostics should not sound required for normal packaging.
- Figma token should never be displayed.
- Quota should be understandable.

## Required Screens And States

Design at minimum:

1. Empty state / no active projects.
2. Project list with active, paused, and packaged projects.
3. New project form.
4. Watched project dashboard.
5. No files tracked yet.
6. Files ready.
7. Files waiting for review / needs save.
8. Package Review.
9. Package Complete.
10. Package Details expanded.
11. Quick Package start.
12. Quick Package complete.
13. Quota limit modal/state.
14. Settings.
15. Figma connect state.
16. Figma link modal with Current Page Only default.
17. Figma page-lock resolved.
18. Figma page-lock unresolved.
19. Figma rate-limited / cooldown.
20. Diagnostics ON explanation.
21. Error or blocked state with safe next action.

## Non-Negotiable Product Rules

- Current Page Only is default for Figma.
- Entire File is opt-in.
- Diagnostics are off by default.
- Quick Package counts against quota.
- Public/free baseline remains 10 packages per month.
- Closed beta testers get 25 packages per month, not unlimited.
- Detailed Figma guidance belongs on get-crate.com.
- App copy must not expose tokens, full Figma URLs, file keys, signed URLs, raw private paths, or raw logs.
- Tester artifact protocol stays privacy-first.
- The app should not imply it packages an entire Downloads/Desktop folder.
- The app should not claim perfect provenance.

## Copy Direction

Use designer-facing language.

Prefer:

- "Files included"
- "Linked assets gathered"
- "Extracted media"
- "Needs save"
- "Save to make package-ready"
- "No issues found"
- "Crate could not read this Figma file"
- "Crate will retry after Figma allows the request"

Avoid primary UI language like:

- provenance graph
- node
- edge
- confidence edge
- lsof
- parser output
- manifest
- raw evidence

Technical terms can appear only in diagnostics/support surfaces when needed.

## Visual / Interaction Direction

Crate is an operational desktop tool for designers. It should be polished, but not precious.

Wispr Flow is a visual reference only. Do not import Wispr product behavior, productivity features, command-launcher patterns, notification/account chrome, transcript feeds, voice/note concepts, smart recommendation logic, or non-Crate copy into the Crate app.

Design principles:

- dense enough for repeat work
- calm hierarchy
- obvious primary action
- small number of strong states
- native macOS spacing and controls
- no oversized marketing hero inside the app
- no decorative dashboard cards that slow work down
- no nested cards
- visible package output and review confidence

Interaction principles:

- Actions should not jump the user into unrelated views.
- Counts should not change mysteriously without context.
- If Crate is waiting, scanning, or cooling down, say so.
- If a user must save, say exactly that.
- If Crate cannot proceed, give one clear next action.

## Package Trust Model

The redesign should make three things obvious:

1. What Crate is including.
2. What Crate is not including.
3. What the user needs to do before packaging.

Trust signals to consider:

- "No unrelated files found"
- "Package-output folders excluded"
- "Diagnostics off"
- "Current Page Only - Page 1"
- "Needs save"
- "No issues found"
- "5 linked assets gathered"
- "3 extracted media files"

Do not overdo this in the main view. The primary UI should stay clean; Package Details can hold more evidence.

## Tester-Build Requirements

The redesigned build should support:

- `25 packages/month` beta usage display.
- Clear indication this is a beta/tester build if Bryant wants that surfaced.
- Tester-safe diagnostics language.
- Portal-friendly bug reporting path, even if it is just copy and not an integrated form.
- Easy version visibility so testers can report the exact build.

## Handoff To Engineering

When Jenna's mockup is ready, engineering needs:

- screen inventory
- component states
- navigation model
- exact visible copy or copy placeholders
- empty/loading/error/blocked states
- package count and quota states
- Figma modal and warning states
- Package Review and Package Details behavior
- responsive constraints for likely app window sizes
- any new icons or assets

Engineering should preserve the qa41 package engine unless a redesign requirement explicitly needs app logic work.

## Acceptance Criteria For Post-Redesign QA

The redesigned app should pass a focused `qa.42` or next-build smoke:

- launch / navigation / input / relaunch
- empty state remains interactive
- Settings and Figma connection states readable
- Quick Package packages correctly and increments quota
- quota limit blocks output
- Illustrator no-save linked JPG remains `Needs save`
- InDesign mixed existing + new package passes
- PSD linked smart-object package passes
- PowerPoint or Keynote mixed media package passes
- Figma Current Page Only Pro/team flow passes if not rate-limited
- Diagnostics OFF and ON behavior remains correct
- Package Details counts align with output
- package-output folders, diagnostics, stale lane files, unused controls, tokens, URLs, file keys, signed URLs, and private paths remain excluded

## Open Decisions For Bryant

- Exact beta entitlement implementation for 25 packages/month.
- Whether the app should show a visible beta label.
- Whether paid/pro launch quota is unlimited or a high cap.
- Exact get-crate.com Figma guidance copy and placement.
- Whether the app includes a "Learn more" link to Figma guidance.
- Which professional testing portal will be used and what field format it supports.

## Current Recommendation

Jenna should design against the qa41 packaging baseline and the product rules above.

Do not redesign the packaging logic. Redesign the experience around it: project state, review confidence, Figma setup, quota, diagnostics, and tester trust.

Keep the redesign close to the existing Crate app. The new visual layout should simplify the current app rather than introduce extra terms, new product sections, a homepage dashboard, or a more complicated dashboard model.

## 2026-06-27 Figma State Coverage Review

Jenna's current Figma direction was reviewed against this brief.

Result:

- Visual direction is good.
- The Wispr-style shell can stay.
- The Figma file needs more state coverage before engineering implementation.

Detailed review:

- `docs/crate/design/jenna-macos-redesign-state-coverage-review-2026-06-27.md`

Key next action:

- Add missing Figma frames for Files view, Package Review, Package Complete, Package Details, Quick Package, quota blocked, Needs Save, Figma error/scope states, and diagnostics state.

Update:

- The missing state coverage was added in Figma.
- Jenna is now reviewing and tweaking the design while keeping the framework, details, and existing visual direction.
- A follow-up cleanup removed Wispr/productivity behavior that had leaked into the mockup. Crate logo/wordmark treatment, required state frames, and required component variants were preserved.
- Bryant approved `Current Project` as the sidebar label for the selected/active project workspace. Do not use `Files` as a global sidebar label, and do not duplicate the existing `Projects` section.
- Bryant and Jenna approved removing `Home`. Default launch should land on `Projects`; the selected project work surface should be `Current Project`.

Figma cleanup result:

- The simplified current-model redesign pass is now the active design direction.
- `Crate macOS App - Current Model` is the current Figma model name.
- Home is gone.
- Files as a top-level tab is gone.
- `Current Project` replaces Files.
- Quick Package remains prominent, but not as a primary nav tab.
- Required frames now cover Projects, Current Project, Package Review, Package Complete, Package Details, Quick Package, Settings, quota, diagnostics, Figma states, and Help.
- `Help - Support` can remain as a lightweight in-app support destination, with external docs/support links decided later.

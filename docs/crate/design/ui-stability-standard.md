# Crate UI Stability Standard

Date: 2026-08-25

## Purpose

Crate is a resizable macOS desktop application. Existing screens must remain readable, contained, and usable as the available content pane changes width and as project data updates. This standard governs UI stability without changing Crate's product model or visual identity.

## Product boundary

UI-stability work preserves:

- the current sidebar and navigation;
- Projects, Quick Package, Project Workspace / Current Project, Settings, and Help;
- Review Assets, Package Review, Package Complete, and Package Details;
- package selection and output behavior;
- Figma Current Page Only and Entire File behavior;
- watcher, parser, provenance, quota, privacy, and security behavior.

Responsive work must not use global scaling, CSS `zoom`, or unreadably small controls to keep a fixed layout visible.

## Supported desktop window contract

The exact supported minimum dimensions are owned by the live Electron geometry gate. The implementation must adapt before it reaches that minimum; a minimum window size is a final safety rail, not the primary responsive strategy.

At every supported size:

- the application shell must not require horizontal scrolling;
- the main work surface must not require horizontal scrolling;
- content must not extend behind the sidebar;
- dialogs and sheets must remain inside the viewport;
- primary actions must remain visible and reachable;
- filenames may truncate, but instructions and error guidance must remain readable.

## Scroll ownership

- `.app-content` owns normal vertical application scrolling.
- Review Assets remains in normal vertical document flow.
- Purpose-built strips, such as Recently Found, may own local horizontal scrolling when their contents are intentionally presented as a strip.
- The main application, Project Workspace, Review Assets, Settings, and modal layouts must not introduce incidental horizontal scrolling.
- `overflow-x: hidden` or `clip` may contain paint only after the layout itself is proven to fit.

## Responsive modes

Responsive decisions should use the width of the component's actual content pane, not only the outer Electron window.

### Wide Review Assets pane

- heading and search may share a row;
- summary and bulk actions may share a row;
- four asset columns may be used when card content remains readable.

### Medium Review Assets pane

- search moves below the heading before collision;
- filters wrap naturally;
- asset presentation reduces to three columns.

### Narrow Review Assets pane

- summary and bulk actions use separate rows;
- footer actions wrap without overlap;
- asset presentation reduces to two columns.

### Compact Review Assets pane

- cards become readable compact rows rather than continuing to shrink;
- preview, filename, origin, status, and action remain visible;
- the data model and interaction behavior remain the same as card mode.

Thresholds must be verified against real component geometry and may change when the card design changes.

## Flexible-layout requirements

Flexible grid and flex children must use `min-width: 0` where long content could otherwise expand a parent. Work surfaces should use `max-width: 100%` and must not depend on fixed minimum widths that exceed the available pane.

Use:

- wrapping or stacked controls before collision;
- fewer grid columns before card compression;
- `minmax(0, 1fr)` for shrinkable grid tracks;
- intentional text truncation for filenames and source labels;
- normal wrapping for descriptions, warnings, and instructions.

Do not use:

- whole-application scaling;
- hidden inaccessible controls;
- fixed four-column layouts below their readable width;
- negative positioning that expands a footer or toolbar beyond its surface;
- a larger minimum window as a substitute for responsive behavior.

## Typography and controls

- Body and control text must remain readable at every supported size.
- Filter labels and action labels must not be truncated.
- Buttons must retain stable dimensions when disabled or when temporary loading copy is shown.
- Filename and source-label truncation must expose the full value through an accessible title or detail surface where appropriate.
- Keyboard focus indicators must remain visible.

## Visual containment

- One authoritative background layer should own decorative gradients.
- Primary work surfaces must contain their children and rounded edges.
- Preview colors must remain within preview/card boundaries.
- Sticky surfaces need sufficient opacity to prevent underlying content from visually bleeding through.
- Backdrop blur must not be used to conceal broken geometry and should be scoped away from unnecessarily large scrolling surfaces when profiling shows paint cost.

## Motion

Motion must communicate state rather than decorate stable conditions.

- Hover and focus feedback should be brief.
- Stable Watching state does not require continuous animation.
- Active scanning or packaging may animate.
- `transition: all` is prohibited on large or frequently changing surfaces.
- `prefers-reduced-motion` must suppress nonessential animation and transitions.

## State preservation

A resize must not:

- fetch project data;
- rebuild project data;
- reload unchanged previews;
- clear search text;
- change the selected filter;
- move keyboard focus;
- reset Review Assets scroll position.

An unrelated asset update should preserve:

- the active project;
- Review Assets open/closed state;
- search query and filter;
- scroll anchor;
- focus where the focused element still exists;
- unchanged asset and preview identity.

## Large-project expectations

Synthetic regression fixtures should cover:

- 0 assets;
- 7 assets;
- approximately 30 assets;
- 100 assets;
- 263 assets as the representative large project;
- 500 assets as a stress case.

Responsive geometry and large-list rendering are separate review concerns. Geometry fixes should not reopen watcher or package architecture. Large-list improvements should prefer stable keyed reconciliation, lazy preview scheduling, and bounded event coalescing before introducing a new dependency.

## Required checks for a UI PR

A user-visible responsive or interaction PR must include:

1. Exact canonical base SHA.
2. Exact PR-head SHA.
3. Focused source tests for the responsive contract.
4. Relevant complete regression-suite result.
5. Real macOS Electron evidence from the exact PR head.
6. Synthetic or explicitly approved test-safe content only.
7. Resize evidence at representative wide, default, narrow, and minimum sizes.
8. Confirmation that root, app shell, and affected work surface do not overflow horizontally.
9. Confirmation that headings, search, controls, cards, footer, and dialogs do not intersect.
10. Privacy review and media inspection.

Any later UI-affecting commit makes earlier visual evidence stale.

## Responsive PR review checklist

- [ ] No whole-app horizontal scrollbar.
- [ ] No content behind the sidebar.
- [ ] Search stacks before heading collision.
- [ ] Filters and bulk actions wrap before collision.
- [ ] Cards reduce density before their content is compressed.
- [ ] Compact mode remains readable.
- [ ] Footer stays within the work surface.
- [ ] Dialogs remain within the viewport.
- [ ] Long filenames do not expand the layout.
- [ ] Resizing does not trigger data or preview requests.
- [ ] Search, filter, focus, and scroll state remain stable.
- [ ] Reduced-motion behavior is present.
- [ ] No package, Figma, watcher, provenance, quota, or privacy behavior changed.
- [ ] Exact-head visual evidence has been inspected.

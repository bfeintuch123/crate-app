# Crate UI Stability Standard

Date: 2026-08-25

## Purpose

Crate is a resizable macOS desktop application. Existing screens must remain readable, contained, and usable as the available desktop pane changes width and as project data updates. This standard governs UI stability without changing Crate's product model or visual identity.

## Product boundary

UI-stability work preserves the persistent left sidebar, current navigation, Projects, Quick Package, Project Workspace, Settings, Help, Review Assets, package workflows, Figma scope, watcher behavior, provenance, quota, privacy, and security behavior.

Responsive work must not use global scaling, CSS `zoom`, or unreadably small controls to keep a fixed layout visible.

## Supported desktop window contract

The supported Crate minimum is **1100 × 760 outer window pixels**.

The real Electron window must enforce that minimum natively. Requests below either dimension must be clamped by the `BrowserWindow` contract before users can reach a cramped presentation.

At the supported minimum and every larger size:

- the traditional left sidebar remains present;
- navigation labels remain readable;
- the compact two-row navigation treatment is not active;
- the application shell and main work surface require no horizontal scrolling;
- content does not extend behind the sidebar;
- Review Assets controls, cards, and footer remain complete and reachable;
- Project Workspace, Settings, and dialogs remain desktop surfaces inside the viewport;
- primary actions remain visible and keyboard reachable;
- filenames may truncate, but instructions and error guidance remain readable.

The CSS below the supported minimum remains defensive. It protects unexpected embedding, synthetic tests, and platform anomalies; it is not a supported user-visible Crate mode.

## Minimum enforcement evidence

A UI PR that changes the minimum must prove all of the following with the real Electron window:

1. The native minimum reports `1100 × 760`.
2. A request such as `720 × 560` is recorded as a below-minimum request, not a supported layout.
3. The actual outer size after that request is clamped to `1100 × 760`.
4. The actual renderer viewport is recorded separately from the outer window dimensions.
5. The persistent desktop sidebar remains active after clamping.
6. The supported geometry matrix begins at the configured minimum.

## Scroll ownership

- `.app-content` owns normal vertical application scrolling.
- Review Assets remains in normal vertical document flow.
- Purpose-built strips may own local horizontal scrolling when intentional.
- The main application, Project Workspace, Review Assets, Settings, and modal layouts must not introduce incidental horizontal scrolling.
- `overflow-x: hidden` or `clip` may contain paint only after the layout itself is proven to fit.
- At short defensive viewports, a footer may return to normal flow rather than cover preceding controls.

## Responsive desktop modes

Responsive decisions use the component's actual pane width, not only the outer Electron window.

### Wide desktop

- heading and search may share a row;
- summary and bulk actions may share a row;
- four asset columns may be used when card content remains readable.

### Normal desktop

- search moves below the heading before collision;
- filters wrap naturally;
- asset presentation reduces to three columns when required.

### Minimum desktop

- the persistent left sidebar remains intact;
- summary and bulk actions separate before collision;
- cards reduce density before their contents are compressed;
- footer actions wrap without overlap;
- vertical scrolling is preferred over crushed controls.

### Defensive below-minimum CSS

Compact and narrow rules remain fail-safe only. They are not part of the supported window matrix, and the native window contract prevents users from reaching them through normal macOS resizing.

## Flexible-layout requirements

Use wrapping or stacked controls before collision, fewer grid columns before card compression, `minmax(0, 1fr)` for shrinkable tracks, filename truncation, and normal wrapping for descriptions and warnings.

Do not use whole-app scaling, inaccessible hidden controls, fixed card density below its readable width, negative positioning outside a work surface, or a large minimum as a substitute for responsive behavior.

## Typography, containment, and motion

- Body and control text remain readable at every supported size.
- Filter and action labels are not truncated.
- Buttons retain stable dimensions while loading or disabled.
- Keyboard focus indicators remain visible.
- Primary work surfaces contain previews, children, and rounded edges.
- A sticky footer must not intersect back navigation, headings, search, filters, summaries, or bulk actions.
- Stable Watching state does not require continuous animation.
- `transition: all` is prohibited on large or frequently changing surfaces.
- `prefers-reduced-motion` suppresses nonessential motion.

## State preservation

A resize must not fetch or rebuild project data, reload unchanged previews, clear search text, change the selected filter, move keyboard focus, or reset Review Assets scroll position.

An unrelated asset update should preserve the active project, Review Assets state, search, filter, scroll anchor, focus, and unchanged asset and preview identity.

## Large-project expectations

Synthetic fixtures cover 0, 7, approximately 30, 100, 263, and 500 assets. Responsive geometry and large-list rendering are separate review concerns. Geometry fixes do not reopen watcher or package architecture. Large-list improvements should prefer stable keyed reconciliation, lazy preview scheduling, and bounded event coalescing before adding a dependency.

## Required checks for a UI PR

A responsive or interaction PR includes:

1. Exact canonical base and PR-head SHAs.
2. Focused responsive contract tests.
3. Native minimum and below-minimum clamp tests.
4. Complete relevant regression results.
5. Real macOS Electron evidence from the exact head.
6. Synthetic or approved test-safe content only.
7. Resize evidence at minimum, normal, and wide desktop sizes.
8. No horizontal overflow or control intersections.
9. Compact navigation inactive throughout the supported matrix.
10. Privacy review and complete media inspection.

Any later UI-affecting commit makes earlier visual evidence stale.

## Review checklist

- [ ] Native minimum is `1100 × 760`.
- [ ] Below-minimum requests are clamped and recorded separately.
- [ ] Persistent desktop sidebar remains present at the minimum.
- [ ] Compact navigation is not a supported mode.
- [ ] No whole-app horizontal scrollbar or content behind the sidebar.
- [ ] Search, filters, summaries, and actions reflow before collision.
- [ ] Cards remain readable and contained.
- [ ] Footer stays inside the surface and does not cover controls.
- [ ] Settings and dialogs remain contained.
- [ ] Resizing does not trigger data or preview requests.
- [ ] Search, filter, focus, and scroll state remain stable.
- [ ] No package, Figma, watcher, provenance, quota, or privacy behavior changed.
- [ ] Exact-head visual evidence has been inspected.

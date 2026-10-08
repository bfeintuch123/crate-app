# Disabled working-source witness scaffold

`parsers/working-source-witness.js` is a pure, bounded observation consumer. It is not connected to `main.js`, app polling, renderer IPC or selection mutation. Every result has `automaticSelectionAllowed: false`; no supplied flag or qualification object can enable it. It supports candidate evidence only.

## Documented acquisition lead

The installed Keynote 15.1.1 scripting dictionary exposes read-only `document.id` with Cocoa key `scriptIdentifier`. The included Cocoa document definition supplies `file` and `modified`. `createKeynoteWitnessObservation` maps those values into a common envelope. Its `current` flag must come from a separately verified front-document query; the normalizer does not invent it. The dictionary does not establish the ID's lifetime through GUI Save As, Duplicate, copy-close-open, close/reopen or restart. Those controls remain unexecuted because native launch/access is blocked.

Local primary definitions inspected:
- `/Applications/Keynote Creator Studio.app/Contents/Resources/Keynote.sdef`
- `/System/Library/ScriptingDefinitions/CocoaStandard.sdef`

The live acquisition call is deliberately not implemented. This scaffold adds neither an undocumented Photoshop API nor a new script engine. Photoshop remains a research lead: the retrieved legacy reference documents saveAs with an asCopy argument, but this investigation did not establish a legacy Document.id/ActionManager documentID lifetime guarantee. The UXP document ID contract is not evidence for the existing ExtendScript bridge.

Primary references:
- Adobe's legacy reference publication: https://github.com/Adobe-CEP/CEP-Resources/blob/master/Documentation/Product%20specific%20Documentation/Photoshop%20Scripting/photoshop-javascript-ref-2020.pdf
- UXP-only document contract: https://developer.adobe.com/photoshop/uxp/ps_reference/classes/document/
- Apple process structure: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h (`proc_bsdinfo` contains PID and process start seconds/microseconds).

Direct legacy PDF retrieval was blocked or unavailable; indexed Adobe-authored reference text established saveAs, not the needed lifetime semantics. No forum claim is treated as an API guarantee.

## State and process boundary

A future trusted collector must obtain the actual application's PID and OS start token before and after the bridge call, rejecting disagreement. PID alone, wall-clock capture time, names and file timestamps are insufficient. The helper accepts a token but never acquires or fabricates one; OS collection remains to implement and validate. Apple proc_bsdinfo start fields are a documented source candidate, not a claim that this app has collected them.

The collector must report complete document counts and a monotonic sequence for every poll attempt, including failed/missed attempts. The state is isolated by project, watch activation, app/version/bridge/handle kind and process identity. Invalid input, gaps, replay and scope/process changes invalidate continuity. Observed handle reuse after closure quarantines the session. Limits are 64 documents per observation and 2048 handles per session. One tracker must be disposed when its watch ends.

The tests use synthetic process tokens and synthetic documents. They exercise the state contract, not real OS acquisition or native save semantics. Filesystem inode/link checks, canonical realpath binding, app-version qualification, saved-byte verification and atomic selection are not integrated. Even a same-handle new-path transition remains unqualified; filename rename, Save a Copy and hidden intermediate operations cannot gain authority.

## Minimum remaining proof

First resolve the existing app launch/access blocker through supported access, without retrying denied calls by another route. Then use only team-created temporary documents to measure GUI Save As (same/different folder and supported format), Save a Copy, duplicate, copy/open, copy-close-open, document switch, close/reopen, restart/session restore, cancelled/failed Save As, overwrite of existing B, two saves within a poll gap, missing/failed polls, safe-save, Finder rename, first save and Revert. Record exact app/version/bridge, process identity and per-document identity/path. A copied or reopened document reusing identity, or an indistinguishable negative control, disqualifies automatic use.

Passing synthetic state tests does not qualify an app. No automatic path can be enabled until native evidence, documented lifetime limits, filesystem/admission/verification integration and fresh independent review support it. The intended eventual behavior remains automatic successor selection and predecessor exclusion with genuine dependencies preserved; no new user-choice decision is introduced.

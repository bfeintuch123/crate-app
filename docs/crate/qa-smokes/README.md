# Crate QA Smoke Prompt Bank

Use these prompts to drive Jenna-machine installed-app QA without rebuilding every prompt from scratch.

Each smoke prompt should be filled with:

- QA version
- DMG URL or installed app version
- approved QA root
- approved fixture names
- expected result
- privacy constraints
- report template

Jenna-machine QA is internal validation. It does not replace release gates and does not approve final public `v2.8.0`.

## Prompt Index

- `smoke-01-install-launch.md` - install, launch, navigation, text input, quit/relaunch.
- `smoke-02-illustrator-no-save-linked-jpg.md` - clean Illustrator no-save linked JPG should stage as needs-save/pending.
- `smoke-03-quick-package.md` - Quick Package behavior, missing paths, output exclusions, and privacy.
- `smoke-04-figma-scope.md` - Current Page Only and Entire File behavior.
- `smoke-05-powerpoint-keynote.md` - saved extraction and Keynote mojibake regression.
- `smoke-06-psd-safety.md` - PSD embedded safety and package readiness.
- `smoke-07-package-details-diagnostics.md` - Package Details and optional diagnostics.

## Report Rule

Every Jenna report should include:

- QA version
- machine
- installed app metadata
- smoke name
- result
- project name
- steps run
- expected
- actual
- files used
- Crate UI observations
- runtime evidence
- privacy / scope
- package behavior
- classification
- recommendation

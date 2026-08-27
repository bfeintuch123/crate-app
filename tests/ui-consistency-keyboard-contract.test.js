'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const rendererApp = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const phaseCScriptMatch = indexHtml.match(
  /<script src="app\.js"><\/script>\s*<script>([\s\S]*?)<\/script>\s*<\/body>/u,
);
assert.ok(phaseCScriptMatch, 'Phase C source-bound script must remain present');
const phaseCScript = phaseCScriptMatch[1];
const stabilityMatch = indexHtml.match(/<style id="crate-ui-stability">([\s\S]*?)<\/style>/u);
assert.ok(stabilityMatch, 'Phase A/Phase C source-bound style block must remain present');
const stabilityCss = stabilityMatch[1];

function requireControlLabel(controlId, labelPattern) {
  assert.match(
    indexHtml,
    new RegExp(`<label[^>]*for="${controlId}"[^>]*>${labelPattern}<\\/label>`, 'u'),
  );
}

test('form fields and Settings toggles expose explicit accessible names', () => {
  requireControlLabel('input-project-name', 'Project Name');
  requireControlLabel('input-figma-url', 'Figma file URL');
  requireControlLabel('input-figma-scope', 'Scope');
  requireControlLabel('input-naming-template', 'Template');
  requireControlLabel('input-figma-token', 'Figma personal access token');
  requireControlLabel('edit-figma-url', 'Replace Figma URL \\(optional\\)');
  requireControlLabel('edit-figma-scope', 'Scope');

  for (const contract of [
    ['toggle-notifications', 'setting-notifications-label', 'setting-notifications-desc'],
    ['toggle-diagnostic-report', 'setting-diagnostics-label', 'setting-diagnostics-desc setting-diagnostics-hint'],
    ['toggle-package-details', 'setting-package-details-label', 'setting-package-details-desc'],
    ['toggle-package-folders', 'setting-package-folders-label', 'setting-package-folders-desc'],
  ]) {
    const [id, labelledBy, describedBy] = contract;
    assert.match(
      indexHtml,
      new RegExp(
        `id="${id}"[^>]*aria-labelledby="${labelledBy}"[^>]*aria-describedby="${describedBy}"`,
        'u',
      ),
    );
  }
});

test('Figma validation and warning surfaces use nonduplicative status semantics', () => {
  assert.match(
    indexHtml,
    /id="figma-section-error"[^>]*role="alert"[^>]*aria-live="assertive"[^>]*aria-atomic="true"/u,
  );
  assert.match(
    indexHtml,
    /id="edit-figma-error"[^>]*role="alert"[^>]*aria-live="assertive"[^>]*aria-atomic="true"/u,
  );
  assert.match(
    indexHtml,
    /id="files-figma-warning"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u,
  );
  assert.match(
    indexHtml,
    /id="modal-figma-warning"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u,
  );
  assert.match(indexHtml, /id="btn-figma-scan-now"[^>]*aria-describedby="figma-scan-status"/u);
  assert.match(
    indexHtml,
    /id="figma-scan-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u,
  );
});

test('Phase C exposes the requested primary DOM and keyboard order with current-page semantics', () => {
  assert.match(indexHtml, /data-tab="projects" aria-current="page">Projects/u);
  assert.match(phaseCScript, /function updateNavigationState\(\)/u);
  assert.match(phaseCScript, /setAttribute\('aria-current', 'page'\)/u);
  assert.match(phaseCScript, /removeAttribute\('aria-current'\)/u);

  const primaryNav = indexHtml.match(/<nav class="app-tabs" aria-label="Primary">([\s\S]*?)<\/nav>/u)?.[1] || '';
  const buttons = [...primaryNav.matchAll(/<button\b([^>]*)>([^<]+)<\/button>/gu)].map(([, attributes, label]) => ({
    attributes,
    route: attributes.match(/data-tab="([^"]+)"/u)?.[1],
    label: label.trim(),
  }));
  assert.deepEqual(
    buttons.map(({ route, label }) => ({ route, label })),
    [
      { route: 'projects', label: 'Projects' },
      { route: 'current-project', label: 'Project Workspace' },
      { route: 'quick-package', label: 'Quick Package' },
    ],
  );
  assert.match(buttons[0].attributes, /aria-current="page"/u);
  assert.ok(buttons.every(({ attributes }) => !/\btabindex\s*=/u.test(attributes)));

  assert.match(rendererApp, /const normalizedTab = tabName === 'files' \? 'current-project' : tabName;/u);
  assert.match(rendererApp, /t\.dataset\.tab === normalizedTab/u);
  assert.match(rendererApp, /tc\.id === `tab-\$\{normalizedTab\}`/u);
  assert.match(rendererApp, /state\.selectedProjectId = project\.id;\s*switchTab\('current-project'\);/u);
  assert.match(rendererApp, /tab\.addEventListener\('click', \(\) => switchTab\(tab\.dataset\.tab\)\);/u);
});

test('project selection, watch controls, and Figma-link editing have keyboard contracts', () => {
  assert.match(phaseCScript, /function decorateProjectRows\(\)/u);
  assert.match(phaseCScript, /info\.setAttribute\('role', 'button'\)/u);
  assert.match(phaseCScript, /info\.setAttribute\('tabindex', '0'\)/u);
  assert.match(phaseCScript, /pill\.setAttribute\('role', 'button'\)/u);
  assert.match(phaseCScript, /pill\.setAttribute\('aria-disabled'/u);
  assert.match(phaseCScript, /\['Enter', ' '\]\.includes\(event\.key\)/u);
  assert.match(phaseCScript, /\.project-info\[role="button"\]/u);
  assert.match(phaseCScript, /link\.setAttribute\('role', 'button'\)/u);
  assert.match(phaseCScript, /link\.addEventListener\('keydown'/u);
});

test('visible focus and keyboard-revealed project actions are source-bound', () => {
  assert.match(
    stabilityCss,
    /:is\(button, \[href\], input, select, textarea, summary, \[role="button"\]\[tabindex\]\):focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--black\);[\s\S]*?outline-offset:\s*3px;/u,
  );
  assert.match(
    stabilityCss,
    /\.app-sidebar :is\(button, \[href\], \[role="button"\]\[tabindex\]\):focus-visible\s*\{[\s\S]*?outline-color:\s*var\(--white\);/u,
  );
  assert.match(
    stabilityCss,
    /\.project-row:focus-within \.project-delete\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/u,
  );
  assert.match(rendererApp, /class="project-delete"[^>]*aria-label="Remove project"/u);
});

test('Phase C stays inside existing renderer source files', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'renderer', 'phase-c.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'renderer', 'accessibility.js')), false);
  assert.match(indexHtml, /<script src="app\.js"><\/script>/u);
});

// ===== Constants =====
const MAX_PROJECTS = 7;
const MAX_VISIBLE_FILES = 4;
const PRESENTATION_FILE_EXTS = new Set(['.ppt', '.pptx', '.key']);
const DEFAULT_NAMING_TEMPLATE = '{Project}_{Date}';
const DEFAULT_PACKAGE_FOLDER_NAME = 'Untitled';
const MAX_PACKAGE_FOLDER_NAME_LENGTH = 180;
const UNSAFE_PACKAGE_FOLDER_CHARS = /[\x00-\x1f\x7f<>:"|?*\\/]/g;

// ===== State =====
let state = {
  projects: [],
  selectedProjectId: null,
  settings: {},
  usage: {},
  packageOutputPath: null,
  lastPackagedPath: null,
  pendingDeleteId: null,
  projectType: 'branding',
  figmaScopeMode: 'current-page',
  figmaSectionExpanded: false,
  figmaScanInFlight: false,
  lastFigmaWarning: null,
  editFigmaProjectId: null
};

let rendererEventListenersBound = false;
let mainProcessListenersBound = false;

// Lightweight Figma URL validator — must match the patterns the main process accepts.
const FIGMA_URL_PATTERN = /(?:(?:https?:\/\/)?(?:www\.|embed\.)?figma\.com\/(?:file|design|proto)\/|figma:\/\/(?:file|design|proto)\/)([a-zA-Z0-9_-]+)/i;
const FIGMA_OPEN_URL_PATTERN = /figma:\/\/open\?/i;
const FIGMA_FILE_KEY_PARAM_PATTERN = /[?&#](?:file-key|fileKey|file_key|file-id|fileId|file_id)=([a-zA-Z0-9_-]+)/i;
function isValidFigmaUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  const candidates = [trimmed];
  try {
    const decoded = decodeURIComponent(trimmed);
    if (decoded && decoded !== trimmed) candidates.push(decoded);
  } catch (e) {
    // Keep the raw URL for validation.
  }
  return candidates.some(candidate => (
    FIGMA_URL_PATTERN.test(candidate) ||
    (FIGMA_OPEN_URL_PATTERN.test(candidate) && FIGMA_FILE_KEY_PARAM_PATTERN.test(candidate))
  ));
}

function sanitizeRendererLogText(value) {
  let text = '';
  if (value instanceof Error) {
    text = value.message || '';
  } else if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch (e) {
      text = String(value);
    }
  }

  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\bAuthorization\b\s*[:=]\s*[^,\s)]+/gi, 'Authorization=[redacted]')
    .replace(/\bBearer\s+[^\s,)]+/gi, 'Bearer [redacted]')
    .replace(/\bcookie\b\s*[:=]\s*[^,\s)]+/gi, 'cookie=[redacted]')
    .replace(/\btoken\b\s*[:=]\s*[^,\s)]+/gi, 'token=[redacted]')
    .replace(/[A-Za-z0-9._-]*(token|secret|authorization|bearer|cookie|auth)[A-Za-z0-9._-]*/gi, '[redacted-sensitive]')
    .replace(/(?:\/Users|\/Volumes|\/private\/var|\/var)\/[^\s"'<>]+/g, '[redacted-path]');
}

function logRendererError(scope, error) {
  console.error(`[renderer] ${scope}:`, sanitizeRendererLogText(error));
}

function getFileExtension(file) {
  if (!file) return '';

  const ext = typeof file.ext === 'string' ? file.ext.trim().toLowerCase() : '';
  if (ext) return ext.startsWith('.') ? ext : `.${ext}`;

  const source = typeof file.name === 'string' && file.name
    ? file.name
    : (typeof file.path === 'string' ? file.path : '');
  const match = source.toLowerCase().match(/(\.[^./\\]+)$/);
  return match ? match[1] : '';
}

function isPresentationWorkflow(project) {
  if (!project) return false;
  if (project.type === 'presentation') return true;
  return (project.files || []).some(file => PRESENTATION_FILE_EXTS.has(getFileExtension(file)));
}

function sanitizePackageFolderName(rawName, fallbackName = DEFAULT_PACKAGE_FOLDER_NAME) {
  let fallback = `${fallbackName || DEFAULT_PACKAGE_FOLDER_NAME}`
    .replace(UNSAFE_PACKAGE_FOLDER_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!fallback || fallback === '.' || fallback === '..') fallback = DEFAULT_PACKAGE_FOLDER_NAME;

  let name = `${rawName || ''}`
    .replace(UNSAFE_PACKAGE_FOLDER_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim();

  if (name.startsWith('..')) name = name.replace(/^\.+/, '').trim();
  if (!name || name === '.' || name === '..') name = fallback;
  if (name.length > MAX_PACKAGE_FOLDER_NAME_LENGTH) {
    name = name.slice(0, MAX_PACKAGE_FOLDER_NAME_LENGTH).trim();
  }
  return name || fallback;
}

function sanitizeNamingTemplate(rawTemplate) {
  return sanitizePackageFolderName(rawTemplate, DEFAULT_NAMING_TEMPLATE);
}

// ===== DOM Helpers =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ===== Init =====
async function init() {
  setupEventListeners();

  if (!window.crate) {
    logRendererError('preload bridge unavailable during startup', 'window.crate missing');
    renderProjects();
    renderSettingsControls();
    renderFooter();
    return;
  }

  setupMainProcessListeners();

  try {
    const [projects, settings, usage] = await Promise.all([
      window.crate.getProjects(),
      window.crate.getSettings(),
      window.crate.getUsage(),
    ]);
    state.projects = Array.isArray(projects) ? projects : [];
    state.settings = settings && typeof settings === 'object' ? settings : {};
    state.usage = usage && typeof usage === 'object' ? usage : {};
  } catch (e) {
    logRendererError('startup data load failed', e);
  }

  renderProjects();
  renderSettingsControls();
  renderFooter();
  renderFigmaSettings().catch((e) => logRendererError('Figma settings refresh failed', e));
}

// ===== Tab Switching =====
function switchTab(tabName) {
  $$('.app-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  $$('.tab-content').forEach(tc => {
    tc.classList.toggle('active', tc.id === `tab-${tabName}`);
  });

  if (tabName === 'files') {
    renderFiles();
  } else if (tabName === 'settings') {
    renderSettings();
  } else if (tabName === 'projects') {
    renderProjects();
  }
}

// ===== Render Projects =====
function renderProjects() {
  const empty = $('#projects-empty');
  const list = $('#projects-list');
  const form = $('#new-project-form');

  if (state.projects.length === 0) {
    empty.classList.remove('hidden');
    list.classList.add('hidden');
    form.classList.add('hidden');
  } else {
    empty.classList.add('hidden');
    list.classList.remove('hidden');
    form.classList.add('hidden');
    renderProjectRows();
  }

  updateAddProjectButton();
}

function renderProjectRows() {
  const container = $('#project-rows');
  container.innerHTML = '';

  for (const project of state.projects) {
    const row = document.createElement('div');
    row.className = `project-row ${project.status === 'watching' ? 'watching' : ''}`;
    row.dataset.id = project.id;

    const statusLabel = getStatusLabel(project);
    const pillText = project.status === 'watching' ? 'Watching'
      : project.status === 'paused' ? 'Start Watching'
      : 'Packaged \u2713';

    row.innerHTML = `
      <div class="project-dot ${project.status}"></div>
      <div class="project-info">
        <div class="project-name">${escapeHtml(project.name)}</div>
        <div class="project-status">${statusLabel}</div>
      </div>
      <span class="project-pill ${project.status}" data-id="${project.id}">${pillText}</span>
      <button class="project-delete" data-id="${project.id}" title="Remove project">&times;</button>
    `;

    // Click row -> go to files
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('project-pill') || e.target.classList.contains('project-delete')) return;
      state.selectedProjectId = project.id;
      switchTab('files');
    });

    // Click pill -> toggle watching
    const pill = row.querySelector('.project-pill');
    pill.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (project.status === 'watching') {
        await window.crate.pauseProject(project.id);
      } else {
        await window.crate.startWatching(project.id);
      }
      state.projects = await window.crate.getProjects();
      renderProjects();
    });

    // Click delete -> show confirmation
    const deleteBtn = row.querySelector('.project-delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showDeleteConfirmation(project.id, project.name);
    });

    container.appendChild(row);
  }
}

function getStatusLabel(project) {
  const fileCount = project.files.length;
  const filesText = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;

  if (project.status === 'watching') {
    // v2.5.0: Remove mid-session file counter — only show count after packaging
    return `Watching`;
  } else if (project.status === 'paused') {
    return `Paused \u00B7 ${filesText} so far`;
  } else {
    const date = project.packagedAt
      ? new Date(project.packagedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';
    return `Packaged${date ? ' \u00B7 ' + date : ''} \u00B7 ${filesText}`;
  }
}

function updateAddProjectButton() {
  const startBtn = $('#btn-start-project');
  const addBtn = $('#btn-add-project');
  const atCap = state.projects.length >= MAX_PROJECTS;

  if (startBtn) {
    startBtn.disabled = atCap;
    if (atCap) {
      startBtn.setAttribute('data-tooltip', 'Maximum projects reached. Package or delete a project first.');
    } else {
      startBtn.removeAttribute('data-tooltip');
    }
  }

  if (addBtn) {
    addBtn.disabled = atCap;
    if (atCap) {
      addBtn.setAttribute('data-tooltip', 'Maximum projects reached. Package or delete a project first.');
    } else {
      addBtn.removeAttribute('data-tooltip');
    }
  }
}

// ===== New Project Form =====
function showNewProjectForm() {
  if (state.projects.length >= MAX_PROJECTS) return;

  $('#projects-empty').classList.add('hidden');
  $('#projects-list').classList.add('hidden');
  $('#new-project-form').classList.remove('hidden');
  const input = $('#input-project-name');
  input.value = '';
  input.focus();

  // Reset project type to default
  state.projectType = 'branding';
  state.figmaScopeMode = 'current-page';
  $$('.type-pill').forEach(p => p.classList.remove('active'));
  const defaultPill = document.querySelector('.type-pill[data-type="branding"]');
  if (defaultPill) defaultPill.classList.add('active');
  const figmaScopeInput = $('#input-figma-scope');
  if (figmaScopeInput) {
    figmaScopeInput.value = 'current-page';
  }
  const figmaUrlInput = $('#input-figma-url');
  if (figmaUrlInput) figmaUrlInput.value = '';
  const figmaError = $('#figma-section-error');
  if (figmaError) {
    figmaError.classList.add('hidden');
    figmaError.textContent = '';
  }
  state.figmaSectionExpanded = false;
  setFigmaSectionExpanded(false);

  // Update template display from current settings
  const templateDisplay = $('#naming-template-display');
  if (templateDisplay) {
    templateDisplay.textContent = state.settings.namingTemplate || DEFAULT_NAMING_TEMPLATE;
  }

  updateNamingPreview();
}

function hideNewProjectForm() {
  $('#new-project-form').classList.add('hidden');
  renderProjects();
}

async function createProject() {
  const name = $('#input-project-name').value.trim();
  if (!name) return;

  if (state.projects.length >= MAX_PROJECTS) {
    return;
  }

  const figmaScopeInput = $('#input-figma-scope');
  state.figmaScopeMode = figmaScopeInput ? figmaScopeInput.value : 'current-page';

  const figmaUrlInput = $('#input-figma-url');
  const figmaError = $('#figma-section-error');
  let figmaUrl = null;
  if (state.figmaSectionExpanded && figmaUrlInput) {
    const candidate = figmaUrlInput.value.trim();
    if (candidate) {
      if (!isValidFigmaUrl(candidate)) {
        if (figmaError) {
          figmaError.textContent = "That doesn't look like a Figma file URL. Try a URL like https://www.figma.com/file/ABC123/My-File.";
          figmaError.classList.remove('hidden');
        }
        return;
      }
      figmaUrl = candidate;
    }
  }

  if (figmaError) {
    figmaError.classList.add('hidden');
    figmaError.textContent = '';
  }

  const result = await window.crate.createProject(name, state.projectType, state.figmaScopeMode, figmaUrl);
  // FIX 6 (M3): Guard against null/error IPC response
  if (!result || result.error) {
    if (result && result.error === 'invalid_figma_url' && figmaError) {
      figmaError.textContent = 'Crate could not read that Figma URL. Please double-check and try again.';
      figmaError.classList.remove('hidden');
    }
    return;
  }

  state.projects = await window.crate.getProjects();
  state.selectedProjectId = result.id;
  hideNewProjectForm();
  renderProjects();
  switchTab('files');
}

function setFigmaSectionExpanded(expanded) {
  state.figmaSectionExpanded = !!expanded;
  const body = $('#figma-section-body');
  const toggle = $('#figma-section-toggle');
  const icon = toggle ? toggle.querySelector('.figma-section-icon') : null;
  if (body) body.classList.toggle('hidden', !expanded);
  if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (icon) icon.innerHTML = expanded ? '&#x25BC;' : '&#x25B6;';
}

// ===== Naming Preview =====
function cleanName(s) {
  const cleaned = `${s || ''}`.replace(/[^a-zA-Z0-9 ._\-()]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '.' || cleaned === '..') return DEFAULT_PACKAGE_FOLDER_NAME;
  return cleaned || DEFAULT_PACKAGE_FOLDER_NAME;
}

function resolveNamingTemplate(template, name) {
  const dateStr = new Date().toISOString().split('T')[0];
  // Use the full project name — no client/project splitting.
  const folderName = sanitizeNamingTemplate(template)
    .replace('{Project}', cleanName(name || 'Project'))
    .replace('{Date}', dateStr);
  return sanitizePackageFolderName(folderName);
}

function getProjectFigmaScopeMode(project) {
  const projectMode = project && project.figmaScopeMode;
  if (projectMode === 'current-page' || projectMode === 'entire-file') return projectMode;

  return 'current-page';
}

function getProjectFigmaScopeLabel(project) {
  const scopeMode = getProjectFigmaScopeMode(project);
  if (scopeMode === 'entire-file') return 'Entire File';

  const trackedFiles = (project && project.figmaSession && project.figmaSession.trackedFiles) || [];
  const lockedPageNames = Array.from(new Set(
    trackedFiles
      .map(file => file && file.lockedPageName)
      .filter(Boolean)
  ));

  if (lockedPageNames.length === 1) {
    return `Current Page Only - ${lockedPageNames[0]}`;
  }
  if (lockedPageNames.length > 1) {
    return `Current Page Only - ${lockedPageNames.length} locked pages`;
  }

  const lockStatuses = new Set(
    trackedFiles
      .map(file => file && file.lockStatus)
      .filter(Boolean)
  );
  if (lockStatuses.has('unresolved')) {
    return 'Current Page Only (page lock unresolved)';
  }
  if (lockStatuses.has('pending')) {
    return 'Current Page Only (resolving page lock)';
  }
  return 'Current Page Only (locked at session start)';
}

function getProjectFigmaWarning(project) {
  const warnings = (project && project.figmaSession && project.figmaSession.warnings) || [];
  return warnings[0] || '';
}

function updateNamingPreview() {
  const template = state.settings.namingTemplate || DEFAULT_NAMING_TEMPLATE;
  const input = $('#input-project-name');
  const name = input ? input.value.trim() : '';
  const preview = resolveNamingTemplate(template, name);
  const previewEl = $('#naming-preview-text');
  if (previewEl) previewEl.textContent = preview;
  return preview;
}

// ===== Render Files =====
async function renderFiles() {
  const noProject = $('#files-no-project');
  const filesView = $('#files-view');

  // If no project is selected, try to auto-select an active one
  if (!state.selectedProjectId) {
    const watching = state.projects.find(p => p.status === 'watching');
    if (watching) {
      state.selectedProjectId = watching.id;
    }
  }

  if (!state.selectedProjectId) {
    noProject.innerHTML = '<div class="app-empty-icon">&#x1F4C2;</div><div class="app-empty-title">No active project</div><div class="app-empty-desc">Start watching a project to see its files here.</div>';
    noProject.classList.remove('hidden');
    filesView.classList.add('hidden');
    return;
  }

  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) {
    noProject.innerHTML = '<div class="app-empty-icon">&#x1F4C2;</div><div class="app-empty-title">No active project</div><div class="app-empty-desc">Start watching a project to see its files here.</div>';
    noProject.classList.remove('hidden');
    filesView.classList.add('hidden');
    return;
  }

  // Show empty state when project is packaged or not actively watching
  if (project.status === 'packaged') {
    noProject.innerHTML = '<p style="color:#9ca3af;font-size:13px;text-align:center;padding:32px 16px;">This project has been packaged.<br>Start a new project to begin tracking files.</p>';
    noProject.classList.remove('hidden');
    filesView.classList.add('hidden');
    return;
  }

  noProject.classList.add('hidden');
  filesView.classList.remove('hidden');

  // Project name
  $('#files-project-name').textContent = project.name;

  // Status bar
  const statusBar = $('#files-status-bar');
  const statusDot = $('#files-status-dot');
  const statusText = $('#files-status-text');
  const figmaScopeText = $('#files-figma-scope');
  const figmaWarningText = $('#files-figma-warning');
  const fileCount = project.files.length;

  statusBar.className = `app-status ${project.status !== 'watching' ? project.status : ''}`;
  statusDot.className = `app-dot ${project.status !== 'watching' ? project.status : ''}`;

  if (project.status === 'watching') {
    // v2.5.0: No mid-session counter — count shown only after packaging
    statusText.textContent = `Watching`;
  } else if (project.status === 'paused') {
    statusText.textContent = `Paused \u00B7 ${fileCount} file${fileCount !== 1 ? 's' : ''}`;
  } else {
    statusText.textContent = `Packaged \u2713 \u00B7 ${fileCount} file${fileCount !== 1 ? 's' : ''}`;
  }

  if (figmaScopeText) {
    const trackedFiles = (project.figmaTrackedFiles || []);
    const hasLink = trackedFiles.length > 0;
    figmaScopeText.innerHTML = '';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'figma-link-label';
    if (hasLink) {
      labelSpan.textContent = `Figma scope: ${getProjectFigmaScopeLabel(project)}`;
    } else {
      labelSpan.textContent = '+ Link a Figma file (optional)';
    }
    figmaScopeText.appendChild(labelSpan);
    figmaScopeText.classList.toggle('linked', hasLink);
    figmaScopeText.classList.toggle('unlinked', !hasLink);
    figmaScopeText.onclick = () => openEditFigmaLinkModal(project.id);
  }
  if (figmaWarningText) {
    const warning = getProjectFigmaWarning(project);
    figmaWarningText.textContent = warning;
    figmaWarningText.style.display = warning ? 'block' : 'none';
  }

  // Pending files (Tier 2)
  renderPendingFiles(project);

  // File list
  renderFileList(project.files, {
    hasActiveCandidates: (project.pendingFiles || []).length > 0,
  });

  // Package button — always enabled; click handler shows toast if no files
  const packageBtn = $('#btn-package');
  packageBtn.disabled = false;
}

// v2.5.0: Track expanded state for file list
let fileListExpanded = false;

function renderFileList(files, options = {}) {
  const container = $('#file-list');
  container.innerHTML = '';

  if (files.length === 0) {
    const message = options.hasActiveCandidates
      ? 'No package-ready files yet. Review the files Crate observed during this session.'
      : 'No files tracked yet. Files will appear as you work.';
    container.innerHTML = `<div class="files-empty">${escapeHtml(message)}</div>`;
    return;
  }

  const previewFiles = files.slice(0, MAX_VISIBLE_FILES);
  const hasMore = files.length > MAX_VISIBLE_FILES;

  // Render preview files (always visible)
  for (const file of previewFiles) {
    container.appendChild(createFileRow(file));
  }

  if (hasMore) {
    // Expand/collapse toggle
    const toggle = document.createElement('div');
    toggle.className = 'file-list-toggle';
    toggle.innerHTML = fileListExpanded
      ? `<span class="file-list-toggle-icon">\u25B4</span> Hide files`
      : `<span class="file-list-toggle-icon">\u25BE</span> Show all ${files.length} files`;
    toggle.addEventListener('click', () => {
      fileListExpanded = !fileListExpanded;
      // M2: Re-fetch current files from state instead of closing over stale `files` array
      const project = state.projects.find(p => p.id === state.selectedProjectId);
      renderFileList(project ? project.files : files, {
        hasActiveCandidates: !!(project && (project.pendingFiles || []).length > 0),
      });
    });
    container.appendChild(toggle);

    // Expanded drawer
    if (fileListExpanded) {
      const drawer = document.createElement('div');
      drawer.className = 'file-list-drawer';
      for (const file of files.slice(MAX_VISIBLE_FILES)) {
        drawer.appendChild(createFileRow(file));
      }
      container.appendChild(drawer);
    }
  }
}

const PENDING_APP_LABELS = {
  illustrator: 'Illustrator',
  photoshop: 'Photoshop',
  indesign: 'InDesign',
  figma: 'Figma',
  powerpoint: 'PowerPoint',
  keynote: 'Keynote',
};

function getPendingCaptureState(file) {
  const stateValue = file && typeof file.captureState === 'string' ? file.captureState : '';
  if (stateValue === 'needs-save') return 'needs-save';
  if (stateValue === 'observed') return 'observed';
  return 'pending';
}

function getPendingAppLabel(file) {
  const appFamily = file && file.captureEvidence && file.captureEvidence.appFamily;
  return PENDING_APP_LABELS[appFamily] || null;
}

function getPendingFileReason(file) {
  const stateValue = getPendingCaptureState(file);
  const evidence = (file && file.captureEvidence) || {};
  const appLabel = getPendingAppLabel(file);

  if (stateValue === 'needs-save') {
    if (evidence.sourceName) return `Linked asset observed from ${evidence.sourceName}. Save to make package-ready.`;
    if (appLabel) return `Observed in ${appLabel}. Save to make package-ready.`;
    return 'Save to make package-ready.';
  }

  if (stateValue === 'observed') {
    return appLabel ? `Observed in ${appLabel}.` : 'Opened during this session.';
  }

  return appLabel ? `Needs review before packaging. Observed in ${appLabel}.` : 'Needs review before packaging.';
}

function createFileRow(file) {
  const row = document.createElement('div');
  row.className = 'app-file';
  const emoji = getFileEmoji(file.ext);
  const statusBadge = file.embedded
    ? '<span class="file-status-badge embedded" title="Embedded — extracted at package time">EMB</span>'
    : (file.source && file.source.includes('linked')
      ? '<span class="file-status-badge linked" title="Linked file — confirmed path">LNK</span>'
      : '');

  row.innerHTML = `
    <span class="app-file-icon">${emoji}</span>
    <span class="app-file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span>
    ${statusBadge}
    <button class="app-file-remove" title="Remove">&times;</button>
  `;

  const removeBtn = row.querySelector('.app-file-remove');
  removeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.crate.removeFile(state.selectedProjectId, file.fileId || file.path);
    state.projects = await window.crate.getProjects();
    renderFiles();
  });

  return row;
}

// ===== Render Pending (Tier 2) Files =====
function renderPendingFiles(project) {
  const section = $('#pending-section');
  const list = $('#pending-file-list');
  if (!section || !list) return;

  const pending = project.pendingFiles || [];

  if (pending.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = '';

  for (const file of pending) {
    const row = document.createElement('div');
    row.className = 'pending-file';
    const reason = getPendingFileReason(file);
    const stateLabel = getPendingCaptureState(file) === 'needs-save'
      ? 'Needs save'
      : (getPendingCaptureState(file) === 'observed' ? 'Opened' : 'Needs review');

    row.innerHTML = `
      <span class="app-file-icon">${getFileEmoji(file.ext)}</span>
      <span class="pending-file-copy">
        <span class="app-file-name pending-file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span>
        <span class="pending-file-reason">${escapeHtml(reason)}</span>
      </span>
      <span class="pending-state-badge">${escapeHtml(stateLabel)}</span>
      <div class="pending-actions">
        <button class="btn-accept-pending" data-path="${escapeHtml(file.path)}" title="Add to project">+ Add</button>
        <button class="btn-reject-pending" data-path="${escapeHtml(file.path)}" title="Skip this file">Skip</button>
      </div>
    `;

    row.querySelector('.btn-accept-pending').addEventListener('click', async () => {
      await window.crate.acceptPending(project.id, file.path);
      state.projects = await window.crate.getProjects();
      renderFiles();
    });

    row.querySelector('.btn-reject-pending').addEventListener('click', async () => {
      await window.crate.rejectPending(project.id, file.path);
      state.projects = await window.crate.getProjects();
      renderFiles();
    });

    list.appendChild(row);
  }
}

function getFileEmoji(ext) {
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.tiff', '.bmp', '.ico'];
  const designExts = ['.psd', '.ai', '.sketch', '.fig', '.xd', '.indd', '.eps', '.afdesign'];
  const pdfExts = ['.pdf'];
  const docExts = ['.doc', '.docx', '.txt', '.rtf', '.pages', '.odt'];
  const fontExts = ['.otf', '.ttf', '.woff', '.woff2'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const audioExts = ['.mp3', '.wav', '.aac', '.flac', '.ogg'];

  if (imageExts.includes(ext)) return '\uD83D\uDDBC';
  if (designExts.includes(ext)) return '\uD83D\uDDBC';
  if (pdfExts.includes(ext)) return '\uD83D\uDCC4';
  if (docExts.includes(ext)) return '\uD83D\uDCC4';
  if (fontExts.includes(ext)) return '\uD83D\uDD24';
  if (videoExts.includes(ext)) return '\uD83C\uDFAC';
  if (audioExts.includes(ext)) return '\uD83C\uDFB5';
  return '\uD83D\uDCCE';
}

// ===== Render Settings =====
function renderSettingsControls() {
  $('#input-naming-template').value = state.settings.namingTemplate || DEFAULT_NAMING_TEMPLATE;
  $('#toggle-notifications').checked = state.settings.notifications || false;
  $('#toggle-diagnostic-report').checked = state.settings.includeDiagnosticReport === true;
  $('#toggle-package-details').checked = state.settings.showPackageDetails !== false;

  const used = Number(state.usage.packagesThisMonth) || 0;
  $('#plan-info').textContent = `Free Plan \u00B7 ${used}/10 packages`;

  updateSettingsNamingPreview();
}

async function renderSettings() {
  try {
    const [settings, usage] = await Promise.all([
      window.crate.getSettings(),
      window.crate.getUsage(),
    ]);
    state.settings = settings && typeof settings === 'object' ? settings : {};
    state.usage = usage && typeof usage === 'object' ? usage : {};
  } catch (e) {
    logRendererError('settings refresh failed', e);
  }

  renderSettingsControls();
  renderFigmaSettings().catch((e) => logRendererError('Figma settings refresh failed', e));
}

// ===== Figma Settings =====
async function renderFigmaSettings() {
  const connected = $('#figma-connected');
  const disconnected = $('#figma-disconnected');
  let status = { connected: false };

  try {
    status = await window.crate.getFigmaStatus();
  } catch (e) {
    logRendererError('Figma status refresh failed', e);
  }

  if (status.connected) {
    connected.classList.remove('hidden');
    disconnected.classList.add('hidden');

    // Update auto-tracking stats
    const projectCountEl = $('#figma-project-count');
    const assetCountEl = $('#figma-asset-count');

    if (projectCountEl) {
      projectCountEl.textContent = status.activeProjectCount || 0;
    }
    if (assetCountEl) {
      assetCountEl.textContent = status.totalFigmaAssets || 0;
    }
  } else {
    connected.classList.add('hidden');
    disconnected.classList.remove('hidden');
  }
}

function updateSettingsNamingPreview() {
  const template = $('#input-naming-template').value;
  const preview = resolveNamingTemplate(template, 'BrandRefresh');
  $('#settings-naming-preview').textContent = preview;
}

// ===== Render Footer =====
function renderFooter() {
  const used = Number(state.usage.packagesThisMonth) || 0;
  $('#footer-usage').textContent = `${used} of 10 packages used this month`;
}

// ===== Package Flow =====
function showPackageModal() {
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) return;

  $('#modal-project-name').textContent = project.name;
  $('#modal-figma-scope').textContent = getProjectFigmaScopeLabel(project);
  const modalWarning = $('#modal-figma-warning');
  if (modalWarning) {
    const warning = getProjectFigmaWarning(project);
    modalWarning.textContent = warning;
    modalWarning.style.display = warning ? 'block' : 'none';
  }
  const presentationReminder = $('#modal-presentation-reminder');
  if (presentationReminder) {
    presentationReminder.classList.toggle('hidden', !isPresentationWorkflow(project));
  }

  // File list
  const fileListEl = $('#modal-file-list');
  fileListEl.innerHTML = '';

  const visibleFiles = project.files.slice(0, 4);
  for (const file of visibleFiles) {
    const item = document.createElement('div');
    item.className = 'modal-file-item';
    const emoji = getFileEmoji(file.ext);
    item.innerHTML = `<span>${emoji}</span>&nbsp;&nbsp;<span>${escapeHtml(file.name)}</span>`;
    fileListEl.appendChild(item);
  }

  if (project.files.length > 4) {
    const more = document.createElement('div');
    more.className = 'modal-file-item';
    more.style.color = '#9ca3af';
    more.style.fontSize = '11px';
    more.style.paddingTop = '6px';
    more.textContent = `+ ${project.files.length - 4} more files \u00B7 ${project.files.length} total`;
    fileListEl.appendChild(more);
  }

  // Folder name preview
  const folderName = resolveNamingTemplate(state.settings.namingTemplate, project.name);
  $('#modal-folder-name').textContent = folderName;

  // Destination
  $('#modal-dest-path').textContent = state.packageOutputPath || '~/Desktop/';

  $('#modal-package').classList.remove('hidden');
}

function formatFileCount(count, singular = 'file', plural = 'files') {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getPackageIssueMessage(error) {
  return typeof error === 'string' ? error.trim() : '';
}

function renderPackageDetails(result) {
  const details = $('#package-details');
  if (!details) return;

  details.open = false;
  if (!result || state.settings.showPackageDetails === false) {
    details.classList.add('hidden');
    return;
  }

  const copiedCount = Math.max(0, Number(result.copiedCount) || 0);
  const embeddedCount = Math.max(0, Number(result.embeddedCount) || 0);
  const includedCount = copiedCount + embeddedCount;
  const errors = Array.isArray(result.errors) ? result.errors : [];

  $('#package-details-included').textContent = `${formatFileCount(includedCount)} included`;

  const sources = [`Gathered files: ${copiedCount}`];
  if (embeddedCount > 0) sources.push(`Extracted media: ${embeddedCount}`);
  $('#package-details-sources').textContent = sources.join(' | ');

  $('#package-details-review').textContent = errors.length === 0
    ? 'No issues found'
    : `${formatFileCount(errors.length, 'issue', 'issues')} need review`;

  const issuesEl = $('#package-details-issues');
  if (issuesEl) {
    issuesEl.innerHTML = '';
    const issueMessages = errors.map(getPackageIssueMessage).filter(Boolean);
    for (const message of issueMessages) {
      const item = document.createElement('li');
      item.textContent = message;
      issuesEl.appendChild(item);
    }
    issuesEl.classList.toggle('hidden', issueMessages.length === 0);
  }

  details.classList.remove('hidden');
}

async function confirmPackage() {
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) return;

  $('#modal-package').classList.add('hidden');

  // M5: Show folder picker FIRST (before progress modal) to avoid flicker on cancel
  let outputPath = state.packageOutputPath;
  if (!outputPath) {
    outputPath = await window.crate.selectOutputFolder();
    if (!outputPath) {
      return;
    }
    state.packageOutputPath = outputPath;
  }

  // Now show progress — user has confirmed a destination
  $('#modal-progress').classList.remove('hidden');

  // Run pre-scan now (user already confirmed, progress spinner is showing)
  // FIX 2 (C2): Increased timeout from 5s to 12s to accommodate scan + package coordination
  const scanResult = await Promise.race([
    window.crate.preScanSession(project.id),
    new Promise(resolve => setTimeout(() => resolve(null), 12000))
  ]);
  if (scanResult) {
    state.projects = await window.crate.getProjects();
  }

  const result = await window.crate.packageProject(project.id, outputPath);

  $('#modal-progress').classList.add('hidden');

  if (result.error === 'limit_reached') {
    $('#upgrade-days-left').textContent = result.daysLeft;
    $('#modal-upgrade').classList.remove('hidden');
    return;
  }

  if (result.error) {
    alert('Error packaging: ' + result.error);
    return;
  }

  // Show success — v2.5.0: final accurate count shown only after packaging
  const totalPackaged = (result.copiedCount || 0) + (result.embeddedCount || 0);
  $('#success-message').textContent = `${totalPackaged} file${totalPackaged !== 1 ? 's' : ''} packaged. Your project is ready to archive or hand off.`;
  $('#success-path').textContent = result.folderPath;
  renderPackageDetails(result);
  state.lastPackagedPath = result.folderPath;
  $('#modal-success').classList.remove('hidden');

  // Refresh data
  state.projects = await window.crate.getProjects();
  state.usage = await window.crate.getUsage();
  renderFiles();
  renderFooter();
}

// ===== Delete Project =====
function showDeleteConfirmation(projectId, projectName) {
  state.pendingDeleteId = projectId;
  $('#delete-confirm-title').textContent = `Remove ${projectName} from Crate?`;
  $('#delete-confirm-desc').textContent = 'The files on your computer are not affected.';
  $('#modal-delete-confirm').classList.remove('hidden');
}

async function confirmDeleteProject() {
  if (!state.pendingDeleteId) return;

  await window.crate.deleteProject(state.pendingDeleteId);

  // If we deleted the selected project, clear selection
  if (state.selectedProjectId === state.pendingDeleteId) {
    state.selectedProjectId = null;
  }

  state.pendingDeleteId = null;
  state.projects = await window.crate.getProjects();
  $('#modal-delete-confirm').classList.add('hidden');
  renderProjects();
  renderFooter();
}

// ===== Clear All Projects =====
async function confirmClearAll() {
  await window.crate.deleteAllProjects();
  state.selectedProjectId = null;
  state.projects = await window.crate.getProjects();
  $('#modal-clear-all').classList.add('hidden');
  renderProjects();
  renderFooter();
}

// ===== Event Listeners =====
function setupEventListeners() {
  if (rendererEventListenersBound) return;
  rendererEventListenersBound = true;

  // Tab switching
  $$('.app-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // New project buttons
  $('#btn-start-project').addEventListener('click', showNewProjectForm);
  $('#btn-add-project').addEventListener('click', showNewProjectForm);
  $('#btn-cancel-project').addEventListener('click', hideNewProjectForm);
  $('#btn-create-project').addEventListener('click', createProject);

  // Project type selector
  $$('.type-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      $$('.type-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.projectType = pill.dataset.type;
    });
  });

  // Project name input -> update preview
  $('#input-project-name').addEventListener('input', updateNamingPreview);

  // Enter key in project name
  $('#input-project-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createProject();
    if (e.key === 'Escape') hideNewProjectForm();
  });

  // Files tab
  $('#btn-add-files').addEventListener('click', async () => {
    if (!state.selectedProjectId) {
      showToast('Select a project first');
      return;
    }
    const files = await window.crate.addFiles(state.selectedProjectId);
    if (files) {
      state.projects = await window.crate.getProjects();
      renderFiles();
    }
  });

  $('#btn-package').addEventListener('click', async () => {
    const projectId = state.selectedProjectId;
    if (!projectId) return;

    const project = state.projects.find(p => p.id === projectId);
    if (!project || project.files.length === 0) {
      showToast('No files captured yet. Keep watching or tap + Files to add manually.');
      return;
    }
    // M4: Confirm before re-packaging an already-packaged project
    if (project.status === 'packaged') {
      const ok = confirm('This project was already packaged. Package again?');
      if (!ok) return;
    }
    showPackageModal();
  });

  // Package modal
  $('#btn-cancel-package').addEventListener('click', () => {
    $('#modal-package').classList.add('hidden');
  });

  $('#btn-confirm-package').addEventListener('click', confirmPackage);

  $('#btn-change-dest').addEventListener('click', async () => {
    const folder = await window.crate.selectOutputFolder();
    if (folder) {
      state.packageOutputPath = folder;
      $('#modal-dest-path').textContent = folder;
    }
  });

  // Success modal
  $('#btn-success-done').addEventListener('click', () => {
    $('#modal-success').classList.add('hidden');
    switchTab('projects');
  });

  $('#btn-open-folder').addEventListener('click', () => {
    if (state.lastPackagedPath) {
      window.crate.openFolder(state.lastPackagedPath);
    }
    $('#modal-success').classList.add('hidden');
    switchTab('projects');
  });

  // Upgrade modal
  $('#btn-dismiss-upgrade').addEventListener('click', () => {
    $('#modal-upgrade').classList.add('hidden');
  });

  // Settings
  $('#input-naming-template').addEventListener('input', updateSettingsNamingPreview);

  $('#input-naming-template').addEventListener('change', async () => {
    const input = $('#input-naming-template');
    const template = input.value;
    const updatedSettings = await window.crate.updateSetting('namingTemplate', template);
    state.settings = updatedSettings || state.settings;
    input.value = state.settings.namingTemplate || DEFAULT_NAMING_TEMPLATE;
    updateSettingsNamingPreview();
  });

  $('#toggle-notifications').addEventListener('change', () => {
    const checked = $('#toggle-notifications').checked;
    window.crate.updateSetting('notifications', checked);
  });

  $('#toggle-diagnostic-report').addEventListener('change', () => {
    const checked = $('#toggle-diagnostic-report').checked;
    window.crate.updateSetting('includeDiagnosticReport', checked);
    state.settings.includeDiagnosticReport = checked;
  });

  $('#toggle-package-details').addEventListener('change', () => {
    const checked = $('#toggle-package-details').checked;
    window.crate.updateSetting('showPackageDetails', checked);
    state.settings.showPackageDetails = checked;
  });

  // Clear all projects
  $('#btn-clear-all').addEventListener('click', () => {
    if (state.projects.length === 0) return;
    $('#modal-clear-all').classList.remove('hidden');
  });

  $('#btn-clear-all-cancel').addEventListener('click', () => {
    $('#modal-clear-all').classList.add('hidden');
  });

  $('#btn-clear-all-confirm').addEventListener('click', confirmClearAll);

  // Delete confirmation modal
  $('#btn-delete-cancel').addEventListener('click', () => {
    state.pendingDeleteId = null;
    $('#modal-delete-confirm').classList.add('hidden');
  });

  $('#btn-delete-confirm').addEventListener('click', confirmDeleteProject);

  // V2 Quick Package - Drop zone
  const dropZone = $('#v2-drop-zone');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const filePath = files[0].path;
        handleV2FileDrop(filePath);
      }
    });
  }

  // V2 Browse button
  $('#btn-v2-browse').addEventListener('click', async () => {
    const filePath = await window.crate.v2BrowseFile();
    if (filePath) {
      handleV2FileDrop(filePath);
    }
  });

  // V2 Results modal
  $('#btn-v2-done').addEventListener('click', () => {
    $('#modal-v2-results').classList.add('hidden');
    v2LastResult = null; // L8: release reference
  });

  $('#btn-v2-open-folder').addEventListener('click', () => {
    if (v2LastResult && v2LastResult.outputDir) {
      window.crate.openFolder(v2LastResult.outputDir);
    }
    $('#modal-v2-results').classList.add('hidden');
    v2LastResult = null; // L8: release reference
  });

  // Figma connect
  $('#btn-figma-connect').addEventListener('click', async () => {
    const token = $('#input-figma-token').value.trim();
    if (!token) {
      showToast('Please enter your Figma token');
      return;
    }
    const result = await window.crate.connectFigma(token);
    if (result.success) {
      $('#input-figma-token').value = '';
      renderFigmaSettings();
      showToast('Figma connected successfully');
    } else {
      showToast('Failed to save token');
    }
  });

  // Figma disconnect
  $('#btn-figma-disconnect').addEventListener('click', async () => {
    const result = await window.crate.disconnectFigma();
    if (result.success) {
      renderFigmaSettings();
      showToast('Figma disconnected');
    }
  });

  // Figma section toggle on new project form
  const figmaToggle = $('#figma-section-toggle');
  if (figmaToggle) {
    figmaToggle.addEventListener('click', () => {
      setFigmaSectionExpanded(!state.figmaSectionExpanded);
    });
  }

  // Per-project Edit Figma Link modal
  const editCancel = $('#btn-edit-figma-cancel');
  if (editCancel) {
    editCancel.addEventListener('click', closeEditFigmaLinkModal);
  }
  const editSave = $('#btn-edit-figma-save');
  if (editSave) {
    editSave.addEventListener('click', saveEditFigmaLinkModal);
  }

  // Figma scan now
  $('#btn-figma-scan-now').addEventListener('click', async () => {
    if (state.figmaScanInFlight) return;

    setFigmaScanButtonLoading(true);
    updateFigmaScanStatus({ phase: 'started', timestamp: Date.now(), source: 'manual' });

    try {
      const result = await window.crate.figmaScanNow();
      if (result.triggered === 0) {
        if (result.inFlight || result.skipped > 0) {
          showToast('Figma scan already in progress');
        } else {
          showToast('No active projects to scan');
        }
      }
    } catch (e) {
      showToast('Scan failed: ' + (e.message || 'Unknown error'));
    } finally {
      setFigmaScanButtonLoading(false);
    }
  });

}

// ===== Edit Figma Link Modal (per-project) =====
function openEditFigmaLinkModal(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;
  state.editFigmaProjectId = projectId;

  const tracked = (project.figmaTrackedFiles || [])[0];
  const urlInput = $('#edit-figma-url');
  const scopeInput = $('#edit-figma-scope');
  const errorEl = $('#edit-figma-error');

  if (urlInput) urlInput.value = tracked && tracked.url ? tracked.url : '';
  if (scopeInput) {
    const scope = project.figmaScopeMode === 'entire-file' ? 'entire-file' : 'current-page';
    scopeInput.value = scope;
  }
  if (errorEl) {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }

  $('#modal-edit-figma-link').classList.remove('hidden');
  if (urlInput) urlInput.focus();
}

function closeEditFigmaLinkModal() {
  state.editFigmaProjectId = null;
  $('#modal-edit-figma-link').classList.add('hidden');
}

async function saveEditFigmaLinkModal() {
  const projectId = state.editFigmaProjectId;
  if (!projectId) return;

  const urlInput = $('#edit-figma-url');
  const scopeInput = $('#edit-figma-scope');
  const errorEl = $('#edit-figma-error');

  const rawUrl = urlInput ? urlInput.value.trim() : '';
  const scopeMode = scopeInput ? scopeInput.value : 'current-page';

  if (rawUrl && !isValidFigmaUrl(rawUrl)) {
    if (errorEl) {
      errorEl.textContent = "That doesn't look like a Figma file URL.";
      errorEl.style.display = 'block';
    }
    return;
  }

  const result = await window.crate.setProjectFigmaLink(projectId, {
    url: rawUrl || null,
    scopeMode
  });

  if (!result || !result.success) {
    if (errorEl) {
      errorEl.textContent = result && result.error === 'invalid_figma_url'
        ? 'Crate could not read that Figma URL. Please double-check and try again.'
        : 'Failed to save Figma link.';
      errorEl.style.display = 'block';
    }
    return;
  }

  state.projects = await window.crate.getProjects();
  closeEditFigmaLinkModal();
  renderFiles();
  renderProjects();
  showToast(rawUrl ? 'Figma link updated' : 'Figma link removed');
}

// ===== Tab State Helper =====
const isFilesTabActive = () => {
  const tab = document.querySelector("#tab-files");
  return tab && tab.classList.contains("active");
};

function setFigmaScanButtonLoading(isLoading) {
  const button = $('#btn-figma-scan-now');
  if (!button) return;
  state.figmaScanInFlight = isLoading;
  button.disabled = isLoading;
  button.textContent = isLoading ? 'Scanning...' : 'Scan Now';
}

// ===== Main Process Listeners =====
function setupMainProcessListeners() {
  if (mainProcessListenersBound) return;
  if (!window.crate) {
    logRendererError('preload bridge unavailable for main-process listeners', 'window.crate missing');
    return;
  }
  mainProcessListenersBound = true;

  // File updates from watcher
  window.crate.onFilesUpdated((data) => {
    window.crate.getProjects().then(projects => {
      state.projects = projects;
      if (state.selectedProjectId === data.projectId && isFilesTabActive()) {
        renderFiles();
      }
      renderProjects();
    });
  });

  // Project updated (e.g. from notification action)
  window.crate.onProjectUpdated(async (data) => {
    state.projects = await window.crate.getProjects();
    renderProjects();
    if (state.selectedProjectId === data.projectId && isFilesTabActive()) {
      renderFiles();
    }
  });

  // Tier 2 pending files updated from main process
  window.crate.onPendingFilesUpdated((data) => {
    window.crate.getProjects().then(projects => {
      state.projects = projects;
      if (state.selectedProjectId === data.projectId) {
        renderFiles();
      }
    });
  });

  // Handle "Package Now" from inactivity dialog
  // FIX 5 (H4): Run pre-scan before packaging, handle errors, show progress/success modals
  window.crate.onPackageTrigger(async (data) => {
    const project = state.projects.find(p => p.id === data.projectId);
    if (project) {
      state.selectedProjectId = data.projectId;
      const outputPath = await window.crate.selectOutputFolder();
      if (outputPath) {
        $('#modal-progress').classList.remove('hidden');

        // Run pre-scan with 12s timeout (same as confirmPackage)
        const scanResult = await Promise.race([
          window.crate.preScanSession(data.projectId),
          new Promise(resolve => setTimeout(() => resolve(null), 12000))
        ]);
        if (scanResult) {
          state.projects = await window.crate.getProjects();
        }

        const result = await window.crate.packageProject(data.projectId, outputPath);

        $('#modal-progress').classList.add('hidden');

        if (result.error === 'limit_reached') {
          $('#upgrade-days-left').textContent = result.daysLeft;
          $('#modal-upgrade').classList.remove('hidden');
          return;
        }

        if (result.error) {
          alert('Error packaging: ' + result.error);
          return;
        }

        // Show success — v2.5.0: final accurate count
        const totalPackaged = (result.copiedCount || 0) + (result.embeddedCount || 0);
        $('#success-message').textContent = `${totalPackaged} file${totalPackaged !== 1 ? 's' : ''} packaged. Your project is ready to archive or hand off.`;
        $('#success-path').textContent = result.folderPath;
        renderPackageDetails(result);
        state.lastPackagedPath = result.folderPath;
        $('#modal-success').classList.remove('hidden');

        state.projects = await window.crate.getProjects();
        state.usage = await window.crate.getUsage();
        renderProjects();
        renderFiles();
        renderFooter();
      }
    }
  });

  // Figma auth error notification
  window.crate.onFigmaAuthError((data) => {
    showToast(data.error || 'Figma token expired — reconnect in Settings');
    renderFigmaSettings();
  });

  window.crate.onFigmaScanStarted((data) => {
    updateFigmaScanStatus({ ...data, phase: 'started' });
  });

  // Figma scan complete notification
  window.crate.onFigmaScanComplete((data) => {
    if (data.warning) {
      if (state.lastFigmaWarning !== data.warning) {
        showToast(data.warning);
        state.lastFigmaWarning = data.warning;
      }
    } else if (data.addedCount > 0) {
      state.lastFigmaWarning = null;
      showToast(`Figma scan: ${data.addedCount} new asset${data.addedCount !== 1 ? 's' : ''} added`);
    }
    // Update scan status line
    updateFigmaScanStatus(data);
  });

  // Figma scan error notification
  window.crate.onFigmaScanError((data) => {
    showToast(`Figma scan error: ${data.error || 'Unknown error'}`);
    updateFigmaScanStatus({ errors: [data.error || 'Unknown error'], timestamp: Date.now() });
  });
}

// ===== Figma Scan Status =====
function updateFigmaScanStatus(data) {
  const el = $('#figma-scan-status');
  if (!el) return;

  const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : 'just now';
  if (data.phase === 'started') {
    el.style.color = '#60a5fa';
    el.textContent = `Scan started (${time})...`;
    return;
  }

  const warning = data.warning || '';
  const errors = data.errors || [];
  const candidateSummary = formatFigmaCandidateDiagnostics(data.candidateDiagnostics);
  const candidateSuffix = candidateSummary ? ` ${candidateSummary}` : '';
  if (warning) {
    el.style.color = '#f59e0b';
    el.textContent = `Last scan (${time}): ${data.filesFound || 0} files, ${data.assetsFound || 0} assets — ${warning}${candidateSuffix}`;
  } else if (errors.length > 0) {
    el.style.color = '#f59e0b';
    el.textContent = `Last scan (${time}): ${data.filesFound || 0} files, ${data.assetsFound || 0} assets — ${errors[0]}${candidateSuffix}`;
  } else {
    el.style.color = '#9ca3af';
    el.textContent = `Scan completed (${time}): ${data.filesFound || 0} files, ${data.assetsFound || 0} assets, ${data.addedCount || 0} new${candidateSuffix}`;
  }
}

function countFrom(summary, group, key) {
  const values = summary && summary[group];
  const count = values && Number.isFinite(values[key]) ? values[key] : 0;
  return count;
}

function formatFigmaCandidateDiagnostics(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const candidateCount = Number.isFinite(summary.candidateCount) ? summary.candidateCount : 0;
  if (candidateCount <= 0) return '';

  const metadataFailed = countFrom(summary, 'metadataStatusCounts', 'failed');
  const metadataSucceeded = countFrom(summary, 'metadataStatusCounts', 'success');
  const fileFetchFailed = countFrom(summary, 'fileFetchStatusCounts', 'failed');
  const fileFetchSucceeded = countFrom(summary, 'fileFetchStatusCounts', 'success');
  const withPageOrNode = summary.parsedScopeCounts && Number.isFinite(summary.parsedScopeCounts.withPageOrNode)
    ? summary.parsedScopeCounts.withPageOrNode
    : 0;
  const sourceParts = summary.candidateSourceCounts && typeof summary.candidateSourceCounts === 'object'
    ? Object.entries(summary.candidateSourceCounts)
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .map(([source, count]) => `${String(source).replace(/[^\w:.-]/g, '_').slice(0, 40)} ${count}`)
      .slice(0, 4)
    : [];
  const safeCountParts = (counts) => counts && typeof counts === 'object'
    ? Object.entries(counts)
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .map(([reason, count]) => `${String(reason).replace(/[^\w:.-]/g, '_').slice(0, 40)} ${count}`)
      .slice(0, 4)
    : [];
  const metadataReasonParts = safeCountParts(summary.metadataFailureReasonCounts);
  const fileFetchReasonParts = safeCountParts(summary.fileFetchFailureReasonCounts);

  const parts = [`Figma candidate check: ${candidateCount} candidate${candidateCount === 1 ? '' : 's'}`];
  if (sourceParts.length > 0) parts.push(`sources ${sourceParts.join(', ')}`);
  parts.push(`page/node parsed ${withPageOrNode}`);
  parts.push(`metadata ok ${metadataSucceeded}/failed ${metadataFailed}`);
  if (metadataReasonParts.length > 0) parts.push(`metadata reasons ${metadataReasonParts.join(', ')}`);
  parts.push(`file ok ${fileFetchSucceeded}/failed ${fileFetchFailed}`);
  if (fileFetchReasonParts.length > 0) parts.push(`file reasons ${fileFetchReasonParts.join(', ')}`);
  return `(${parts.join('; ')})`;
}

// ===== Toast =====
function showToast(message) {
  let toast = $('#toast-message');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast-message';
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#1f2937',
      color: '#fff',
      padding: '10px 18px',
      borderRadius: '8px',
      fontSize: '12px',
      zIndex: '9999',
      opacity: '0',
      transition: 'opacity 0.3s ease',
      pointerEvents: 'none',
      maxWidth: '90%',
      textAlign: 'center'
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// ===== V2 Results Modal =====
let v2LastResult = null;

function showV2Results(result) {
  v2LastResult = result;

  const masterName = result.masterFile.split('/').pop();
  $('#v2-result-subtitle').textContent = masterName;

  // Stats
  const statsEl = $('#v2-result-stats');
  statsEl.innerHTML = `
    <div class="v2-result-stat">
      <span class="v2-result-stat-label">Assets found</span>
      <span class="v2-result-stat-value">${result.assetsFound}</span>
    </div>
    <div class="v2-result-stat">
      <span class="v2-result-stat-label">Assets copied</span>
      <span class="v2-result-stat-value">${result.assetsCopied}</span>
    </div>
  `;

  // Missing assets
  const missingEl = $('#v2-result-missing');
  if (result.assetsMissing && result.assetsMissing.length > 0) {
    missingEl.innerHTML = `
      <div class="v2-result-missing-header">\u26A0 Missing Assets</div>
      <div class="v2-result-missing-list">
        ${result.assetsMissing.map(m => `<div class="v2-result-missing-item" title="${escapeHtml(m.path)}">${escapeHtml(m.path.split('/').pop())}</div>`).join('')}
      </div>
    `;
  } else {
    missingEl.innerHTML = '';
  }

  $('#modal-v2-results').classList.remove('hidden');
}

let v2PackageInFlight = false;
async function handleV2FileDrop(filePath) {
  if (!filePath || v2PackageInFlight) return;
  v2PackageInFlight = true;

  try {
    $('#modal-progress').classList.remove('hidden');

    const result = await window.crate.v2PackageFile(filePath);

    $('#modal-progress').classList.add('hidden');

    if (result.error === 'limit_reached') {
      $('#upgrade-days-left').textContent = result.daysLeft;
      $('#modal-upgrade').classList.remove('hidden');
      return;
    }

    if (result.error) {
      showToast('Error: ' + result.error);
      return;
    }

    showV2Results(result);
    state.usage = await window.crate.getUsage();
    renderFooter();
  } finally {
    v2PackageInFlight = false;
  }
}

// ===== Helpers =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Start =====
document.addEventListener('DOMContentLoaded', init);

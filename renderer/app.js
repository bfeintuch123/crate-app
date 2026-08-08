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
  packageReviewToken: null,
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
let packageReviewOpener = null;
let packageReviewConfirmationInFlight = false;
let upgradeModalOpener = null;
let existingAssetsDecisionRequest = null;
let existingAssetsModalProjectId = null;
let existingAssetsDecisionOpener = null;

function redactRendererPrivatePaths(value) {
  // Delimiters and line breaks may appear in filenames, so redact the value tail.
  return String(value).replace(
    /["'`]?(?:\/Users|\/Volumes|\/private\/(?:tmp|var)|\/tmp|\/var)\/[\s\S]*/i,
    '[redacted-path]'
  );
}

function redactRendererCredentialText(value) {
  return String(value)
    .replace(/(["'])[^"'\\\r\n]*(?:token|secret|authorization|authentication|bearer|cookie|auth|password|credential|signature|api[_-]?key)[^"'\\\r\n]*\1\s*:\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')/gi, '[redacted-credential]')
    .replace(/\b(?:Authorization|X-Figma-Token|Cookie|Set-Cookie)\b(?:\s*[:=]\s*|\s+)[^\r\n]*/gi, '[redacted-credential]')
    .replace(/\b[A-Za-z0-9._-]*(?:token|secret|authorization|authentication|bearer|cookie|auth|password|credential|signature|api[_-]?key)[A-Za-z0-9._-]*\b\s*[:=]\s*[^,;)}\]\r\n]+/gi, '[redacted-credential]')
    .replace(/\bBearer\s+[^\r\n]*/gi, '[redacted-credential]')
    .replace(/[A-Za-z0-9._-]*(token|secret|authorization|bearer|cookie|auth|password|credential|signature)[A-Za-z0-9._-]*/gi, '[redacted-sensitive]');
}

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

  return redactRendererPrivatePaths(
    redactRendererCredentialText(
      text.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    )
  );
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
  const normalizedTab = tabName === 'files' ? 'current-project' : tabName;

  $$('.app-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === normalizedTab));
  $$('.tab-content').forEach(tc => {
    tc.classList.toggle('active', tc.id === `tab-${normalizedTab}`);
  });

  if (normalizedTab === 'current-project') {
    renderFiles();
  } else if (normalizedTab === 'settings') {
    renderSettings();
  } else if (normalizedTab === 'projects') {
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

    // Click row -> go to Current Project
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('project-pill') || e.target.classList.contains('project-delete')) return;
      state.selectedProjectId = project.id;
      switchTab('current-project');
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
  const excluded = new Set(project.excludedAssetKeys || []);
  const fileCount = (project.files || []).filter(file => !excluded.has(getAssetReviewExclusionKey(file))).length;
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
  switchTab('current-project');
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

function isFigmaFile(file) {
  if (!file || typeof file !== 'object') return false;
  if (file.source === 'figma-auto' || file.source === 'fig-scan') return true;
  return Boolean(file.figmaFileKey || file.figmaAssetKey || file.figmaPageId || file.figmaPageName);
}

function projectHasFigmaContext(project) {
  if (!project || typeof project !== 'object') return false;
  const trackedFiles = Array.isArray(project.figmaTrackedFiles) ? project.figmaTrackedFiles : [];
  const sessionTrackedFiles = project.figmaSession && Array.isArray(project.figmaSession.trackedFiles)
    ? project.figmaSession.trackedFiles
    : [];
  if (trackedFiles.length > 0) return true;
  if (sessionTrackedFiles.length > 0) return true;
  const files = Array.isArray(project.files) ? project.files : [];
  const pendingFiles = Array.isArray(project.pendingFiles) ? project.pendingFiles : [];
  return [
    ...files,
    ...pendingFiles
  ].some(isFigmaFile);
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

function renderFigmaWarningCard(container, warning) {
  if (!container) return;
  const message = typeof warning === 'string' ? warning.trim() : '';
  container.innerHTML = '';
  container.className = 'figma-warning-card hidden';

  if (!message) return;

  const safeMessage = sanitizeRendererLogText(message);
  const lowerMessage = message.toLowerCase();
  const isRateLimited = lowerMessage.includes('rate') || lowerMessage.includes('429') || lowerMessage.includes('cooldown');
  const title = isRateLimited ? 'Figma rate limiting' : 'File cannot be read';
  const action = isRateLimited
    ? 'Crate will retry after Figma allows the request.'
    : 'Reconnect Figma or check file access.';

  container.classList.remove('hidden');

  const titleEl = document.createElement('div');
  titleEl.className = 'figma-warning-title';
  titleEl.textContent = title;

  const actionEl = document.createElement('div');
  actionEl.className = 'figma-warning-copy';
  actionEl.textContent = action;

  const statusEl = document.createElement('div');
  statusEl.className = 'figma-warning-status';
  statusEl.textContent = 'Blocked';

  const noteTitle = document.createElement('div');
  noteTitle.className = 'figma-warning-title';
  noteTitle.textContent = 'Do not package yet';

  const noteCopy = document.createElement('div');
  noteCopy.className = 'figma-warning-copy';
  noteCopy.textContent = safeMessage;

  container.append(titleEl, actionEl, statusEl, noteTitle, noteCopy);
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
    noProject.innerHTML = '<div class="app-empty-icon">&#x1F4C2;</div><div class="app-empty-title">No project selected</div><div class="app-empty-desc">Choose a project or start a new one.</div>';
    noProject.classList.remove('hidden');
    filesView.classList.add('hidden');
    return;
  }

  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) {
    noProject.innerHTML = '<div class="app-empty-icon">&#x1F4C2;</div><div class="app-empty-title">No project selected</div><div class="app-empty-desc">Choose a project or start a new one.</div>';
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
  const fileCountExcludedKeys = new Set(project.excludedAssetKeys || []);
  const fileCount = (project.files || []).filter(file => (
    !fileCountExcludedKeys.has(getAssetReviewExclusionKey(file))
  )).length;

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
    renderFigmaWarningCard(figmaWarningText, warning);
  }

  const excludedAssetKeys = new Set(project.excludedAssetKeys || []);
  const visibleFiles = (project.files || []).filter(file => !excludedAssetKeys.has(getAssetReviewExclusionKey(file)));
  const visiblePendingFiles = (project.pendingFiles || []).filter(file => !excludedAssetKeys.has(getAssetReviewExclusionKey(file)));

  // Pending files (Tier 2)
  renderPendingFiles(project);

  // File list
  renderFileList(visibleFiles, {
    hasActiveCandidates: visiblePendingFiles.length > 0,
  });

  // Package button — always enabled; click handler shows toast if no files
  const packageBtn = $('#btn-package');
  packageBtn.disabled = false;

  syncExistingAssetsDecisionModal(project);
}

function getAssetReviewExclusionKey(file) {
  if (!file || typeof file !== 'object') return null;
  if (typeof file.fileId === 'string' && file.fileId) return file.fileId;
  return typeof file.path === 'string' && file.path ? file.path : null;
}

function getExistingAssetsForDecision(project) {
  if (!project || typeof project !== 'object') return [];
  const excluded = new Set(project.excludedAssetKeys || []);
  return [...(project.files || []), ...(project.pendingFiles || [])].filter(file => {
    const key = getAssetReviewExclusionKey(file);
    return file && file.assetOrigin === 'existing' && file.projectRole === 'asset' && !excluded.has(key);
  });
}

function getExistingAssetsDecisionFocusableElements() {
  return ['btn-skip-existing-assets', 'btn-include-existing-assets']
    .map(id => $(`#${id}`))
    .filter(element => element && !element.disabled);
}

function setExistingAssetsDecisionButtonsDisabled(disabled) {
  for (const id of ['btn-skip-existing-assets', 'btn-include-existing-assets']) {
    const button = $(`#${id}`);
    if (button) button.disabled = disabled;
  }
}

function handleExistingAssetsDecisionKeydown(event) {
  const modal = $('#modal-existing-assets');
  if (!modal || modal.classList.contains('hidden') || event.key !== 'Tab') return;
  const focusable = getExistingAssetsDecisionFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    modal.focus();
    return;
  }
  const activeIndex = focusable.indexOf(document.activeElement);
  const movingBeforeFirst = event.shiftKey && activeIndex <= 0;
  const movingPastLast = !event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1);
  if (!movingBeforeFirst && !movingPastLast) return;
  event.preventDefault();
  focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
}

function hideExistingAssetsDecisionModal() {
  const modal = $('#modal-existing-assets');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.removeEventListener('keydown', handleExistingAssetsDecisionKeydown);
  existingAssetsModalProjectId = null;
  setModalBackgroundState(false);
  if (existingAssetsDecisionOpener && typeof existingAssetsDecisionOpener.focus === 'function') {
    existingAssetsDecisionOpener.focus();
  }
  existingAssetsDecisionOpener = null;
}

function showExistingAssetsDecisionModal(project) {
  const modal = $('#modal-existing-assets');
  if (!modal || !project) return;
  const assets = getExistingAssetsForDecision(project);
  if (assets.length === 0) return;

  if (modal.classList.contains('hidden')) {
    existingAssetsDecisionOpener = document.activeElement;
  }
  existingAssetsModalProjectId = project.id;
  const decisionInFlightForProject = existingAssetsDecisionRequest &&
    existingAssetsDecisionRequest.projectId === project.id;
  $('#existing-assets-modal-count').textContent = `${assets.length} existing asset${assets.length === 1 ? '' : 's'} found`;
  const list = $('#existing-assets-modal-list');
  list.innerHTML = '';
  for (const file of assets.slice(0, 4)) {
    const item = document.createElement('div');
    item.className = 'existing-assets-modal-item';
    item.setAttribute('role', 'listitem');
    item.innerHTML = `<span class="app-file-icon">${getFileEmoji(getFileExtension(file))}</span><span>${escapeHtml(file.name || 'Untitled asset')}</span>`;
    list.appendChild(item);
  }
  if (assets.length > 4) {
    const more = document.createElement('div');
    more.className = 'existing-assets-modal-more';
    more.textContent = `+ ${assets.length - 4} more`;
    list.appendChild(more);
  }

  setModalBackgroundState(true);
  modal.classList.remove('hidden');
  modal.removeEventListener('keydown', handleExistingAssetsDecisionKeydown);
  modal.addEventListener('keydown', handleExistingAssetsDecisionKeydown);
  setExistingAssetsDecisionButtonsDisabled(!!decisionInFlightForProject);
  ($('#btn-include-existing-assets') || modal).focus();
}

function syncExistingAssetsDecisionModal(project) {
  const requiresDecision = project && project.assetBaseline && project.assetBaseline.status === 'decision-required';
  if (!requiresDecision) {
    if (existingAssetsModalProjectId) hideExistingAssetsDecisionModal();
    return;
  }
  if (existingAssetsModalProjectId === project.id && !$('#modal-existing-assets').classList.contains('hidden')) return;
  showExistingAssetsDecisionModal(project);
}

async function submitExistingAssetsDecision(decision) {
  if (!existingAssetsModalProjectId) return;
  const projectId = existingAssetsModalProjectId;
  if (existingAssetsDecisionRequest && existingAssetsDecisionRequest.projectId === projectId) return;
  const request = { projectId };
  existingAssetsDecisionRequest = request;
  const buttons = getExistingAssetsDecisionFocusableElements();
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await window.crate.setExistingAssetsDecision(projectId, decision);
    if (!result || !result.success) {
      showToast('Crate could not save that choice. Try again.');
      return;
    }
    state.projects = await window.crate.getProjects();
    if (existingAssetsModalProjectId === projectId) hideExistingAssetsDecisionModal();
    if (state.selectedProjectId === projectId && isFilesTabActive()) {
      await renderFiles();
    } else if (document.querySelector('#tab-projects')?.classList.contains('active')) {
      renderProjects();
    }
  } catch (error) {
    logRendererError('existing assets decision failed', error);
    showToast('Crate could not save that choice. Try again.');
  } finally {
    if (existingAssetsDecisionRequest === request) {
      existingAssetsDecisionRequest = null;
      if (existingAssetsModalProjectId === projectId) {
        setExistingAssetsDecisionButtonsDisabled(false);
        ($('#btn-include-existing-assets') || $('#modal-existing-assets'))?.focus();
      }
    }
  }
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
      const excluded = new Set(project && project.excludedAssetKeys || []);
      const currentFiles = project
        ? (project.files || []).filter(file => !excluded.has(getAssetReviewExclusionKey(file)))
        : files;
      const hasActiveCandidates = !!(project && (project.pendingFiles || []).some(file => (
        !excluded.has(getAssetReviewExclusionKey(file))
      )));
      renderFileList(currentFiles, {
        hasActiveCandidates,
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

  const excluded = new Set(project.excludedAssetKeys || []);
  const pending = (project.pendingFiles || []).filter(file => !excluded.has(getAssetReviewExclusionKey(file)));

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
  const packageLimit = Number(state.usage.packageLimit || state.usage.limit) || 10;
  const planName = state.usage.planName || 'Free';
  const planId = state.usage.planId || 'free';
  const planTitle = $('#plan-title');
  const planBadge = $('#plan-badge');
  if (planTitle) planTitle.textContent = planName;
  $('#plan-info').textContent = `${packageLimit} packages/month \u00B7 ${used}/${packageLimit} used`;
  if (planBadge) {
    const isClosedBeta = planId === 'closed-beta';
    planBadge.textContent = isClosedBeta ? 'Beta tester' : 'Current plan';
    planBadge.className = `quota-state-badge ${isClosedBeta ? 'beta' : 'upgrade'}`;
  }
  const limitState = $('#quota-limit-state');
  if (limitState) {
    const isBlocked = used >= packageLimit;
    limitState.textContent = isBlocked ? 'Blocked' : 'Available';
    limitState.className = `quota-state-badge ${isBlocked ? 'blocked' : 'available'}`;
  }

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

    // Update project-link stats
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
  const packageLimit = Number(state.usage.packageLimit || state.usage.limit) || 10;
  const planName = state.usage.planName || 'Free';
  const planTitle = $('#sidebar-plan-title');
  if (planTitle) planTitle.textContent = planName;
  $('#footer-usage').textContent = `${used} of ${packageLimit} packages used this month`;
}

const PACKAGE_LIMIT_COMPETING_MODAL_IDS = [
  'modal-existing-assets',
  'modal-package',
  'modal-success',
  'modal-progress',
  'modal-delete-confirm',
  'modal-edit-figma-link',
  'modal-clear-all',
  'modal-v2-results',
];

function getPackageLimitFocusableElements() {
  const modal = $('#modal-upgrade');
  if (!modal) return [];
  if (typeof modal.querySelectorAll === 'function') {
    return [...modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.disabled && element.getAttribute?.('aria-hidden') !== 'true');
  }
  const dismissButton = $('#btn-dismiss-upgrade');
  return dismissButton && !dismissButton.disabled ? [dismissButton] : [];
}

function hidePackageLimitModal({ restoreFocus = true } = {}) {
  const modal = $('#modal-upgrade');
  modal.classList.add('hidden');
  modal.removeEventListener('keydown', handlePackageLimitKeydown);
  setModalBackgroundState(false);
  const opener = upgradeModalOpener;
  upgradeModalOpener = null;
  if (restoreFocus && opener && typeof opener.focus === 'function') opener.focus();
}

function handlePackageLimitKeydown(event) {
  const modal = $('#modal-upgrade');
  if (!modal || modal.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    hidePackageLimitModal();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = getPackageLimitFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    modal.focus();
    return;
  }
  const activeIndex = focusable.indexOf(document.activeElement);
  const movingBeforeFirst = event.shiftKey && activeIndex <= 0;
  const movingPastLast = !event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1);
  if (!movingBeforeFirst && !movingPastLast) return;
  event.preventDefault();
  focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
}

function showPackageLimitModal(result = {}, opener = document.activeElement || null) {
  const packageLimit = Number(result.packageLimit || state.usage.packageLimit || state.usage.limit) || 10;
  const title = $('#upgrade-title');
  if (title) title.textContent = `You've used all ${packageLimit} packages`;
  $('#upgrade-days-left').textContent = result.daysLeft;
  const modal = $('#modal-upgrade');
  state.packageReviewToken = null;
  for (const id of PACKAGE_LIMIT_COMPETING_MODAL_IDS) $(`#${id}`)?.classList.add('hidden');
  upgradeModalOpener = opener;
  setModalBackgroundState(true);
  modal.classList.remove('hidden');
  modal.removeEventListener('keydown', handlePackageLimitKeydown);
  modal.addEventListener('keydown', handlePackageLimitKeydown);
  const focusTarget = $('#btn-dismiss-upgrade') || getPackageLimitFocusableElements()[0] || modal;
  focusTarget.focus();
}

// ===== Package Flow =====
const PACKAGE_REVIEW_CHANGED_MESSAGE = 'Your project changed. Review the updated files before packaging.';
const PACKAGE_REVIEW_UNAVAILABLE_MESSAGE = 'Some files are unavailable. Resolve them before packaging.';
const PACKAGE_REVIEW_RECOVERY_MESSAGE = 'Packaging could not finish. Review the files and try again.';
const PACKAGE_SCAN_INCOMPLETE_MESSAGE = 'Crate could not finish checking project files. No package was created. Record the diagnostic below before retrying.';
const PACKAGE_REVIEW_DIAGNOSTIC_PHASES = new Set([
  'pre-package-discovery',
  'pre-package-app-scan',
  'pre-package-scan-in-flight',
  'package-input-scan-wait',
  'prepare-package-review',
]);

function setModalBackgroundState(blocked) {
  for (const id of ['app-sidebar', 'app-main']) {
    const element = $(`#${id}`);
    if (!element) continue;
    element.inert = blocked;
    if (blocked) element.setAttribute('aria-hidden', 'true');
    else element.removeAttribute('aria-hidden');
  }
}

function getPackageReviewFocusableElements() {
  const modal = $('#modal-package');
  if (!modal) return [];
  if (typeof modal.querySelectorAll === 'function') {
    return [...modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.disabled && element.getAttribute?.('aria-hidden') !== 'true');
  }
  return ['btn-change-dest', 'btn-cancel-package', 'btn-confirm-package']
    .map(id => $(`#${id}`))
    .filter(element => element && !element.disabled);
}

function focusPackageReviewDialog() {
  const reviewMessage = $('#modal-package-review-message');
  if (reviewMessage && !reviewMessage.classList.contains('hidden')) {
    reviewMessage.focus();
    return;
  }
  const cancelButton = $('#btn-cancel-package');
  const focusTarget = cancelButton && !cancelButton.disabled
    ? cancelButton
    : getPackageReviewFocusableElements()[0] || $('#modal-package');
  focusTarget?.focus();
}

function openPackageReviewDialog() {
  const modal = $('#modal-package');
  setModalBackgroundState(true);
  modal.classList.remove('hidden');
  focusPackageReviewDialog();
}

function hidePackageReviewDialog({ restoreFocus = false, preserveOpener = false } = {}) {
  $('#modal-package').classList.add('hidden');
  setModalBackgroundState(false);
  const opener = packageReviewOpener;
  if (!preserveOpener) packageReviewOpener = null;
  if (restoreFocus && opener && typeof opener.focus === 'function') opener.focus();
  return opener;
}

function getPackageSuccessFocusableElements() {
  const modal = $('#modal-success');
  if (!modal) return [];
  if (typeof modal.querySelectorAll === 'function') {
    return [...modal.querySelectorAll('button:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])')]
      .filter(element =>
        !element.disabled &&
        element.getAttribute?.('aria-hidden') !== 'true' &&
        !element.closest?.('.hidden')
      );
  }
  return ['btn-success-done', 'btn-open-folder']
    .map(id => $(`#${id}`))
    .filter(element => element && !element.disabled);
}

function hidePackageSuccessModal() {
  const modal = $('#modal-success');
  modal.classList.add('hidden');
  modal.removeEventListener('keydown', handlePackageSuccessKeydown);
  setModalBackgroundState(false);
  const opener = packageReviewOpener;
  packageReviewOpener = null;
  switchTab('projects');
  const projectsTab = $$('.app-tab').find(tab => tab.dataset.tab === 'projects');
  const focusTarget = projectsTab || opener;
  if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
}

function handlePackageSuccessKeydown(event) {
  const modal = $('#modal-success');
  if (!modal || modal.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    hidePackageSuccessModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = getPackageSuccessFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    modal.focus();
    return;
  }
  const activeIndex = focusable.indexOf(document.activeElement);
  const movingBeforeFirst = event.shiftKey && activeIndex <= 0;
  const movingPastLast = !event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1);
  if (!movingBeforeFirst && !movingPastLast) return;
  event.preventDefault();
  focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
}

function showPackageProgressModal() {
  const modal = $('#modal-progress');
  setModalBackgroundState(true);
  modal.classList.remove('hidden');
  modal.focus();
}

function hidePackageProgressModal() {
  $('#modal-progress').classList.add('hidden');
}

function showPackageSuccessModal() {
  const modal = $('#modal-success');
  setModalBackgroundState(true);
  modal.classList.remove('hidden');
  modal.removeEventListener('keydown', handlePackageSuccessKeydown);
  modal.addEventListener('keydown', handlePackageSuccessKeydown);
  const focusTarget = $('#btn-success-done') || getPackageSuccessFocusableElements()[0] || modal;
  focusTarget.focus();
}

function cancelPackageReview() {
  if (packageReviewConfirmationInFlight) return;
  state.packageReviewToken = null;
  hidePackageReviewDialog({ restoreFocus: true });
}

function handlePackageReviewKeydown(event) {
  const modal = $('#modal-package');
  if (!modal || modal.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    if (packageReviewConfirmationInFlight) return;
    event.preventDefault();
    cancelPackageReview();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = getPackageReviewFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    modal.focus();
    return;
  }
  const activeIndex = focusable.indexOf(document.activeElement);
  const movingBeforeFirst = event.shiftKey && activeIndex <= 0;
  const movingPastLast = !event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1);
  if (!movingBeforeFirst && !movingPastLast) return;
  event.preventDefault();
  focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
}

function renderPackageReview(project, review, message = '') {
  const canPackage = review.materializable !== false && typeof review.token === 'string';
  state.packageReviewToken = canPackage ? review.token : null;

  $('#modal-project-name').textContent = project.name;
  const hasFigmaContext = projectHasFigmaContext(project);
  const figmaScopeRow = $('#modal-figma-scope-row');
  const figmaScopeValue = $('#modal-figma-scope');
  if (figmaScopeRow) {
    figmaScopeRow.classList.toggle('hidden', !hasFigmaContext);
  }
  if (figmaScopeValue) {
    figmaScopeValue.textContent = hasFigmaContext ? getProjectFigmaScopeLabel(project) : '';
  }
  const modalWarning = $('#modal-figma-warning');
  if (modalWarning) {
    const warning = hasFigmaContext ? getProjectFigmaWarning(project) : '';
    modalWarning.textContent = warning;
    modalWarning.style.display = warning ? 'block' : 'none';
  }
  const presentationReminder = $('#modal-presentation-reminder');
  if (presentationReminder) {
    presentationReminder.classList.toggle('hidden', !isPresentationWorkflow(project));
  }
  const reviewMessage = $('#modal-package-review-message');
  if (reviewMessage) {
    const visibleMessage = message || review.message || '';
    reviewMessage.textContent = visibleMessage;
    reviewMessage.classList.toggle('hidden', !visibleMessage);
  }
  const confirmButton = $('#btn-confirm-package');
  if (confirmButton) confirmButton.disabled = !canPackage;

  // File list
  const fileListEl = $('#modal-file-list');
  fileListEl.innerHTML = '';

  const reviewFiles = Array.isArray(review.files) ? review.files : [];
  const visibleFiles = reviewFiles.slice(0, 4);
  for (const file of visibleFiles) {
    const item = document.createElement('div');
    item.className = 'modal-file-item';
    const emoji = getFileEmoji(file.ext);
    item.innerHTML = `<span>${emoji}</span>&nbsp;&nbsp;<span>${escapeHtml(file.name)}</span>`;
    fileListEl.appendChild(item);
  }

  if (reviewFiles.length > 4) {
    const more = document.createElement('div');
    more.className = 'modal-file-item';
    more.style.color = '#9ca3af';
    more.style.fontSize = '11px';
    more.style.paddingTop = '6px';
    more.textContent = `+ ${reviewFiles.length - 4} more files \u00B7 ${reviewFiles.length} total`;
    fileListEl.appendChild(more);
  }

  // Folder name preview
  const folderName = resolveNamingTemplate(state.settings.namingTemplate, project.name);
  $('#modal-folder-name').textContent = review.folderName || folderName;

  // Destination
  $('#modal-dest-path').textContent = state.packageOutputPath || '~/Desktop/';

  openPackageReviewDialog();
}

function createUnavailableRendererReview(project, message) {
  return {
    projectId: project?.id || state.selectedProjectId,
    files: (project?.files || []).map(file => ({
      name: typeof file?.name === 'string' && file.name ? file.name : 'Unavailable file',
      status: 'unavailable',
    })),
    totalFiles: Array.isArray(project?.files) ? project.files.length : 0,
    materializable: false,
    message,
  };
}

function getSafePackageReviewDiagnosticInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatPackageReviewDiagnosticSummary(error, diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return '';
  const errorCode = typeof error === 'string' && /^[a-z0-9_]{1,64}$/.test(error)
    ? error
    : null;
  if (!errorCode) return '';

  const parts = [`code ${errorCode}`];
  if (PACKAGE_REVIEW_DIAGNOSTIC_PHASES.has(diagnostics.failurePhase)) {
    parts.push(`phase ${diagnostics.failurePhase}`);
  }
  const metrics = [
    ['phaseElapsedMs', 'elapsed', ' ms'],
    ['candidateCount', 'candidates', ''],
    ['xattrResolvedCount', 'xattr resolved', ''],
    ['metadataFallbackCount', 'metadata fallback', ''],
  ];
  for (const [field, label, suffix] of metrics) {
    const value = getSafePackageReviewDiagnosticInteger(diagnostics[field]);
    if (value !== null) parts.push(`${label} ${value}${suffix}`);
  }
  return `Diagnostic: ${parts.join(' · ')}.`;
}

function getPackageReviewRecoveryMessage(error, diagnostics = null) {
  let message = PACKAGE_REVIEW_RECOVERY_MESSAGE;
  if (error === 'package_review_changed') message = PACKAGE_REVIEW_CHANGED_MESSAGE;
  else if (error === 'package_review_unavailable') message = PACKAGE_REVIEW_UNAVAILABLE_MESSAGE;
  else if (error === 'package_scan_incomplete') message = PACKAGE_SCAN_INCOMPLETE_MESSAGE;
  const diagnosticSummary = formatPackageReviewDiagnosticSummary(error, diagnostics);
  return diagnosticSummary ? `${message} ${diagnosticSummary}` : message;
}

async function showPackageModal({
  message = '',
  runPreScan = true,
  review: suppliedReview = null,
  outputPath: reviewedOutputPath,
} = {}) {
  const projectId = state.selectedProjectId;
  if (!projectId) return false;
  if (!packageReviewOpener && !packageReviewConfirmationInFlight) {
    packageReviewOpener = document.activeElement || null;
  }
  state.packageReviewToken = null;
  let project = state.projects.find(item => item.id === projectId) || null;

  try {
    if (runPreScan) {
      await Promise.race([
        window.crate.preScanSession(projectId),
        new Promise(resolve => setTimeout(() => resolve(null), 12000))
      ]);
    }

    const review = suppliedReview || await (
      reviewedOutputPath === undefined
        ? window.crate.preparePackageReview(projectId)
        : window.crate.preparePackageReview(projectId, reviewedOutputPath)
    );
    if (!review || review.error) {
      if (review?.error === 'asset_baseline_decision_required') {
        state.projects = await window.crate.getProjects();
        project = state.projects.find(item => item.id === projectId) || project;
        hidePackageReviewDialog({ restoreFocus: false, preserveOpener: true });
        if (project?.assetBaseline?.status === 'decision-required') {
          showExistingAssetsDecisionModal(project);
          return false;
        }
      }
      const failureMessage = message || getPackageReviewRecoveryMessage(
        review?.error || 'package_review_unavailable',
        review?.diagnostics
      );
      renderPackageReview(project, createUnavailableRendererReview(project, failureMessage), failureMessage);
      return false;
    }

    state.projects = await window.crate.getProjects();
    project = state.projects.find(item => item.id === projectId) || project;
    if (!project) return false;
    renderPackageReview(project, review, message);
    return true;
  } catch (error) {
    logRendererError('Package Review recovery failed', error);
    const failureMessage = message || PACKAGE_REVIEW_RECOVERY_MESSAGE;
    if (project) renderPackageReview(project, createUnavailableRendererReview(project, failureMessage), failureMessage);
    return false;
  }
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

  $('#package-details-sources').textContent = `${formatFileCount(copiedCount)} gathered`;
  const extractedEl = $('#package-details-extracted');
  if (extractedEl) {
    extractedEl.textContent = `${formatFileCount(embeddedCount, 'extracted media file', 'extracted media files')}`;
  }

  $('#package-details-review').textContent = errors.length === 0
    ? 'No issues found'
    : `${formatFileCount(errors.length, 'issue', 'issues')} need review`;

  const diagnosticsEl = $('#package-details-diagnostics');
  if (diagnosticsEl) {
    diagnosticsEl.textContent = state.settings.includeDiagnosticReport === true
      ? 'Diagnostics on'
      : 'Diagnostics off';
  }

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
  const confirmButton = $('#btn-confirm-package');
  if (!project || !state.packageReviewToken || confirmButton?.disabled) return;

  const reviewToken = state.packageReviewToken;
  if (confirmButton) confirmButton.disabled = true;
  packageReviewConfirmationInFlight = true;
  try {
    hidePackageReviewDialog({ preserveOpener: true });

    // M5: Show folder picker FIRST (before progress modal) to avoid flicker on cancel
    let outputPath = state.packageOutputPath;
    if (!outputPath) {
      outputPath = await window.crate.selectOutputFolder();
      if (!outputPath) {
        openPackageReviewDialog();
        return;
      }
      state.packageOutputPath = outputPath;
    }

    showPackageProgressModal();
    const scanResult = await Promise.race([
      window.crate.preScanSession(project.id),
      new Promise(resolve => setTimeout(() => resolve(null), 12000))
    ]);
    if (scanResult) state.projects = await window.crate.getProjects();

    state.packageReviewToken = null;
    const result = await window.crate.packageProject(project.id, outputPath, reviewToken);
    if (!result || result.error) {
      const typedError = result?.error || 'package_failed';
      if (typedError === 'limit_reached') {
        state.packageReviewToken = null;
        const opener = hidePackageReviewDialog();
        $('#modal-progress').classList.add('hidden');
        showPackageLimitModal(result, opener);
        return;
      }
      const suppliedReview = typedError === 'package_review_changed' ? result?.review || null : null;
      const destinationReviewRequired = !suppliedReview && (
        typedError === 'package_output_changed' || result?.reason === 'package_destination_changed'
      );
      const recoveryMessage = suppliedReview?.materializable === false
        ? suppliedReview.message || PACKAGE_REVIEW_UNAVAILABLE_MESSAGE
        : getPackageReviewRecoveryMessage(typedError, result?.diagnostics);
      hidePackageProgressModal();
      await showPackageModal({
        message: recoveryMessage,
        runPreScan: false,
        review: suppliedReview,
        outputPath: destinationReviewRequired ? outputPath : undefined,
      });
      return;
    }

    const totalPackaged = (result.copiedCount || 0) + (result.embeddedCount || 0);
    $('#success-message').textContent = `${totalPackaged} file${totalPackaged !== 1 ? 's' : ''} packaged. Your project is ready to archive or hand off.`;
    $('#success-path').textContent = result.folderPath;
    renderPackageDetails(result);
    state.lastPackagedPath = result.folderPath;
    hidePackageProgressModal();
    hidePackageReviewDialog({ preserveOpener: true });
    showPackageSuccessModal();

    try {
      state.projects = await window.crate.getProjects();
      state.usage = await window.crate.getUsage();
      renderFiles();
      renderFooter();
    } catch (refreshError) {
      logRendererError('Package completed, but the project summary could not refresh', refreshError);
    }
  } catch (error) {
    logRendererError('Package Review confirmation failed', error);
    state.packageReviewToken = null;
    hidePackageProgressModal();
    await showPackageModal({ message: PACKAGE_REVIEW_RECOVERY_MESSAGE, runPreScan: false });
  } finally {
    packageReviewConfirmationInFlight = false;
    hidePackageProgressModal();
    if (confirmButton) confirmButton.disabled = !state.packageReviewToken;
  }
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

  // Current Project tab
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
    if (project && project.assetBaseline && project.assetBaseline.status === 'decision-required') {
      showExistingAssetsDecisionModal(project);
      return;
    }
    if (!project || project.files.length === 0) {
      showToast('No files captured yet. Keep watching or tap + Add files to add manually.');
      return;
    }
    // M4: Confirm before re-packaging an already-packaged project
    if (project.status === 'packaged') {
      const ok = confirm('This project was already packaged. Package again?');
      if (!ok) return;
    }
    await showPackageModal();
  });

  // Package modal
  $('#btn-cancel-package').addEventListener('click', cancelPackageReview);
  $('#modal-package').addEventListener('keydown', handlePackageReviewKeydown);

  $('#btn-confirm-package').addEventListener('click', confirmPackage);

  $('#btn-include-existing-assets').addEventListener('click', () => submitExistingAssetsDecision('include'));
  $('#btn-skip-existing-assets').addEventListener('click', () => submitExistingAssetsDecision('skip'));

  $('#btn-change-dest').addEventListener('click', async () => {
    const folder = await window.crate.selectOutputFolder();
    if (folder) {
      state.packageOutputPath = folder;
      $('#modal-dest-path').textContent = folder;
    }
  });

  // Success modal
  $('#btn-success-done').addEventListener('click', hidePackageSuccessModal);

  $('#btn-open-folder').addEventListener('click', () => {
    if (state.lastPackagedPath) {
      window.crate.openFolder(state.lastPackagedPath);
    }
    hidePackageSuccessModal();
  });

  // Upgrade modal
  $('#btn-dismiss-upgrade').addEventListener('click', hidePackageLimitModal);

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
        await handleV2FileDrop(null, files[0]);
      }
    });
  }

  // V2 Browse button
  $('#btn-v2-browse').addEventListener('click', async () => {
    const filePath = await window.crate.v2BrowseFile();
    if (filePath) {
      await handleV2FileDrop(filePath);
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
    const connectButton = $('#btn-figma-connect');
    if (!token) {
      showToast('Please enter your Figma token');
      return;
    }

    connectButton.disabled = true;
    const previousLabel = connectButton.textContent;
    connectButton.textContent = 'Connecting...';
    try {
      const result = await window.crate.connectFigma(token);
      if (result.success) {
        $('#input-figma-token').value = '';
        renderFigmaSettings();
        showToast('Figma connected successfully');
      } else if (result.error === 'invalid_token') {
        showToast('Figma could not verify that connection. Check it and try again.');
      } else if (result.error === 'rate_limited') {
        showToast('Figma is temporarily limiting connection checks. Try again shortly.');
      } else if (result.error === 'secure_storage_unavailable') {
        showToast('Crate could not protect that connection on this Mac. Unlock your Mac and try again.');
      } else {
        showToast('Crate could not reach Figma. Nothing was saved.');
      }
    } catch (error) {
      logRendererError('Figma connection failed', error);
      showToast('Crate could not reach Figma. Nothing was saved.');
    } finally {
      connectButton.disabled = false;
      connectButton.textContent = previousLabel;
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
  const editRemove = $('#btn-edit-figma-remove');
  if (editRemove) {
    editRemove.addEventListener('click', removeEditFigmaLinkModal);
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
      showToast('Figma scan could not finish. Try again.');
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

  const urlInput = $('#edit-figma-url');
  const scopeInput = $('#edit-figma-scope');
  const errorEl = $('#edit-figma-error');
  const removeButton = $('#btn-edit-figma-remove');

  if (urlInput) urlInput.value = '';
  if (scopeInput) {
    const scope = project.figmaScopeMode === 'entire-file' ? 'entire-file' : 'current-page';
    scopeInput.value = scope;
  }
  if (removeButton) {
    const hasLink = Array.isArray(project.figmaTrackedFiles) && project.figmaTrackedFiles.length > 0;
    removeButton.classList.toggle('hidden', !hasLink);
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

async function persistFigmaLinkEdit(payload, successMessage) {
  const projectId = state.editFigmaProjectId;
  if (!projectId) return false;

  const errorEl = $('#edit-figma-error');
  const result = await window.crate.setProjectFigmaLink(projectId, payload);

  if (!result || !result.success) {
    if (errorEl) {
      errorEl.textContent = result && result.error === 'invalid_figma_url'
        ? 'Crate could not read that Figma URL. Please double-check and try again.'
        : 'Failed to save Figma link.';
      errorEl.style.display = 'block';
    }
    return false;
  }

  state.projects = await window.crate.getProjects();
  closeEditFigmaLinkModal();
  renderFiles();
  renderProjects();
  showToast(successMessage);
  return true;
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

  const payload = rawUrl
    ? { action: 'replace', url: rawUrl, scopeMode }
    : { action: 'preserve', scopeMode };
  await persistFigmaLinkEdit(payload, rawUrl ? 'Figma link updated' : 'Figma settings updated');
}

async function removeEditFigmaLinkModal() {
  const scopeInput = $('#edit-figma-scope');
  const scopeMode = scopeInput ? scopeInput.value : 'current-page';
  await persistFigmaLinkEdit({ action: 'remove', scopeMode }, 'Figma link removed');
}

// ===== Tab State Helper =====
const isFilesTabActive = () => {
  const tab = document.querySelector("#tab-current-project");
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

  // Notification-triggered packaging still requires the same authoritative review.
  window.crate.onPackageTrigger(async (data) => {
    state.projects = await window.crate.getProjects();
    const project = state.projects.find(p => p.id === data.projectId);
    if (project) {
      if (existingAssetsModalProjectId && existingAssetsModalProjectId !== data.projectId) {
        hideExistingAssetsDecisionModal();
      }
      state.selectedProjectId = data.projectId;
      if (project.assetBaseline && project.assetBaseline.status === 'decision-required') {
        showExistingAssetsDecisionModal(project);
        return;
      }
      await showPackageModal();
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
async function handleV2FileDrop(filePath, droppedFile = null) {
  if ((!filePath && !droppedFile) || v2PackageInFlight) return;
  v2PackageInFlight = true;

  try {
    $('#modal-progress').classList.remove('hidden');

    let result;
    try {
      result = droppedFile
        ? await window.crate.v2PackageDroppedFile(droppedFile)
        : await window.crate.v2PackageFile(filePath);
    } catch (_) {
      showToast('Crate could not package that file. Try again.');
      return;
    } finally {
      $('#modal-progress').classList.add('hidden');
    }

    if (result.error === 'limit_reached') {
      showPackageLimitModal(result);
      return;
    }

    if (result.error === 'file_unavailable') {
      showToast('Crate could not read that dropped file. Use Browse and try again.');
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

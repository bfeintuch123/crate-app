try {
  if (typeof window !== 'undefined' && typeof window.crate?.reportRendererScriptEntered === 'function') {
    window.crate.reportRendererScriptEntered();
  }
} catch (_) {}

// ===== Constants =====
const MAX_PROJECTS = 7;
const PROJECT_CREATION_REQUEST_TIMEOUT_MS = 30000;
const ADD_FILES_OPERATION_TIMEOUT_MS = 30000;
let rendererAddFilesOperationTimeoutMs = ADD_FILES_OPERATION_TIMEOUT_MS;
const PRESENTATION_FILE_EXTS = new Set(['.ppt', '.pptx', '.key']);
const PRIMARY_WORKING_FILE_EXTS = new Set([
  '.ai', '.psd', '.indd', '.idml', '.fig', '.sketch', '.xd',
  '.afdesign', '.afphoto', '.afpub', '.key', '.pptx', '.ppt', '.pxd',
]);
const DEFAULT_NAMING_TEMPLATE = '{Project}_{Date}';
const DEFAULT_PACKAGE_FOLDER_NAME = 'Untitled';
const MAX_PACKAGE_FOLDER_NAME_LENGTH = 180;
const UNSAFE_PACKAGE_FOLDER_CHARS = /[\x00-\x1f\x7f<>:"|?*\\/]/g;
const PACKAGE_OUTPUT_LAYOUT_MODES = Object.freeze({
  FLAT: 'flat',
  BY_EXTENSION: 'by-extension-v1',
});
const ASSET_REVIEW_ROW_HEIGHT = 58;
const ASSET_REVIEW_OVERSCAN = 6;
const ASSET_REVIEW_MOUNTED_ROW_LIMIT = 36;

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
  figmaScopeMode: 'current-page',
  figmaSectionExpanded: false,
  figmaScanInFlight: false,
  figmaScanStartedAt: null,
  lastFigmaWarning: null,
  editFigmaProjectId: null,
  assetWorkspace: null,
  assetReviewOpen: false,
  assetReviewFilter: 'all',
  assetReviewQuery: '',
  assetReviewSelectedKey: null,
  assetReviewProjectId: null,
  assetReviewLogicalItems: {
    existing: [],
    added: [],
    missing: [],
  },
};

let rendererEventListenersBound = false;
let mainProcessListenersBound = false;
let packageReviewOpener = null;
let packageReviewConfirmationInFlight = false;
let packageReviewConfirmationId = 0;
let upgradeModalOpener = null;
let existingAssetsDecisionRequest = null;
let existingAssetsModalProjectId = null;
let existingAssetsModalSelectionEpoch = null;
let existingAssetsDecisionOpener = null;
let fileWorkspaceRenderRequestId = 0;
let assetWorkspaceRequestGeneration = 0;
let assetWorkspaceRequestId = 0;
let assetWorkspaceLoadedRequestId = 0;
let packageReviewRequestId = 0;
let packageReviewModalProjectId = null;
let packageReviewModalSelectionEpoch = null;
let packageReviewModalRequestId = null;
let packageReviewModalSessionId = null;
let projectSelectionEpoch = 0;
let projectSelectionIntentEpoch = 0;
let projectRefreshInFlight = null;
let projectRefreshGeneration = 0;
let pendingProjectRefreshIds = new Set();
const rendererActionsInFlight = new Set();
const BLOCKING_MODAL_IDS = [
  'modal-existing-assets',
  'modal-package',
  'modal-success',
  'modal-progress',
  'modal-upgrade',
  'modal-delete-confirm',
  'modal-edit-figma-link',
  'modal-clear-all',
  'modal-v2-results',
];
let activeModalLease = null;
let modalLeaseSequence = 0;
let notificationPackageTriggerInFlight = false;
let notificationPackageTriggerId = 0;
let existingAssetsModalSessionId = null;

function getVisibleBlockingModalIds() {
  return BLOCKING_MODAL_IDS.filter(id => {
    const modal = $(`#${id}`);
    return modal && !modal.classList.contains('hidden');
  });
}

function hasModalInteraction() {
  return Boolean(activeModalLease) || getVisibleBlockingModalIds().length > 0;
}

function claimModalLease(id, { replaceVisible = false } = {}) {
  if (!BLOCKING_MODAL_IDS.includes(id)) return null;
  if (activeModalLease && activeModalLease.id !== id) {
    const leasedModal = $(`#${activeModalLease.id}`);
    if (!leasedModal || leasedModal.classList.contains('hidden')) activeModalLease = null;
  }
  if (activeModalLease && activeModalLease.id !== id) return null;
  if (activeModalLease && activeModalLease.id === id) {
    const leasedModal = $(`#${id}`);
    // A visible modal already owns this ID.  A second open attempt must not
    // share its session or later release the visible modal's authority.
    if (leasedModal && !leasedModal.classList.contains('hidden')) {
      if (!replaceVisible) return null;
      activeModalLease = null;
    }
    else activeModalLease = null;
  }
  const visibleOtherModal = getVisibleBlockingModalIds().some(visibleId => visibleId !== id);
  if (visibleOtherModal) return null;
  if (!activeModalLease) activeModalLease = { id, sessionId: ++modalLeaseSequence };
  return activeModalLease;
}

function isCurrentModalLease(id, sessionId) {
  return Boolean(activeModalLease && activeModalLease.id === id && activeModalLease.sessionId === sessionId);
}

function releaseModalLease(id, sessionId = null) {
  if (!activeModalLease || activeModalLease.id !== id) return;
  if (sessionId !== null && activeModalLease.sessionId !== sessionId) return;
  activeModalLease = null;
}

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
const FIGMA_PACKAGE_TRANSFER_ERROR_MESSAGE = 'Crate could not securely retrieve all Figma assets. No package was written. Try again.';
const FIGMA_FAILURE_CATEGORIES = new Set([
  'connection',
  'rate-limited',
  'file-access',
  'scope',
  'unknown',
  'informational',
]);
const FIGMA_SCOPE_FAILURE_STATUS_REASONS = new Set([
  'figma-current-page-no-page-or-node-param',
  'figma-current-page-requested-page-not-found',
  'figma-current-page-requested-node-not-found',
  'figma-current-page-prototype-link-file-fetch-failed',
]);
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

function getFigmaLinkErrorMessage(error) {
  switch (error) {
    case 'invalid_figma_url':
      return 'Crate could not read that Figma URL. Please double-check and try again.';
    case 'figma_not_connected':
      return 'Reconnect Figma in Settings before linking a Figma file.';
    case 'figma_invalid_token':
      return 'Reconnect Figma in Settings, then try again.';
    case 'figma_rate_limited':
      return 'Figma is temporarily limiting requests. Wait for the cooldown, then try again.';
    case 'figma_file_unavailable':
      return 'Check access or replace the Figma link, then try again.';
    case 'figma_scope_unresolved':
      return 'Use the exact Figma page or selected layer link, or replace the Figma link, then try again.';
    case 'figma_verification_failed':
      return 'Crate could not verify that Figma link. Check your connection and try again.';
    default:
      return '';
  }
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

function sanitizeRendererSourceName(value) {
  if (typeof value !== 'string') return null;
  const safe = value.trim();
  if (!safe || /[\\/]/.test(safe) || /^[a-z][a-z0-9+.-]*:/i.test(safe)) return null;
  return safe.slice(0, 120);
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

function isTabActive(tabName) {
  const normalizedTab = tabName === 'files' ? 'current-project' : tabName;
  return $(`#tab-${normalizedTab}`)?.classList.contains('active') === true;
}

function getRendererViewState() {
  const scroller = $('.app-content');
  const activeElement = document.activeElement;
  const activeRow = activeElement?.closest?.('[data-render-key]');
  const assetScrollTops = {};
  for (const id of ['existing-assets-list', 'added-assets-list', 'pending-file-list']) {
    const list = $(`#${id}`);
    if (list && Number.isFinite(list.scrollTop)) assetScrollTops[id] = list.scrollTop;
  }
  return {
    assetReviewProjectId: state.assetReviewProjectId,
    scrollTop: scroller && Number.isFinite(scroller.scrollTop) ? scroller.scrollTop : null,
    assetScrollTops,
    activeElement,
    activeId: activeElement?.id || null,
    activeRenderKey: activeRow?.dataset?.renderKey || null,
    activeClassName: activeElement?.className || null,
  };
}

function findRendererFocusTarget(viewState) {
  if (!viewState) return null;
  const activeElement = viewState.activeElement;
  if (activeElement && (activeElement.isConnected || activeElement.parentNode)) return activeElement;
  if (viewState.activeId) {
    const element = $(`#${viewState.activeId}`);
    if (element) return element;
  }
  if (!viewState.activeRenderKey) return null;
  const rows = $$('[data-render-key]');
  for (const row of rows) {
    if (row.dataset?.renderKey !== viewState.activeRenderKey) continue;
    if (viewState.activeClassName && typeof row.querySelector === 'function') {
      const matchingChild = row.querySelector(`.${String(viewState.activeClassName).split(/\s+/u)[0]}`);
      if (matchingChild) return matchingChild;
    }
    return row;
  }
  return null;
}

function restoreRendererViewState(viewState) {
  if (!viewState) return;
  if (viewState.assetReviewProjectId !== state.assetReviewProjectId) return;
  const scroller = $('.app-content');
  if (scroller && viewState.scrollTop !== null) scroller.scrollTop = viewState.scrollTop;
  for (const [id, scrollTop] of Object.entries(viewState.assetScrollTops || {})) {
    const list = $(`#${id}`);
    if (list && Number.isFinite(scrollTop)) list.scrollTop = scrollTop;
  }
  const focusTarget = findRendererFocusTarget(viewState);
  if (focusTarget && typeof focusTarget.focus === 'function') {
    focusTarget.focus({ preventScroll: true });
  }
}

const rendererFallbackItemKeys = new WeakMap();
let rendererFallbackItemSequence = 0;

function getRendererItemKey(item, index = 0) {
  if (!item || typeof item !== 'object') return `item:${index}`;
  const identity = getFileVisualIdentity(item);
  if (identity) return `visual:${identity}`;
  if (item.fileId) return `file-id:${item.fileId}`;
  if (item.captureId) return `capture-id:${item.captureId}`;
  if (item.captureSessionId) return `capture:${item.captureSessionId}`;
  // A record without an authoritative ID keeps its object identity through
  // filtering and scrolling. A replacement snapshot gets a fresh key: neither
  // its display name nor its position can prove it is the previous record.
  if (!rendererFallbackItemKeys.has(item)) {
    rendererFallbackItemKeys.set(item, `record:${++rendererFallbackItemSequence}`);
  }
  return rendererFallbackItemKeys.get(item);
}

function getRendererItemSignature(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.id) {
    return JSON.stringify({
      id: item.id,
      name: item.name || '',
      status: item.status || '',
      packagedAt: item.packagedAt || null,
      fileCount: Array.isArray(item.files) ? item.files.length : 0,
      excludedCount: Array.isArray(item.excludedAssetKeys) ? item.excludedAssetKeys.length : 0,
    });
  }
  return JSON.stringify({
    name: item.name || '',
    ext: item.ext || '',
    appFamily: item.appFamily || '',
    sourceName: sanitizeRendererSourceName(item.sourceName) || '',
    assetOrigin: item.assetOrigin || '',
    projectRole: item.projectRole || '',
    protectedSource: item.protectedSource === true,
    sourceRecoveryAllowed: item.sourceRecoveryAllowed === true,
    excluded: item.excluded === true,
    embedded: item.embedded === true,
    linked: item.linked === true,
    captureState: item.captureState || '',
    visualIdentity: getFileVisualIdentity(item) || '',
    visualRevision: getFileVisualRevision(item) || '',
  });
}

function reconcileKeyedList(list, items, build, keyForItem = getRendererItemKey) {
  if (!list) return;
  const existing = new Map();
  for (const child of Array.from(list.children || [])) {
    if (child.dataset?.renderKey) existing.set(child.dataset.renderKey, child);
  }
  const retained = new Set();
  const nextItems = Array.isArray(items) ? items : [];
  nextItems.forEach((item, index) => {
    const key = keyForItem(item, index);
    let child = existing.get(key);
    const signature = getRendererItemSignature(item);
    if (!child || child.dataset.renderSignature !== signature) {
      child = build(item, index);
      child.dataset.renderKey = key;
      child.dataset.renderSignature = signature;
    }
    retained.add(child);
    const current = list.children[index];
    if (current !== child) {
      if (typeof list.insertBefore === 'function') list.insertBefore(child, current || null);
      else list.appendChild(child);
    }
  });
  for (const child of Array.from(list.children || [])) {
    if (retained.has(child)) continue;
    if (typeof list.removeChild === 'function') list.removeChild(child);
    else {
      const index = Array.from(list.children || []).indexOf(child);
      if (index >= 0) list.children.splice(index, 1);
    }
  }
}

function getAssetReviewSearchText(file) {
  const sourceName = sanitizeRendererSourceName(file?.sourceName) || '';
  return `${file?.name || ''} ${file?.ext || ''} ${file?.appFamily || ''} ${sourceName}`.toLowerCase();
}

function getAssetReviewVirtualRange(list, itemCount) {
  if (itemCount === 0) return { start: 0, end: 0 };
  const scrollTop = Number.isFinite(list.scrollTop) ? Math.max(0, list.scrollTop) : 0;
  const viewportHeight = Number.isFinite(list.clientHeight) && list.clientHeight > 0
    ? list.clientHeight
    : ASSET_REVIEW_ROW_HEIGHT * 6;
  const firstVisible = Math.max(0, Math.floor(scrollTop / ASSET_REVIEW_ROW_HEIGHT) - ASSET_REVIEW_OVERSCAN);
  const requestedCount = Math.ceil(viewportHeight / ASSET_REVIEW_ROW_HEIGHT) + (ASSET_REVIEW_OVERSCAN * 2);
  const count = Math.min(ASSET_REVIEW_MOUNTED_ROW_LIMIT, Math.max(1, requestedCount));
  return {
    start: firstVisible,
    end: Math.min(itemCount, firstVisible + count),
  };
}

function renderVirtualAssetList(list, items, build) {
  if (!list) return;
  let virtual = list.__assetReviewVirtualState;
  if (!virtual) {
    virtual = {
      items: [],
      build,
      onScroll: () => renderVirtualAssetList(list, virtual.items, virtual.build),
    };
    list.__assetReviewVirtualState = virtual;
    list.classList.add('asset-virtual-list');
    list.addEventListener('scroll', virtual.onScroll, { passive: true });
  }
  virtual.items = Array.isArray(items) ? items : [];
  virtual.build = build;
  list.style.position = 'relative';
  list.style.height = `${virtual.items.length * ASSET_REVIEW_ROW_HEIGHT}px`;
  const logicalHeight = `${virtual.items.length * ASSET_REVIEW_ROW_HEIGHT}px`;
  if (typeof list.style.setProperty === 'function') {
    list.style.setProperty('--asset-review-logical-height', logicalHeight);
  } else {
    list.style['--asset-review-logical-height'] = logicalHeight;
  }
  const viewportHeight = Number.isFinite(list.clientHeight) && list.clientHeight > 0
    ? list.clientHeight
    : ASSET_REVIEW_ROW_HEIGHT * 6;
  const maxScrollTop = Math.max(0, (virtual.items.length * ASSET_REVIEW_ROW_HEIGHT) - viewportHeight);
  if (Number.isFinite(list.scrollTop) && list.scrollTop > maxScrollTop) list.scrollTop = maxScrollTop;
  const { start, end } = getAssetReviewVirtualRange(list, virtual.items.length);
  reconcileKeyedList(
    list,
    virtual.items.slice(start, end),
    (item, visibleIndex) => virtual.build(item, start + visibleIndex),
    (item, visibleIndex) => getRendererItemKey(item, start + visibleIndex),
  );
  Array.from(list.children || []).forEach((row, visibleIndex) => {
    // Position belongs to this filtered list, not to the row's content
    // signature. Retained rows need the same updates as newly built rows.
    const index = start + visibleIndex;
    row.style.position = 'absolute';
    row.style.top = `${index * ASSET_REVIEW_ROW_HEIGHT}px`;
    row.style.left = '0';
    row.style.right = '0';
    row.style.minHeight = `${ASSET_REVIEW_ROW_HEIGHT}px`;
    row.dataset.assetIndex = String(index);
    row.setAttribute('aria-posinset', String(index + 1));
    row.setAttribute('aria-setsize', String(virtual.items.length));
    const selected = row.dataset?.renderKey === state.assetReviewSelectedKey;
    row.setAttribute('aria-selected', String(selected));
    row.classList.toggle('is-selected', selected);
  });
}

function resetVirtualAssetList(list) {
  if (!list) return;
  const virtual = list.__assetReviewVirtualState;
  if (virtual) list.removeEventListener('scroll', virtual.onScroll);
  delete list.__assetReviewVirtualState;
  list.__assetReviewAllItems = [];
  list.classList.remove('asset-virtual-list');
  list.style.height = '';
  list.style.position = '';
  if (typeof list.style.removeProperty === 'function') {
    list.style.removeProperty('--asset-review-logical-height');
  } else {
    delete list.style['--asset-review-logical-height'];
  }
  list.scrollTop = 0;
}

function setAssetReviewProject(projectId) {
  if (state.assetReviewProjectId === projectId) return;
  state.assetReviewProjectId = projectId;
  assetWorkspaceRequestGeneration += 1;
  state.assetReviewSelectedKey = null;
  state.assetReviewLogicalItems = { working: [], existing: [], added: [], missing: [] };
  for (const id of ['project-file-list', 'working-assets-list', 'existing-assets-list', 'added-assets-list', 'pending-file-list', 'recent-assets-list']) {
    const list = $(`#${id}`);
    if (!list) continue;
    resetVirtualAssetList(list);
    reconcileKeyedList(list, [], () => null);
  }
}

function focusSelectedProjectTarget(projectId) {
  const tabName = projectId ? 'current-project' : 'projects';
  const target = document.querySelector(`.app-tab[data-tab="${tabName}"]`);
  target?.focus?.({ preventScroll: true });
}

function setSelectedProject(projectId) {
  const nextProjectId = typeof projectId === 'string' && projectId ? projectId : null;
  projectSelectionIntentEpoch += 1;
  if (state.selectedProjectId === nextProjectId) return false;

  state.selectedProjectId = nextProjectId;
  projectSelectionEpoch += 1;
  // A project switch invalidates every modal session.  The caller must not
  // allow an async callback from the previous project to reopen a modal.
  activeModalLease = null;
  modalLeaseSequence += 1;
  existingAssetsModalSessionId = null;
  packageReviewModalSessionId = null;
  packageReviewRequestId += 1;
  packageReviewConfirmationId += 1;
  packageReviewConfirmationInFlight = false;
  state.packageReviewToken = null;
  packageReviewModalProjectId = null;
  packageReviewModalSelectionEpoch = null;
  packageReviewModalRequestId = null;
  hideExistingAssetsDecisionModal({ restoreFocus: false });
  hidePackageReviewDialog({ restoreFocus: false });
  hidePackageProgressModal();
  const successModal = $('#modal-success');
  if (successModal) {
    successModal.classList.add('hidden');
    successModal.removeEventListener('keydown', handlePackageSuccessKeydown);
  }
  for (const id of ['modal-upgrade', 'modal-delete-confirm', 'modal-edit-figma-link', 'modal-clear-all', 'modal-v2-results']) {
    $(`#${id}`)?.classList.add('hidden');
  }
  $('#modal-upgrade')?.removeEventListener('keydown', handlePackageLimitKeydown);
  state.pendingDeleteId = null;
  state.editFigmaProjectId = null;
  packageReviewOpener = null;
  setModalBackgroundState(false);
  setAssetReviewProject(nextProjectId);
  focusSelectedProjectTarget(nextProjectId);
  return true;
}

function setVirtualAssetItems(list, items, build) {
  if (!list) return;
  if (list.__assetReviewVirtualState) {
    renderVirtualAssetList(list, items, build || list.__assetReviewVirtualState.build);
    return;
  }
  renderVirtualAssetList(list, items, build);
}

function setRendererActionBusy(element, busy, busyLabel, idleLabel = null) {
  if (!element) return;
  if (busy) {
    if (element.dataset) element.dataset.actionIdleLabel = idleLabel ?? element.textContent;
    element.setAttribute('aria-busy', 'true');
    element.classList.add('is-action-busy');
    if ('disabled' in element) element.disabled = true;
    if (busyLabel) element.textContent = busyLabel;
    return;
  }
  element.setAttribute('aria-busy', 'false');
  element.classList.remove('is-action-busy');
  if ('disabled' in element) element.disabled = false;
  const storedLabel = element.dataset?.actionIdleLabel;
  if (storedLabel !== undefined) element.textContent = storedLabel;
  if (element.dataset) delete element.dataset.actionIdleLabel;
}

async function runRendererAction(key, element, busyLabel, action, idleLabel = null) {
  if (rendererActionsInFlight.has(key)) return undefined;
  rendererActionsInFlight.add(key);
  setRendererActionBusy(element, true, busyLabel, idleLabel);
  try {
    return await action();
  } finally {
    rendererActionsInFlight.delete(key);
    setRendererActionBusy(element, false, busyLabel, idleLabel);
  }
}

function createRendererDeadlineAttempt(timeoutMs = ADD_FILES_OPERATION_TIMEOUT_MS) {
  let active = true;
  let timer = null;
  let resolveTimeout;
  const timeoutPromise = new Promise(resolve => { resolveTimeout = resolve; });
  const cancel = reason => {
    if (!active) return false;
    active = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    resolveTimeout({ timedOut: reason === 'timeout', reason });
    return true;
  };
  timer = setTimeout(() => cancel('timeout'), timeoutMs);
  return {
    timeoutMs,
    isCurrent: () => active,
    timeoutPromise,
    cancel,
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

async function runRendererDeadlineAttempt(work, attempt) {
  let workPromise;
  try {
    workPromise = Promise.resolve(work(attempt));
  } catch (error) {
    workPromise = Promise.reject(error);
  }
  const outcome = await Promise.race([
    workPromise.then(value => ({ timedOut: false, value })),
    attempt.timeoutPromise,
  ]);
  if (outcome.timedOut) {
    attempt.cancel(outcome.reason || 'timeout');
    return outcome;
  }
  return outcome;
}

// ===== Init =====
async function init() {
  try {
    if (typeof window.crate?.reportRendererInitEntered === 'function') {
      window.crate.reportRendererInitEntered();
    }
  } catch (_) {}
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
    try {
      if (typeof window.crate.reportRendererStartupDataComplete === 'function') {
        window.crate.reportRendererStartupDataComplete();
      }
    } catch (_) {}
  } catch (e) {
    logRendererError('startup data load failed', e);
    try {
      if (typeof window.crate.reportRendererStartupDataFailed === 'function') {
        window.crate.reportRendererStartupDataFailed();
      }
    } catch (_) {}
  }

  renderProjects();
  renderSettingsControls();
  renderFooter();
  try {
    if (typeof window.crate.reportRendererFirstRenderComplete === 'function') {
      window.crate.reportRendererFirstRenderComplete();
    }
  } catch (_) {}
  try {
    const requestFrame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : window.requestAnimationFrame;
    if (typeof requestFrame === 'function') {
      requestFrame(() => {
        try {
          if (typeof window.crate?.reportRendererFirstFrame === 'function') {
            window.crate.reportRendererFirstFrame();
          }
        } catch (_) {}
      });
    }
  } catch (_) {}
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

  if (isProjectCreationLocked()) {
    empty.classList.add('hidden');
    list.classList.add('hidden');
    form.classList.remove('hidden');
    updateAddProjectButton();
    return;
  }

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
  reconcileKeyedList(container, state.projects, project => {
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
      <button class="project-delete" data-id="${project.id}" title="Remove project" aria-label="Remove project">&times;</button>
    `;

    // Click row -> go to Project Workspace
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('project-pill') || e.target.classList.contains('project-delete')) return;
      setSelectedProject(project.id);
      // Keep the selection assignment adjacent to navigation for the
      // source-bound keyboard-order contract; setSelectedProject performs
      // the session invalidation before this stable value is reaffirmed.
      state.selectedProjectId = project.id;
      switchTab('current-project');
    });

    // Click pill -> toggle watching
    const pill = row.querySelector('.project-pill');
    pill.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = project.status === 'watching' ? 'pauseProject' : 'startWatching';
      const busyLabel = project.status === 'watching' ? 'Pausing…' : 'Starting…';
      try {
        await runRendererAction(`watch:${project.id}`, pill, busyLabel, async () => {
          await window.crate[action](project.id);
          state.projects = await window.crate.getProjects();
          if (isTabActive('projects')) renderProjects();
          if (state.selectedProjectId === project.id && isTabActive('current-project')) await renderFiles();
        }, pillText);
      } catch (error) {
        logRendererError(`${action} failed`, error);
        showToast('Crate could not update watching. Try again.');
      }
    });

    // Click delete -> show confirmation
    const deleteBtn = row.querySelector('.project-delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showDeleteConfirmation(project.id, project.name);
    });

    return row;
  }, project => `project:${project.id}`);
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
let projectCreationPhase = 'idle';
let projectListReadEpoch = 0;

function projectListReadIsCurrent(epoch) {
  return epoch === projectListReadEpoch && projectCreationPhase === 'idle';
}

function isProjectCreationLocked() {
  return projectCreationPhase !== 'idle';
}

function getProjectCreationStatus() {
  let status = $('#project-creation-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'project-creation-status';
    status.className = 'form-subtitle';
    status.style.marginTop = '8px';
    $('#new-project-form').appendChild(status);
  }
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  return status;
}

function setProjectCreationStatus(message) {
  const status = getProjectCreationStatus();
  status.textContent = message || '';
}

function setProjectCreationPhase(phase) {
  projectCreationPhase = phase;
  const locked = isProjectCreationLocked();
  const busy = phase === 'creating';

  const createButton = $('#btn-create-project');
  if (createButton) {
    const atCap = state.projects.length >= MAX_PROJECTS;
    createButton.disabled = locked || atCap;
    createButton.textContent = phase === 'creating'
      ? 'Starting\u2026'
      : (phase === 'unresolved' ? 'Restart Crate to continue' : '\u25B6 Start Watching');
    createButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  const cancelButton = $('#btn-cancel-project');
  if (cancelButton) cancelButton.disabled = locked;

  for (const selector of [
    '#input-project-name',
    '#input-figma-scope',
    '#input-figma-url',
    '#figma-section-toggle',
  ]) {
    const control = $(selector);
    if (control) control.disabled = locked;
  }

  const form = $('#new-project-form');
  if (form) form.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (phase === 'creating') setProjectCreationStatus('Starting project. Please wait.');
}

function finishProjectCreationAttempt() {
  projectListReadEpoch += 1;
  setProjectCreationPhase('idle');
}

function enterProjectCreationUnresolved(message) {
  projectListReadEpoch += 1;
  setProjectCreationPhase('unresolved');
  setProjectCreationStatus(message);
  showToast(message);
}

function mergeCreatedProjectIntoState(project) {
  if (!project || !project.id || state.projects.some(item => item.id === project.id)) return;
  state.projects = [
    ...state.projects.map(item => item.status === 'watching' ? { ...item, status: 'paused' } : item),
    project,
  ];
}

function completeProjectCreation(project) {
  finishProjectCreationAttempt();
  mergeCreatedProjectIntoState(project);
  setSelectedProject(project.id);
  setProjectCreationStatus('Project started.');
  showToast('Project started.');
  hideNewProjectForm();
  renderProjects();
  switchTab('current-project');
  return true;
}

function showNewProjectForm() {
  if (isProjectCreationLocked()) {
    showToast('Restart Crate before starting another project.');
    return;
  }
  if (state.projects.length >= MAX_PROJECTS) return;

  $('#projects-empty').classList.add('hidden');
  $('#projects-list').classList.add('hidden');
  $('#new-project-form').classList.remove('hidden');
  const input = $('#input-project-name');
  input.value = '';
  input.focus();

  state.figmaScopeMode = 'current-page';
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
  setProjectCreationStatus('');

  // Update template display from current settings
  const templateDisplay = $('#naming-template-display');
  if (templateDisplay) {
    templateDisplay.textContent = state.settings.namingTemplate || DEFAULT_NAMING_TEMPLATE;
  }

  updateNamingPreview();
}

function hideNewProjectForm() {
  if (isProjectCreationLocked()) return;
  $('#new-project-form').classList.add('hidden');
  renderProjects();
}

async function createProject() {
  if (isProjectCreationLocked()) return;

  const name = $('#input-project-name').value.trim();
  if (!name) {
    showToast('Enter a project name to continue.');
    $('#input-project-name').focus();
    return;
  }

  if (state.projects.length >= MAX_PROJECTS) {
    showToast('Maximum projects reached. Package or delete a project first.');
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

  projectListReadEpoch += 1;
  setProjectCreationPhase('creating');
  let createRequestTimer = null;

  try {
    let result = null;
    let createError = null;
    const timeoutResult = {};
    let createRequestResult;
    try {
      createRequestResult = window.crate.createProject(name, 'automatic', state.figmaScopeMode, figmaUrl);
    } catch (error) {
      createRequestResult = Promise.reject(error);
    }
    const createRequest = Promise.resolve(createRequestResult).then(
      requestResult => ({ result: requestResult, error: null }),
      error => ({ result: null, error })
    );
    const createOutcome = await Promise.race([
      createRequest,
      new Promise(resolve => {
        createRequestTimer = setTimeout(() => resolve(timeoutResult), PROJECT_CREATION_REQUEST_TIMEOUT_MS);
      }),
    ]);
    if (createOutcome === timeoutResult) {
      const message = 'Crate could not confirm whether the project started. Restart Crate before trying again.';
      enterProjectCreationUnresolved(message);
      return;
    }
    result = createOutcome.result;
    createError = createOutcome.error;
    clearTimeout(createRequestTimer);
    createRequestTimer = null;

    const hasTypedError = !!result && typeof result.error === 'string';
    const typedError = hasTypedError ? result.error : null;
    const figmaLinkErrorMessage = getFigmaLinkErrorMessage(typedError);
    const knownNonPersistingError = typedError === 'max_projects_reached' || !!figmaLinkErrorMessage;
    if (!hasTypedError && result && result.id) {
      try {
        const projects = await window.crate.getProjects();
        if (Array.isArray(projects)) state.projects = projects;
      } catch (refreshError) {
        logRendererError('Project creation state could not refresh', refreshError);
      }
      completeProjectCreation(state.projects.find(project => project.id === result.id) || result);
      return;
    }

    if (figmaLinkErrorMessage && figmaError) {
      figmaError.textContent = figmaLinkErrorMessage;
      figmaError.classList.remove('hidden');
      setProjectCreationStatus('');
    } else if (typedError === 'max_projects_reached') {
      setProjectCreationStatus('Maximum projects reached. Package or delete a project first.');
      showToast('Maximum projects reached. Package or delete a project first.');
    } else if (hasTypedError && !knownNonPersistingError) {
      const message = 'Crate could not verify which project started. Restart Crate before trying again.';
      enterProjectCreationUnresolved(message);
      return;
    } else {
      if (createError) logRendererError('Project creation failed', createError);
      const message = 'Crate could not confirm whether the project started. Restart Crate before trying again.';
      enterProjectCreationUnresolved(message);
      return;
    }
  } finally {
    if (createRequestTimer) clearTimeout(createRequestTimer);
    if (projectCreationPhase === 'creating') finishProjectCreationAttempt();
  }
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

function normalizeFigmaFailureCategory(value) {
  return FIGMA_FAILURE_CATEGORIES.has(value) ? value : null;
}

function getFigmaFailureCategoryFromScope(scope = {}) {
  if (!scope || typeof scope !== 'object') return null;
  const statusReason = typeof scope.statusReason === 'string' ? scope.statusReason : '';
  if (statusReason === 'figma-connection-invalid') return 'connection';
  if (statusReason === 'figma-current-page-rate-limited') return 'rate-limited';
  if (statusReason === 'figma-current-page-zero-image-refs') return 'informational';
  if (FIGMA_SCOPE_FAILURE_STATUS_REASONS.has(statusReason)) return 'scope';
  if (statusReason === 'figma-current-page-file-fetch-failed') return 'unknown';
  return null;
}

function getFigmaFailureCategoryFromWarning(warning) {
  const lowerWarning = typeof warning === 'string' ? warning.toLowerCase() : '';
  if (!lowerWarning) return null;
  if (lowerWarning.includes('rate') || lowerWarning.includes('429') || lowerWarning.includes('cooldown')) {
    return 'rate-limited';
  }
  if (lowerWarning.includes('not connected') || lowerWarning.includes('reconnect in settings')) {
    return 'connection';
  }
  if (
    lowerWarning.includes('could not find the requested page') ||
    lowerWarning.includes('could not find the requested node') ||
    lowerWarning.includes('could not find a page or node') ||
    lowerWarning.includes('prototype link')
  ) return 'scope';
  if (lowerWarning.includes('no exportable image assets')) return 'informational';
  return null;
}

function getProjectFigmaFailureCategory(project) {
  const trackedFiles = (project && project.figmaSession && project.figmaSession.trackedFiles) || [];
  const categories = trackedFiles
    .map(file => normalizeFigmaFailureCategory(file && file.failureCategory) || getFigmaFailureCategoryFromScope(file))
    .filter(Boolean);
  for (const category of ['connection', 'rate-limited', 'file-access', 'scope', 'unknown', 'informational']) {
    if (categories.includes(category)) return category;
  }
  return getFigmaFailureCategoryFromWarning(getProjectFigmaWarning(project));
}

function getProjectFigmaRateLimitRetryAt(project) {
  const retryAt = project && project.figmaSession && project.figmaSession.rateLimitRetryAt;
  return Number.isSafeInteger(retryAt) && retryAt > Date.now() && retryAt <= Date.now() + (31 * 24 * 60 * 60 * 1000)
    ? retryAt
    : null;
}

function formatFigmaRetryTime(retryAt) {
  if (
    !Number.isSafeInteger(retryAt) ||
    retryAt <= Date.now() ||
    retryAt > Date.now() + (31 * 24 * 60 * 60 * 1000)
  ) return '';
  const retryDate = new Date(retryAt);
  if (!Number.isFinite(retryDate.getTime())) return '';
  const today = new Date();
  const sameDay = retryDate.getFullYear() === today.getFullYear() &&
    retryDate.getMonth() === today.getMonth() &&
    retryDate.getDate() === today.getDate();
  const formatted = retryDate.toLocaleString([], sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `Try again after ${formatted}.`;
}

function getFigmaWarningDisplayText(warning, retryAt = null, failureCategory = null) {
  const message = typeof warning === 'string' ? warning.trim() : '';
  if (!message) return '';
  const lowerMessage = message.toLowerCase();
  const category = normalizeFigmaFailureCategory(failureCategory) || getFigmaFailureCategoryFromWarning(message);
  const isRateLimited = category === 'rate-limited' || lowerMessage.includes('rate') || lowerMessage.includes('429') || lowerMessage.includes('cooldown');
  const retryText = isRateLimited ? formatFigmaRetryTime(retryAt) : '';
  return retryText ? `${message} ${retryText}` : message;
}

function getFigmaFailureAction(category, retryAt = null) {
  switch (category) {
    case 'connection':
      return 'Reconnect Figma in Settings.';
    case 'rate-limited':
      return formatFigmaRetryTime(retryAt) || 'Wait for the Figma cooldown, then try again.';
    case 'file-access':
      return 'Check access or replace the Figma link, then try again.';
    case 'scope':
      return 'Use the exact Figma page or layer link, or replace the Figma link, then try again.';
    case 'informational':
      return 'This page has no exportable image assets.';
    case 'unknown':
    default:
      return 'Check your Figma connection and try again.';
  }
}

function getFigmaFailureTitle(category) {
  switch (category) {
    case 'connection': return 'Figma connection required';
    case 'rate-limited': return 'Figma rate limiting';
    case 'file-access': return 'Figma file access required';
    case 'scope': return 'Figma page or layer link required';
    case 'informational': return 'No exportable Figma assets';
    case 'unknown':
    default: return 'Figma scan needs attention';
  }
}

function renderFigmaWarningCard(container, warning, retryAt = null, failureCategory = null) {
  if (!container) return;
  const message = typeof warning === 'string' ? warning.trim() : '';
  container.innerHTML = '';
  container.className = 'figma-warning-card hidden';

  if (!message) return;

  const safeMessage = sanitizeRendererLogText(message);
  const category = normalizeFigmaFailureCategory(failureCategory)
    || getFigmaFailureCategoryFromWarning(message)
    || 'unknown';
  const isInformational = category === 'informational';
  const title = getFigmaFailureTitle(category);
  const action = getFigmaFailureAction(category, retryAt);

  container.classList.remove('hidden');

  const titleEl = document.createElement('div');
  titleEl.className = 'figma-warning-title';
  titleEl.textContent = title;

  const actionEl = document.createElement('div');
  actionEl.className = 'figma-warning-copy';
  actionEl.textContent = action;

  const statusEl = document.createElement('div');
  statusEl.className = 'figma-warning-status';
  statusEl.textContent = isInformational ? 'Info' : 'Blocked';

  const noteTitle = document.createElement('div');
  noteTitle.className = 'figma-warning-title';
  noteTitle.textContent = isInformational ? 'Figma scan note' : 'Do not package yet';

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
async function renderFiles(options = {}) {
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  if (!isCurrent()) return false;
  const renderRequestId = ++fileWorkspaceRenderRequestId;
  const workspaceRequestId = ++assetWorkspaceRequestId;
  const viewState = getRendererViewState();
  const noProject = $('#files-no-project');
  const filesView = $('#files-view');

  // If no project is selected, try to auto-select an active one
  if (!isCurrent()) return false;
  if (!state.selectedProjectId) {
    const watching = state.projects.find(p => p.status === 'watching');
    if (watching) {
      setSelectedProject(watching.id);
    }
  }

  if (!isCurrent()) return false;
  if (!state.selectedProjectId) {
    setActiveFileVisualProject(null);
    setAssetReviewProject(null);
    noProject.innerHTML = '<div class="app-empty-icon">&#x1F4C2;</div><div class="app-empty-title">No project selected</div><div class="app-empty-desc">Choose a project or start a new one.</div>';
    noProject.classList.remove('hidden');
    filesView.classList.add('hidden');
    restoreRendererViewState(viewState);
    return;
  }

  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project || !isCurrent()) {
    setActiveFileVisualProject(null);
    setAssetReviewProject(null);
    noProject.innerHTML = '<div class="app-empty-icon">&#x1F4C2;</div><div class="app-empty-title">No project selected</div><div class="app-empty-desc">Choose a project or start a new one.</div>';
    noProject.classList.remove('hidden');
    filesView.classList.add('hidden');
    restoreRendererViewState(viewState);
    return;
  }

  setActiveFileVisualProject(project.id);
  setAssetReviewProject(project.id);

  // Show empty state when project is packaged or not actively watching
  if (project.status === 'packaged') {
    noProject.innerHTML = '<p style="color:#9ca3af;font-size:13px;text-align:center;padding:32px 16px;">This project has been packaged.<br>Start a new project to begin tracking files.</p>';
    noProject.classList.remove('hidden');
    filesView.classList.add('hidden');
    restoreRendererViewState(viewState);
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
    renderFigmaWarningCard(
      figmaWarningText,
      warning,
      getProjectFigmaRateLimitRetryAt(project),
      getProjectFigmaFailureCategory(project)
    );
  }

  const excludedAssetKeys = new Set(project.excludedAssetKeys || []);
  const visiblePendingFiles = (project.pendingFiles || []).filter(file => !excludedAssetKeys.has(getAssetReviewExclusionKey(file)));
  let assetWorkspace = null;
  if (typeof window.crate?.getAssetWorkspace === 'function') {
    try {
      assetWorkspace = await window.crate.getAssetWorkspace(project.id);
    } catch (error) {
      logRendererError('asset workspace unavailable', error);
    }
  }
  if (
    !isCurrent() ||
    renderRequestId !== fileWorkspaceRenderRequestId ||
    workspaceRequestId !== assetWorkspaceRequestId ||
    state.selectedProjectId !== project.id
  ) return;
  if (!assetWorkspace || assetWorkspace.projectId !== project.id) {
    assetWorkspace = {
      projectId: project.id,
      files: (project.files || []).map(file => ({
        name: file.name,
        ext: getFileExtension(file),
        appFamily: file.captureEvidence?.appFamily || getAppFamilyFromExtension(file),
        sourceName: sanitizeRendererSourceName(file.captureEvidence?.sourceName),
        assetOrigin: file.assetOrigin,
        projectRole: file.projectRole,
        protectedSource: true,
        excluded: excludedAssetKeys.has(getAssetReviewExclusionKey(file)),
        visualIdentity: null,
        visualRevision: null,
      })),
      pendingFiles: (project.pendingFiles || []).map(file => ({
        name: file.name,
        ext: getFileExtension(file),
        appFamily: file.captureEvidence?.appFamily || getAppFamilyFromExtension(file),
        sourceName: sanitizeRendererSourceName(file.captureEvidence?.sourceName),
        protectedSource: true,
        excluded: excludedAssetKeys.has(getAssetReviewExclusionKey(file)),
        visualIdentity: null,
        visualRevision: null,
      })),
    };
  }
  state.assetWorkspace = assetWorkspace;
  assetWorkspaceLoadedRequestId = workspaceRequestId;

  // Pending files (Tier 2)
  renderPendingFiles(project, assetWorkspace.pendingFiles);

  // Persistent project asset workspace
  renderAssetWorkspace(project, {
    hasActiveCandidates: visiblePendingFiles.length > 0,
    trackedFigmaFiles: Array.isArray(assetWorkspace.trackedFigmaFiles)
      ? assetWorkspace.trackedFigmaFiles
      : null,
  }, assetWorkspace.files);

  // Package button — always enabled; click handler shows toast if no files
  const packageBtn = $('#btn-package');
  packageBtn.disabled = false;

  if (!isCurrent()) return false;
  await syncExistingAssetsDecisionModal(project, { isCurrent });
  if (!isCurrent()) return false;
  restoreRendererViewState(viewState);
  return true;
}

function getAssetReviewExclusionKey(file) {
  if (!file || typeof file !== 'object') return null;
  if (file.embedded === true && file.source === 'scan-on-save-embedded') {
    const parentPsd = typeof file.parentPsd === 'string'
      ? file.parentPsd.trim().replace(/\/+$/, '').toLowerCase()
      : '';
    const embeddedIndex = Number.isInteger(file.embeddedIndex) ? file.embeddedIndex : '';
    const originalName = typeof file.embeddedOriginalName === 'string' ? file.embeddedOriginalName : '';
    const fallbackName = typeof file.name === 'string' ? file.name : '';
    if (parentPsd) return `embedded-psd:${parentPsd}:${embeddedIndex}:${originalName || fallbackName}`;
  }
  if (typeof file.fileId === 'string' && file.fileId) return file.fileId;
  return typeof file.path === 'string' && file.path ? file.path : null;
}

function getExistingAssetsForDecision(project) {
  if (!project || typeof project !== 'object') return [];
  const workspace = state.assetWorkspace?.projectId === project.id ? state.assetWorkspace : null;
  return [...(workspace?.files || []), ...(workspace?.pendingFiles || [])].filter(file => (
    file && file.assetOrigin === 'existing' && file.protectedSource !== true && file.excluded !== true
  ));
}

function getPendingDecisionTarget(file) {
  if (!file || typeof file !== 'object') return null;
  return getFileVisualIdentity(file) || (
    typeof file.path === 'string' && file.path ? file.path : null
  );
}

function getPendingDecisionStableKey(file) {
  if (!file || typeof file !== 'object') return null;
  return getFileVisualIdentity(file) || (
    typeof file.fileId === 'string' && file.fileId ? file.fileId : null
  ) || (
    typeof file.path === 'string' && file.path ? file.path : null
  );
}

function getVisiblePendingAssetEntries(project) {
  if (!project || typeof project !== 'object') return [];
  const excluded = new Set(project.excludedAssetKeys || []);
  return (project.pendingFiles || [])
    .map((rawFile, sourceIndex) => ({ rawFile, sourceIndex }))
    .filter(({ rawFile }) => (
      rawFile && !excluded.has(getAssetReviewExclusionKey(rawFile))
    ));
}

function getPendingWorkspacePresentation(rawFile, sourceIndex, presentations) {
  if (!Array.isArray(presentations)) return null;
  const stableKey = getPendingDecisionStableKey(rawFile);
  if (stableKey) {
    const identityMatches = presentations.filter(file => (
      getPendingDecisionStableKey(file) === stableKey
    ));
    if (identityMatches.length === 1) return identityMatches[0];
  }
  return presentations.find(file => file && file.sourceIndex === sourceIndex) || null;
}

function getPendingAssetsForBatchDecision(project) {
  if (!project || typeof project !== 'object') return [];
  const pending = getVisiblePendingAssetEntries(project).filter(({ rawFile }) => (
    getPendingCaptureState(rawFile) === 'pending'
  ));
  const workspace = state.assetWorkspace?.projectId === project.id ? state.assetWorkspace : null;
  const presentations = Array.isArray(workspace?.pendingFiles)
    ? workspace.pendingFiles.filter(file => file.excluded !== true)
    : [];

  return pending.map(({ rawFile, sourceIndex }) => {
    const presentation = getPendingWorkspacePresentation(rawFile, sourceIndex, presentations);
    const file = presentation
      ? { ...rawFile, ...presentation }
      : rawFile;
    return {
      rawFile,
      file,
      target: getPendingDecisionTarget(file) || getPendingDecisionTarget(rawFile),
      stableTarget: getPendingDecisionStableKey(rawFile),
    };
  });
}

function updateAssetReviewBatchControls(project, existingAssets, includedExistingCount) {
  const includeAll = $('#btn-include-all-existing');
  const skipAll = $('#btn-skip-all-existing');
  if (!includeAll && !skipAll) return;

  const excluded = new Set(project?.excludedAssetKeys || []);
  const visiblePending = (project?.pendingFiles || []).filter(file => (
    file && !excluded.has(getAssetReviewExclusionKey(file))
  ));
  const pendingCandidates = getPendingAssetsForBatchDecision(project);
  const hasPendingReviewSurface = visiblePending.length > 0;
  const eligiblePendingCount = pendingCandidates.filter(candidate => candidate.target).length;
  const controls = $('.asset-panel-actions');
  if (controls) {
    controls.setAttribute('aria-label', hasPendingReviewSurface ? 'Review Before Packaging controls' : 'Existing Assets controls');
  }

  if (includeAll) {
    includeAll.textContent = hasPendingReviewSurface ? 'Add All' : 'Include All Existing';
    includeAll.setAttribute('aria-label', hasPendingReviewSurface ? 'Add all assets needing review' : 'Include all existing assets');
    includeAll.disabled = hasPendingReviewSurface
      ? eligiblePendingCount === 0
      : existingAssets.length === 0 || includedExistingCount === existingAssets.length;
  }
  if (skipAll) {
    skipAll.textContent = hasPendingReviewSurface ? 'Skip All' : 'Skip All Existing';
    skipAll.setAttribute('aria-label', hasPendingReviewSurface ? 'Skip all assets needing review' : 'Skip all existing assets');
    skipAll.disabled = hasPendingReviewSurface
      ? eligiblePendingCount === 0
      : existingAssets.length === 0 || includedExistingCount === 0;
  }
}

function restoreAssetReviewBatchControls(project) {
  if (!project) return;
  const workspace = state.assetWorkspace?.projectId === project.id ? state.assetWorkspace : null;
  const files = Array.isArray(workspace?.files) ? workspace.files : (project.files || []);
  const existingAssets = files.filter(file => (
    file && file.assetOrigin === 'existing' && file.protectedSource !== true && file.projectRole !== 'source'
  ));
  const includedExistingCount = existingAssets.filter(file => file.excluded !== true).length;
  updateAssetReviewBatchControls(project, existingAssets, includedExistingCount);
}

function getExistingAssetsDecisionFocusableElements() {
  return ['btn-review-existing-assets-later', 'btn-include-existing-assets']
    .map(id => $(`#${id}`))
    .filter(element => element && !element.disabled);
}

function setExistingAssetsDecisionButtonsDisabled(disabled) {
  for (const id of ['btn-review-existing-assets-later', 'btn-include-existing-assets']) {
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

function hideExistingAssetsDecisionModal({ restoreFocus = true } = {}) {
  const modal = $('#modal-existing-assets');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.removeEventListener('keydown', handleExistingAssetsDecisionKeydown);
  releaseModalLease('modal-existing-assets', existingAssetsModalSessionId);
  existingAssetsModalSessionId = null;
  existingAssetsModalProjectId = null;
  existingAssetsModalSelectionEpoch = null;
  setModalBackgroundState(false);
  if (restoreFocus && existingAssetsDecisionOpener && typeof existingAssetsDecisionOpener.focus === 'function') {
    existingAssetsDecisionOpener.focus();
  }
  existingAssetsDecisionOpener = null;
}

async function ensureProjectAssetWorkspace(project) {
  if (!project || !project.id) return null;
  if (state.selectedProjectId !== project.id) return null;
  const requestGeneration = assetWorkspaceRequestGeneration;
  if (
    state.assetWorkspace?.projectId === project.id &&
    assetWorkspaceLoadedRequestId === assetWorkspaceRequestId
  ) return state.assetWorkspace;
  if (typeof window.crate?.getAssetWorkspace !== 'function') return null;
  const requestId = ++assetWorkspaceRequestId;
  try {
    const workspace = await window.crate.getAssetWorkspace(project.id);
    if (
      requestId !== assetWorkspaceRequestId ||
      requestGeneration !== assetWorkspaceRequestGeneration ||
      state.selectedProjectId !== project.id
    ) return null;
    if (!workspace || workspace.projectId !== project.id) return null;
    state.assetWorkspace = workspace;
    assetWorkspaceLoadedRequestId = requestId;
    return workspace;
  } catch (error) {
    logRendererError('asset workspace unavailable', error);
    return null;
  }
}

async function showExistingAssetsDecisionModal(project, packageRequestId = null, options = {}) {
  const isAttemptCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const modal = $('#modal-existing-assets');
  if (!modal || !project) return;
  const lease = claimModalLease('modal-existing-assets');
  if (!lease) return false;
  const sessionId = lease.sessionId;
  let modalSessionCommitted = false;
  const selectionEpoch = projectSelectionEpoch;
  const isCurrentPackageRequest = () => (
    (packageRequestId === null || packageReviewRequestId === packageRequestId) &&
    state.selectedProjectId === project.id &&
    projectSelectionEpoch === selectionEpoch &&
    isAttemptCurrent() &&
    isCurrentModalLease('modal-existing-assets', sessionId)
  );
  try {
    if (!isCurrentPackageRequest()) return false;
    if (!await ensureProjectAssetWorkspace(project)) return false;
    if (!isCurrentPackageRequest()) return false;
    const assets = getExistingAssetsForDecision(project);
    if (assets.length === 0) return false;

    if (modal.classList.contains('hidden')) {
      existingAssetsDecisionOpener = document.activeElement;
    }
    existingAssetsModalProjectId = project.id;
    const decisionInFlightForProject = existingAssetsDecisionRequest &&
      existingAssetsDecisionRequest.projectId === project.id &&
      existingAssetsDecisionRequest.selectionEpoch === selectionEpoch;
    const sourceFile = (state.assetWorkspace?.files || []).find(file => file.protectedSource === true || file.projectRole === 'source');
    const sourcePresentation = getFileAppPresentation(sourceFile, project);
    const sourceLabel = $('#existing-assets-modal-source');
    if (sourceLabel) {
      const sourceAppLabel = sourcePresentation.family === 'generic'
        ? sanitizeRendererSourceName(sourceFile?.sourceName)
        : sourcePresentation.label;
      sourceLabel.textContent = sourceFile
        ? `${sourceAppLabel ? `${sourceAppLabel} · ` : ''}${sourceFile.name}`
        : 'Working file';
    }
    $('#existing-assets-modal-title').textContent = `${assets.length} asset${assets.length === 1 ? ' was' : 's were'} already in this file`;
    $('#existing-assets-modal-count').textContent = `${assets.length} existing asset${assets.length === 1 ? '' : 's'} included by default`;
    const list = $('#existing-assets-modal-list');
    list.innerHTML = '';
    for (const file of assets.slice(0, 4)) {
      const item = document.createElement('div');
      item.className = 'existing-assets-modal-item';
      item.setAttribute('role', 'listitem');
      item.appendChild(createFileVisual(project.id, file));
      const name = document.createElement('span');
      name.className = 'existing-assets-modal-name';
      name.textContent = file.name || 'Untitled asset';
      name.title = name.textContent;
      item.appendChild(name);
      appendAppOriginLabel(item, file, project);
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
    existingAssetsModalSessionId = sessionId;
    existingAssetsModalSelectionEpoch = selectionEpoch;
    modal.removeEventListener('keydown', handleExistingAssetsDecisionKeydown);
    modal.addEventListener('keydown', handleExistingAssetsDecisionKeydown);
    setExistingAssetsDecisionButtonsDisabled(!!decisionInFlightForProject);
    ($('#btn-include-existing-assets') || modal).focus();
    modalSessionCommitted = true;
    return true;
  } finally {
    // A stale callback may finish after a close, project switch, or newer
    // same-project request.  Release only the lease this callback claimed;
    // a newer session with the same modal ID must remain authoritative.
    if (!modalSessionCommitted) releaseModalLease('modal-existing-assets', sessionId);
  }
}

async function syncExistingAssetsDecisionModal(project, options = {}) {
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  if (!isCurrent()) return false;
  const requiresDecision = project && project.assetBaseline && project.assetBaseline.status === 'decision-required';
  if (!requiresDecision) {
    if (existingAssetsModalProjectId) hideExistingAssetsDecisionModal();
    return;
  }
  if (existingAssetsModalProjectId === project.id && !$('#modal-existing-assets').classList.contains('hidden')) return;
  await showExistingAssetsDecisionModal(project, null, { isCurrent });
}

async function submitExistingAssetsDecision(decision, { openReview = false } = {}) {
  if (!existingAssetsModalProjectId) return false;
  const projectId = existingAssetsModalProjectId;
  const modalSelectionEpoch = existingAssetsModalSelectionEpoch;
  const modalSessionId = existingAssetsModalSessionId;
  if (
    $('#modal-existing-assets')?.classList.contains('hidden') ||
    state.selectedProjectId !== projectId ||
    modalSelectionEpoch === null ||
    modalSelectionEpoch !== projectSelectionEpoch
    || !isCurrentModalLease('modal-existing-assets', modalSessionId)
  ) return false;
  if (
    existingAssetsDecisionRequest &&
    existingAssetsDecisionRequest.projectId === projectId &&
    existingAssetsDecisionRequest.selectionEpoch === modalSelectionEpoch
  ) return false;
  const request = { projectId, selectionEpoch: modalSelectionEpoch };
  const isCurrentDecision = () => (
    state.selectedProjectId === projectId &&
    projectSelectionEpoch === modalSelectionEpoch &&
    existingAssetsModalProjectId === projectId &&
    existingAssetsModalSelectionEpoch === modalSelectionEpoch &&
    existingAssetsModalSessionId === modalSessionId &&
    isCurrentModalLease('modal-existing-assets', modalSessionId) &&
    existingAssetsDecisionRequest === request
  );
  existingAssetsDecisionRequest = request;
  const buttons = getExistingAssetsDecisionFocusableElements();
  buttons.forEach(button => { button.disabled = true; });
  try {
    if (!isCurrentDecision()) return false;
    const result = await window.crate.setExistingAssetsDecision(projectId, decision);
    if (!isCurrentDecision()) return false;
    if (!result || !result.success) {
      showToast('Crate could not save that choice. Try again.');
      return false;
    }
    state.projects = await window.crate.getProjects();
    if (!isCurrentDecision()) return false;
    hideExistingAssetsDecisionModal();
    if (state.selectedProjectId === projectId && isFilesTabActive()) {
      await renderFiles();
      if (openReview) openAssetReviewWorkspace();
    } else if (document.querySelector('#tab-projects')?.classList.contains('active')) {
      renderProjects();
    }
    return true;
  } catch (error) {
    logRendererError('existing assets decision failed', error);
    if (isCurrentDecision()) showToast('Crate could not save that choice. Try again.');
    return false;
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

async function submitExistingAssetsBatchDecision(decision) {
  const project = state.projects.find(item => item.id === state.selectedProjectId);
  if (!project || !['include', 'skip'].includes(decision)) return false;
  const buttons = [$('#btn-include-all-existing'), $('#btn-skip-all-existing')].filter(Boolean);
  const clickedButton = decision === 'include' ? $('#btn-include-all-existing') : $('#btn-skip-all-existing');
  const result = await runRendererAction(`asset-review-batch:${project.id}`, clickedButton, 'Updating…', async () => {
    buttons.forEach(button => { button.disabled = true; });
    let renderedUpdatedState = false;
    try {
      const result = await window.crate.setExistingAssetsDecision(project.id, decision);
      if (!result || result.success !== true) {
        showToast('Crate could not update Existing Assets. Try again.');
        return false;
      }
      state.projects = await window.crate.getProjects();
      await renderFiles();
      renderedUpdatedState = true;
      showToast(decision === 'include' ? 'Existing assets included' : 'Existing assets skipped');
      return true;
    } catch (error) {
      logRendererError('existing assets batch decision failed', error);
      showToast('Crate could not update Existing Assets. Try again.');
      return false;
    } finally {
      if (!renderedUpdatedState) buttons.forEach(button => { button.disabled = false; });
    }
  }, clickedButton?.textContent || null);
  restoreAssetReviewBatchControls(state.projects.find(item => item.id === state.selectedProjectId));
  return result;
}

function getPendingFilesFromDecisionResult(result, decision) {
  if (decision === 'include') return Array.isArray(result?.pendingFiles) ? result.pendingFiles : null;
  return Array.isArray(result) ? result : null;
}

async function submitPendingAssetsBatchDecision(decision, project, pendingCandidates) {
  const buttons = [$('#btn-include-all-existing'), $('#btn-skip-all-existing')].filter(Boolean);
  const clickedButton = decision === 'include' ? $('#btn-include-all-existing') : $('#btn-skip-all-existing');
  const result = await runRendererAction(`asset-review-batch:${project.id}`, clickedButton, 'Updating…', async () => {
    buttons.forEach(button => { button.disabled = true; });
    let appliedCount = 0;
    let failedCount = 0;
    let renderedUpdatedState = false;
    try {
      for (const candidate of pendingCandidates) {
        if (!candidate.target) {
          failedCount += 1;
          continue;
        }

        try {
          const result = decision === 'include'
            ? await window.crate.acceptPending(project.id, candidate.target)
            : await window.crate.rejectPending(project.id, candidate.target);
          const remainingPendingFiles = getPendingFilesFromDecisionResult(result, decision);
          const candidateTargets = new Set([candidate.target, candidate.stableTarget].filter(Boolean));
          const applied = Array.isArray(remainingPendingFiles) && !remainingPendingFiles.some(file => (
            candidateTargets.has(getPendingDecisionStableKey(file))
          ));
          if (applied) appliedCount += 1;
          else failedCount += 1;
        } catch (error) {
          logRendererError('pending asset batch item failed', error);
          failedCount += 1;
        }
      }

      state.projects = await window.crate.getProjects();
      await renderFiles();
      renderedUpdatedState = true;
      const actionLabel = decision === 'include' ? 'added' : 'skipped';
      if (appliedCount === 0) {
        showToast('No eligible assets were updated. Review the list and try the batch action again.');
      } else if (failedCount > 0) {
        showToast(`${appliedCount} asset${appliedCount === 1 ? '' : 's'} ${actionLabel}; ${failedCount} left unchanged`);
      } else {
        showToast(`${appliedCount} asset${appliedCount === 1 ? '' : 's'} ${actionLabel}`);
      }
      return appliedCount > 0;
    } catch (error) {
      logRendererError('pending assets batch decision failed', error);
      showToast('Crate could not update the assets. Review the list and try the batch action again.');
      return false;
    } finally {
      if (!renderedUpdatedState) buttons.forEach(button => { button.disabled = false; });
    }
  }, clickedButton?.textContent || null);
  restoreAssetReviewBatchControls(state.projects.find(item => item.id === state.selectedProjectId));
  return result;
}

async function submitAssetReviewBatchDecision(decision) {
  const project = state.projects.find(item => item.id === state.selectedProjectId);
  if (!project || !['include', 'skip'].includes(decision)) return false;
  const excluded = new Set(project.excludedAssetKeys || []);
  const visiblePending = (project.pendingFiles || []).filter(file => (
    file && !excluded.has(getAssetReviewExclusionKey(file))
  ));
  const pendingCandidates = getPendingAssetsForBatchDecision(project);
  if (visiblePending.length > 0) {
    return submitPendingAssetsBatchDecision(decision, project, pendingCandidates.filter(candidate => candidate.target));
  }
  return submitExistingAssetsBatchDecision(decision);
}

const FILE_VISUAL_DATA_URL_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const FILE_VISUAL_MAX_DATA_URL_LENGTH = 360000;
const FILE_VISUAL_CACHE_CAPACITY = 96;
const FILE_VISUAL_CACHE_TTL_MS = 30000;
const FILE_VISUAL_MAX_CONCURRENCY = 4;
const FILE_VISUAL_MAX_QUEUE = 128;
const fileVisualCache = new Map();
const fileVisualInFlight = new Map();
const fileVisualQueue = [];
const fileVisualDeferred = new Map();
const fileVisualProjectEpochs = new Map();
let fileVisualActiveRequests = 0;
let fileVisualActiveProjectId = null;
let fileVisualPumpScheduled = false;

function getFileVisualIdentity(file) {
  if (!file || typeof file !== 'object') return null;
  return typeof file.visualIdentity === 'string' && file.visualIdentity ? file.visualIdentity : null;
}

function getFileVisualRevision(file) {
  if (!file || typeof file !== 'object') return null;
  return typeof file.visualRevision === 'string' && file.visualRevision ? file.visualRevision : null;
}

function getFileVisualFallbackLabel(file) {
  const ext = getFileExtension(file).replace(/^\./, '').toUpperCase();
  if (!ext) return 'FILE';
  return ext.length > 5 ? ext.slice(0, 5) : ext;
}

function applyResolvedFileVisual(container, result) {
  if (
    !container ||
    !result ||
    !['thumbnail', 'icon'].includes(result.kind) ||
    typeof result.dataUrl !== 'string' ||
    result.dataUrl.length > FILE_VISUAL_MAX_DATA_URL_LENGTH ||
    !FILE_VISUAL_DATA_URL_PATTERN.test(result.dataUrl)
  ) return false;

  const image = document.createElement('img');
  image.className = 'file-visual-image';
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  image.src = result.dataUrl;
  container.innerHTML = '';
  container.appendChild(image);
  container.classList.add(`is-${result.kind}`);
  return true;
}

function normalizeFileVisualResult(result) {
  if (
    result && ['thumbnail', 'icon'].includes(result.kind) &&
    typeof result.dataUrl === 'string' &&
    result.dataUrl.length <= FILE_VISUAL_MAX_DATA_URL_LENGTH &&
    FILE_VISUAL_DATA_URL_PATTERN.test(result.dataUrl)
  ) return { kind: result.kind, dataUrl: result.dataUrl };
  return { kind: 'fallback' };
}

function rememberFileVisual(cacheKey, projectId, result, now = Date.now()) {
  fileVisualCache.delete(cacheKey);
  fileVisualCache.set(cacheKey, { projectId, result, expiresAt: now + FILE_VISUAL_CACHE_TTL_MS });
  while (fileVisualCache.size > FILE_VISUAL_CACHE_CAPACITY) {
    const oldest = fileVisualCache.keys().next().value;
    if (oldest === undefined) break;
    fileVisualCache.delete(oldest);
  }
}

function getFileVisualProjectEpoch(projectId) {
  return fileVisualProjectEpochs.get(projectId) || 0;
}

function settleQueuedFileVisualTask(task, result = { kind: 'fallback' }) {
  if (!task || task.settled) return;
  task.settled = true;
  if (fileVisualInFlight.get(task.cacheKey) === task.request) {
    fileVisualInFlight.delete(task.cacheKey);
  }
  task.resolve(result);
}

function cancelQueuedFileVisualTasks(predicate) {
  for (let index = fileVisualQueue.length - 1; index >= 0; index -= 1) {
    const task = fileVisualQueue[index];
    if (!predicate(task)) continue;
    fileVisualQueue.splice(index, 1);
    settleQueuedFileVisualTask(task);
  }
  for (const [cacheKey, task] of fileVisualDeferred) {
    if (!predicate(task)) continue;
    fileVisualDeferred.delete(cacheKey);
    settleQueuedFileVisualTask(task);
  }
}

function invalidateFileVisualProject(projectId) {
  if (!projectId) return;
  fileVisualProjectEpochs.set(projectId, getFileVisualProjectEpoch(projectId) + 1);
  for (const [cacheKey, cached] of fileVisualCache) {
    if (cached.projectId === projectId) fileVisualCache.delete(cacheKey);
  }
  cancelQueuedFileVisualTasks(task => task.projectId === projectId);
}

function setActiveFileVisualProject(projectId) {
  const nextProjectId = typeof projectId === 'string' && projectId ? projectId : null;
  if (fileVisualActiveProjectId === nextProjectId) return;
  const previousProjectId = fileVisualActiveProjectId;
  fileVisualActiveProjectId = nextProjectId;
  if (previousProjectId) invalidateFileVisualProject(previousProjectId);
  cancelQueuedFileVisualTasks(task => task.projectId !== nextProjectId);
  scheduleFileVisualQueuePump();
}

function scheduleFileVisualQueuePump() {
  if (fileVisualPumpScheduled) return;
  fileVisualPumpScheduled = true;
  Promise.resolve().then(() => {
    fileVisualPumpScheduled = false;
    pumpFileVisualQueue();
  });
}

function takeNextFileVisualTask() {
  if (fileVisualQueue.length === 0) return null;
  let prioritizedIndex = -1;
  for (let index = 0; index < fileVisualQueue.length; index += 1) {
    const task = fileVisualQueue[index];
    if (fileVisualActiveProjectId && task.projectId !== fileVisualActiveProjectId) continue;
    if (
      prioritizedIndex < 0 ||
      task.priority < fileVisualQueue[prioritizedIndex].priority
    ) prioritizedIndex = index;
  }
  if (prioritizedIndex < 0) prioritizedIndex = 0;
  return fileVisualQueue.splice(prioritizedIndex >= 0 ? prioritizedIndex : 0, 1)[0] || null;
}

function getHighestPriorityFileVisualTask(tasks) {
  let selectedIndex = -1;
  for (let index = 0; index < tasks.length; index += 1) {
    if (
      selectedIndex < 0 ||
      tasks[index].priority < tasks[selectedIndex].priority
    ) selectedIndex = index;
  }
  return selectedIndex;
}

function promoteDeferredFileVisualTasks() {
  while (fileVisualQueue.length < FILE_VISUAL_MAX_QUEUE && fileVisualDeferred.size > 0) {
    const candidates = [...fileVisualDeferred.values()].filter(task => (
      !fileVisualActiveProjectId || task.projectId === fileVisualActiveProjectId
    ));
    const selectedIndex = getHighestPriorityFileVisualTask(candidates);
    if (selectedIndex < 0) return;
    const task = candidates[selectedIndex];
    fileVisualDeferred.delete(task.cacheKey);
    fileVisualQueue.push(task);
  }
}

function enqueueFileVisualTask(task) {
  if (fileVisualQueue.length < FILE_VISUAL_MAX_QUEUE) {
    fileVisualQueue.push(task);
    return;
  }

  const demotableIndex = fileVisualQueue.reduce((selectedIndex, queuedTask, index) => {
    if (
      selectedIndex < 0 ||
      queuedTask.priority > fileVisualQueue[selectedIndex].priority
    ) return index;
    return selectedIndex;
  }, -1);
  if (demotableIndex >= 0 && task.priority < fileVisualQueue[demotableIndex].priority) {
    const [demoted] = fileVisualQueue.splice(demotableIndex, 1);
    fileVisualDeferred.set(demoted.cacheKey, demoted);
    fileVisualQueue.push(task);
    return;
  }
  fileVisualDeferred.set(task.cacheKey, task);
}

function pumpFileVisualQueue() {
  promoteDeferredFileVisualTasks();
  while (fileVisualActiveRequests < FILE_VISUAL_MAX_CONCURRENCY && fileVisualQueue.length > 0) {
    const task = takeNextFileVisualTask();
    if (!task) return;
    promoteDeferredFileVisualTasks();
    fileVisualActiveRequests += 1;
    Promise.resolve()
      .then(() => window.crate.getFileVisual(task.projectId, task.identity, task.revision))
      .then(normalizeFileVisualResult)
      .catch(error => {
        logRendererError('file visual unavailable', error);
        return { kind: 'fallback' };
      })
      .then(result => {
        const current = task.epoch === getFileVisualProjectEpoch(task.projectId);
        if (current) rememberFileVisual(task.cacheKey, task.projectId, result);
        settleQueuedFileVisualTask(task, current ? result : { kind: 'fallback' });
      })
      .finally(() => {
        fileVisualActiveRequests -= 1;
        if (fileVisualInFlight.get(task.cacheKey) === task.request) {
          fileVisualInFlight.delete(task.cacheKey);
        }
        promoteDeferredFileVisualTasks();
        pumpFileVisualQueue();
      });
  }
}

function requestFileVisual(projectId, identity, revision, priority = null) {
  if (!projectId || !identity || !revision || typeof window.crate?.getFileVisual !== 'function') {
    return Promise.resolve({ kind: 'fallback' });
  }
  const cacheKey = JSON.stringify([projectId, identity, revision]);
  const cached = fileVisualCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    fileVisualCache.delete(cacheKey);
    fileVisualCache.set(cacheKey, cached);
    return Promise.resolve(cached.result);
  }
  if (cached) fileVisualCache.delete(cacheKey);
  if (fileVisualInFlight.has(cacheKey)) return fileVisualInFlight.get(cacheKey);
  let resolveRequest;
  const request = new Promise(resolve => { resolveRequest = resolve; });
  const task = {
    projectId,
    identity,
    revision,
    priority: Number.isFinite(priority) ? priority : 0,
    cacheKey,
    epoch: getFileVisualProjectEpoch(projectId),
    request,
    resolve: resolveRequest,
    settled: false,
  };
  fileVisualInFlight.set(cacheKey, request);
  enqueueFileVisualTask(task);
  if (priority === null) pumpFileVisualQueue();
  else scheduleFileVisualQueuePump();
  return request;
}

function createFileVisual(projectId, file, { priority = 0, loadVisual = true } = {}) {
  const container = document.createElement('span');
  container.className = 'file-visual file-visual-fallback';
  container.setAttribute('aria-hidden', 'true');
  const identity = getFileVisualIdentity(file);
  const revision = getFileVisualRevision(file);

  const badge = document.createElement('span');
  badge.className = 'file-visual-badge';
  badge.textContent = getFileVisualFallbackLabel(file);
  container.appendChild(badge);

  if (!loadVisual || !projectId || !identity || !revision) return container;
  requestFileVisual(projectId, identity, revision, priority).then(result => applyResolvedFileVisual(container, result));
  return container;
}

function appendFileStatusBadge(row, label, className, title) {
  const badge = document.createElement('span');
  badge.className = `file-status-badge ${className}`;
  badge.textContent = label;
  if (title) badge.title = title;
  row.appendChild(badge);
}

function appendAssetFileRemovalAction(row, project, file, { recovery = false } = {}) {
  const removeButton = document.createElement('button');
  const displayName = file && file.name ? file.name : 'this asset';
  removeButton.type = 'button';
  removeButton.className = recovery ? 'app-file-recovery' : 'app-file-remove';
  removeButton.textContent = recovery ? 'Remove' : '\u00D7';
  removeButton.title = recovery
    ? `Remove ${displayName} after its first scan failed`
    : `Exclude ${displayName}`;
  removeButton.setAttribute(
    'aria-label',
    recovery
      ? `Remove ${displayName} and recover this project from the failed first scan`
      : `Exclude ${displayName} from this project`
  );
  removeButton.addEventListener('click', async event => {
    event.stopPropagation();
    removeButton.disabled = true;
    try {
      await window.crate.removeFile(project.id, getFileVisualIdentity(file));
      state.projects = await window.crate.getProjects();
      await renderFiles();
    } catch (error) {
      logRendererError(recovery ? 'source recovery failed' : 'asset exclusion failed', error);
      showToast(recovery
        ? 'Crate could not remove that failed source. Try again.'
        : 'Crate could not exclude that asset. Try again.');
      removeButton.disabled = false;
    }
  });
  row.appendChild(removeButton);
}

function appendAssetFileRestorationAction(row, project, file) {
  const restoreButton = document.createElement('button');
  const displayName = file && file.name ? file.name : 'this asset';
  restoreButton.type = 'button';
  restoreButton.className = 'app-file-remove';
  restoreButton.textContent = '\u00D7';
  restoreButton.title = `Include ${displayName}`;
  restoreButton.setAttribute('aria-label', `Include ${displayName} in this project`);
  restoreButton.addEventListener('click', async event => {
    event.stopPropagation();
    restoreButton.disabled = true;
    try {
      await window.crate.removeFile(project.id, getFileVisualIdentity(file));
      state.projects = await window.crate.getProjects();
      await renderFiles();
    } catch (error) {
      logRendererError('asset restoration failed', error);
      showToast('Crate could not include that asset. Try again.');
      restoreButton.disabled = false;
    }
  });
  row.appendChild(restoreButton);
}

function createAssetFileRow(
  project,
  file,
  {
    excluded = false,
    protectedSource = false,
    sourceRecoveryAllowed = false,
    previewPriority = 0,
    loadVisual = true,
    selectable = false,
  } = {}
) {
  const row = document.createElement('div');
  row.className = `app-file asset-file-row${excluded ? ' is-excluded' : ''}${protectedSource ? ' is-protected' : ''}${sourceRecoveryAllowed ? ' is-recoverable' : ''}`;
  row.setAttribute('role', 'listitem');
  row.dataset.assetCategory = excluded
    ? 'excluded'
    : (file?.assetOrigin === 'existing' ? 'existing' : 'added');
  row.dataset.assetSearch = getAssetReviewSearchText(file);
  if (selectable) {
    const selected = state.assetReviewSelectedKey === getRendererItemKey(file);
    row.tabIndex = 0;
    row.setAttribute('aria-selected', String(selected));
    row.classList.toggle('is-selected', selected);
    const select = () => {
      state.assetReviewSelectedKey = row.dataset.renderKey || getRendererItemKey(file);
      const list = row.parentElement;
      if (list?.__assetReviewVirtualState) {
        renderVirtualAssetList(list, list.__assetReviewVirtualState.items, list.__assetReviewVirtualState.build);
      }
    };
    row.addEventListener('click', event => {
      if (event.target?.closest?.('button')) return;
      select();
    });
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select();
    });
  }
  row.appendChild(createFileVisual(project && project.id, file, {
    priority: previewPriority,
    loadVisual,
  }));

  const copy = document.createElement('div');
  copy.className = 'asset-file-copy';
  const name = document.createElement('div');
  name.className = 'app-file-name';
  name.textContent = file && file.name ? file.name : 'Untitled file';
  name.title = name.textContent;
  copy.appendChild(name);
  appendAppOriginLabel(copy, file, project, { includeSource: !protectedSource });
  row.appendChild(copy);

  let hasStatusBadge = false;
  if (file && file.embedded) {
    appendFileStatusBadge(row, 'EMB', 'embedded', 'Embedded - extracted at package time');
    hasStatusBadge = true;
  } else if (file && file.linked === true) {
    appendFileStatusBadge(row, 'LNK', 'linked', 'Linked file - confirmed path');
    hasStatusBadge = true;
  }
  if (protectedSource && sourceRecoveryAllowed) {
    appendFileStatusBadge(row, 'Scan failed', 'recovery', 'Remove this source to recover the project, then add a valid project file');
    appendAssetFileRemovalAction(row, project, file, { recovery: true });
  } else if (protectedSource) {
    appendFileStatusBadge(row, 'Ready', 'protected', 'Working files are always included');
  } else if (excluded) {
    appendFileStatusBadge(row, 'Excluded', 'excluded', 'Excluded from this package');
    appendAssetFileRestorationAction(row, project, file);
  } else {
    if (!hasStatusBadge) appendFileStatusBadge(row, 'Included', 'included', 'Included in this package');
    appendAssetFileRemovalAction(row, project, file);
  }
  return row;
}

function setAssetPanelCount(element, includedCount, totalCount = includedCount) {
  if (!element) return;
  element.textContent = includedCount === totalCount
    ? `${includedCount}`
    : `${includedCount} of ${totalCount}`;
}

function renderAssetPanelList(list, project, files, options = {}) {
  if (!list) return;
  setAssetReviewProject(project.id);
  const allFiles = Array.isArray(files) ? files : [];
  allFiles.forEach(getRendererItemKey);
  const buildRow = file => createAssetFileRow(project, file, {
    excluded: file.excluded === true,
    protectedSource: file.protectedSource === true || options.protectedSource === true,
    sourceRecoveryAllowed: file.sourceRecoveryAllowed === true,
    previewPriority: options.previewPriority || 0,
    loadVisual: options.loadVisual !== false,
    selectable: options.selectable === true,
  });
  if (!Array.isArray(files) || files.length === 0) {
    const emptyMessage = options.emptyMessage || 'No assets in this group.';
    resetVirtualAssetList(list);
    reconcileKeyedList(list, [{ empty: true, message: emptyMessage }], item => {
      const empty = document.createElement('div');
      empty.className = 'asset-panel-empty';
      empty.textContent = item.message;
      return empty;
    }, item => `empty:${item.message}`);
    return;
  }
  // Only Review Assets panels opt into fixed virtual rows. Working Files keeps
  // its normal grid flow, spacing, and scroll position on same-project refreshes.
  if (options.virtualized !== true && list.__assetReviewVirtualState) {
    resetVirtualAssetList(list);
    reconcileKeyedList(list, [], () => null);
  }
  list.__assetReviewAllItems = allFiles;
  if (options.virtualized === true) renderVirtualAssetList(list, allFiles, buildRow);
  else reconcileKeyedList(list, allFiles, buildRow);
}

function createRecentAssetCard(project, file, { previewPriority = 0, loadVisual = true } = {}) {
  const card = document.createElement('div');
  card.className = 'recent-asset-card';
  card.setAttribute('role', 'listitem');
  card.appendChild(createFileVisual(project.id, file, { priority: previewPriority, loadVisual }));
  const name = document.createElement('span');
  name.textContent = file?.name || 'Untitled asset';
  name.title = name.textContent;
  card.appendChild(name);
  appendAppOriginLabel(card, file, project);
  return card;
}

function appendDefinitionRow(list, label, value, className = '') {
  if (!list) return;
  const row = document.createElement('div');
  row.className = `asset-origin-row${className ? ` ${className}` : ''}`;
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = String(value);
  row.appendChild(term);
  row.appendChild(description);
  list.appendChild(row);
}

function setCountText(id, value) {
  const element = $(`#${id}`);
  if (element) element.textContent = String(value);
}

function applyAssetReviewFilter() {
  const filter = state.assetReviewFilter || 'all';
  const query = String(state.assetReviewQuery || '').trim().toLowerCase();
  const logicalItems = state.assetReviewLogicalItems || {};
  const filterItems = (items, category) => (Array.isArray(items) ? items : []).filter(file => {
    const matchesFilter = filter === 'all'
      || (filter === 'excluded' && file.excluded === true)
      || (filter === category && file.excluded !== true);
    return matchesFilter && (!query || getAssetReviewSearchText(file).includes(query));
  });
  const listDefinitions = [
    { listId: 'working-assets-list', category: 'working', items: logicalItems.working },
    { listId: 'existing-assets-list', category: 'existing', items: logicalItems.existing },
    { listId: 'added-assets-list', category: 'added', items: logicalItems.added },
  ];
  for (const { listId, category, items } of listDefinitions) {
    const list = $(`#${listId}`);
    if (!list) continue;
    if (list.__assetReviewVirtualState) {
      setVirtualAssetItems(
        list,
        filterItems(items, category),
        list.__assetReviewVirtualState.build,
      );
    } else {
      const visibleKeys = new Set(filterItems(items, category).map(getRendererItemKey));
      for (const row of list.children || []) {
        if (category === 'working') {
          row.classList.toggle('filtered-out', !visibleKeys.has(row.dataset?.renderKey));
        } else if (!Array.isArray(list.__assetReviewAllItems)) {
          const rowCategory = row.dataset?.assetCategory || category;
          const matchesFilter = filter === 'all' || filter === rowCategory || (filter === 'excluded' && rowCategory === 'excluded');
          const matchesQuery = !query || String(row.dataset?.assetSearch || '').includes(query);
          row.classList.toggle('filtered-out', !matchesFilter || !matchesQuery);
        }
      }
    }
    const section = list.parentElement || null;
    if (section && typeof section.classList?.toggle === 'function') {
      const isWorking = category === 'working';
      section.classList.toggle('filtered-out', isWorking
        ? filter !== 'all' || filterItems(items, category).length === 0
        : filter === 'missing' || filter === 'existing' && category !== 'existing' || filter === 'added' && category !== 'added' || filter === 'excluded' && filterItems(items, category).length === 0);
    }
  }
  const pending = $('#pending-section');
  const pendingList = $('#pending-file-list');
  if (pending && pendingList) {
    const filteredPending = filterItems(logicalItems.missing, 'missing');
    if (pendingList.__assetReviewVirtualState) {
      setVirtualAssetItems(pendingList, filteredPending, pendingList.__assetReviewVirtualState.build);
      pending.classList.toggle('filtered-out', !['all', 'missing'].includes(filter) || filteredPending.length === 0);
    } else {
      let visiblePendingCount = 0;
      for (const row of pendingList.children || []) {
        const matchesQuery = !query || String(row.dataset?.assetSearch || '').includes(query);
        const visible = ['all', 'missing'].includes(filter) && matchesQuery;
        row.classList.toggle('filtered-out', !visible);
        if (visible) visiblePendingCount += 1;
      }
      pending.classList.toggle('filtered-out', !['all', 'missing'].includes(filter) || visiblePendingCount === 0);
    }
  }
  $$('.asset-filter').forEach(button => {
    const active = button.dataset.assetFilter === filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function renderAssetDashboard(project, sourceFiles, existingAssets, addedAssets, pendingFiles) {
  const includedExisting = existingAssets.filter(file => file.excluded !== true);
  const excluded = [...existingAssets, ...addedAssets].filter(file => file.excluded === true);
  const includedAdded = addedAssets.filter(file => file.excluded !== true);
  setCountText('metric-existing-count', includedExisting.length);
  setCountText('metric-added-count', includedAdded.length);
  setCountText('metric-missing-count', pendingFiles.length);
  setCountText('metric-excluded-count', excluded.length);
  setCountText('filter-count-all', existingAssets.length + addedAssets.length + pendingFiles.length);
  setCountText('filter-count-existing', includedExisting.length);
  setCountText('filter-count-added', includedAdded.length);
  setCountText('filter-count-missing', pendingFiles.length);
  setCountText('filter-count-excluded', excluded.length);

  const alert = $('#project-linking-alert');
  if (alert) {
    alert.textContent = pendingFiles.length
      ? `${pendingFiles.length} file${pendingFiles.length === 1 ? ' needs' : 's need'} review`
      : '';
    alert.classList.toggle('hidden', pendingFiles.length === 0);
  }

  const recentList = $('#recent-assets-list');
  if (recentList) {
    const recent = [...includedExisting, ...includedAdded].slice(-5).reverse();
    reconcileKeyedList(recentList, recent, file => createRecentAssetCard(project, file, {
      previewPriority: state.assetReviewOpen ? 10 : 0,
      loadVisual: state.assetReviewOpen !== true,
    }));
    const remaining = Math.max(0, includedExisting.length + includedAdded.length - recent.length);
    const moreKey = 'recent-more';
    const existingMore = Array.from(recentList.children || []).find(child => child.dataset?.renderKey === moreKey);
    if (existingMore) recentList.removeChild(existingMore);
    if (remaining > 0) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'recent-assets-more';
      more.dataset.renderKey = moreKey;
      more.dataset.renderSignature = String(remaining);
      more.textContent = `+${remaining}`;
      more.setAttribute('aria-label', `Review ${remaining} more assets`);
      more.addEventListener('click', openAssetReviewWorkspace);
      recentList.appendChild(more);
    }
  }

  const originList = $('#asset-origin-list');
  if (originList) {
    originList.innerHTML = '';
    const originCounts = new Map();
    for (const file of [...includedExisting, ...includedAdded]) {
      const label = getFileAppPresentation(file, project).label;
      if (label) originCounts.set(label, (originCounts.get(label) || 0) + 1);
    }
    for (const [label, count] of [...originCounts.entries()].sort((a, b) => b[1] - a[1])) {
      appendDefinitionRow(originList, label, count);
    }
    if (pendingFiles.length) appendDefinitionRow(originList, 'Needs Review', pendingFiles.length, 'warning');
  }

  const totalIncludedAssets = includedExisting.length + includedAdded.length;
  const summary = `${totalIncludedAssets} asset${totalIncludedAssets === 1 ? '' : 's'} included` +
    ` · ${sourceFiles.length} Working File${sourceFiles.length === 1 ? '' : 's'} ready` +
    `${pendingFiles.length ? ` · ${pendingFiles.length} need attention` : ''}`;
  const reviewSummary = $('#asset-review-summary');
  const reviewFooter = $('#asset-review-footer-summary');
  if (reviewSummary) reviewSummary.textContent = summary;
  if (reviewFooter) reviewFooter.textContent = summary;
}

function openAssetReviewWorkspace() {
  state.assetReviewOpen = true;
  $('#project-dashboard')?.classList.add('hidden');
  $('#asset-review-workspace')?.classList.remove('hidden');
  $('#asset-review-heading')?.focus?.();
  applyAssetReviewFilter();
}

function closeAssetReviewWorkspace() {
  state.assetReviewOpen = false;
  $('#asset-review-workspace')?.classList.add('hidden');
  $('#project-dashboard')?.classList.remove('hidden');
  $('#btn-review-assets')?.focus?.();
}

function renderAssetWorkspace(project, options = {}, presentedFiles = null) {
  if (!project) return;
  setAssetReviewProject(project.id);
  const files = Array.isArray(presentedFiles) ? presentedFiles : (Array.isArray(project.files) ? project.files : []);
  const physicalSourceFiles = files.filter(file => file && (file.protectedSource === true || file.projectRole === 'source'));
  const figmaSourceIdentities = new Set();
  const keylessFigmaSourceNames = [];
  let keylessFigmaSourceNameCursor = 0;
  const figmaSourceFiles = [];
  const trackedFigmaFiles = Array.isArray(options.trackedFigmaFiles) ? options.trackedFigmaFiles : null;
  for (const file of files) {
    if (file?.appFamily !== 'figma' || typeof file.sourceName !== 'string' || !file.sourceName.trim()) continue;
    const sourceName = file.sourceName.trim();
    const identity = typeof file.figmaSourceIdentity === 'string' && file.figmaSourceIdentity.trim()
      ? file.figmaSourceIdentity.trim()
      : null;
    // A display name is not an identity.  Keyless records remain visible
    // independently so same-name Figma files cannot hide one another.
    if (!identity && Array.isArray(project.figmaTrackedFiles) && project.figmaTrackedFiles.length > 0) {
      keylessFigmaSourceNames.push(sourceName);
      continue;
    }
    if (identity && figmaSourceIdentities.has(identity)) continue;
    if (identity) figmaSourceIdentities.add(identity);
    figmaSourceFiles.push({
      name: sourceName,
      ext: '',
      appFamily: 'figma',
      sourceName: null,
      assetOrigin: 'added',
      projectRole: 'source',
      protectedSource: true,
      sourceRecoveryAllowed: false,
      excluded: false,
      visualIdentity: identity ? `figma-source:${identity}` : null,
      visualRevision: identity ? `figma-source:${identity}` : null,
    });
  }
  // Merge the authoritative safe tracked-file projection with materialized
  // rows per source.  Its identity is opaque when present; keyless records
  // remain separate objects and never use a display name as a key.
  const authoritativeTrackedFiles = trackedFigmaFiles || (
    figmaSourceFiles.length === 0 && Array.isArray(project.figmaTrackedFiles)
      ? project.figmaTrackedFiles.map(trackedFile => ({
        displayName: trackedFile?.displayName || trackedFile?.name || null,
        figmaSourceIdentity: null,
      }))
      : []
  );
  for (const trackedFile of authoritativeTrackedFiles) {
      const identity = typeof trackedFile?.figmaSourceIdentity === 'string' && trackedFile.figmaSourceIdentity.trim()
        ? trackedFile.figmaSourceIdentity.trim()
        : null;
      const trackedDisplayName = trackedFile?.displayName || trackedFile?.name || null;
      const sourceName = trackedDisplayName || keylessFigmaSourceNames[keylessFigmaSourceNameCursor++] || 'Figma file';
      if (identity && figmaSourceIdentities.has(identity)) continue;
      if (identity) figmaSourceIdentities.add(identity);
      figmaSourceFiles.push({
        name: sourceName,
        ext: '',
        appFamily: 'figma',
        sourceName: null,
        assetOrigin: 'added',
        projectRole: 'source',
        protectedSource: true,
        sourceRecoveryAllowed: false,
        excluded: false,
        visualIdentity: identity ? `figma-source:${identity}` : null,
        visualRevision: identity ? `figma-source:${identity}` : null,
      });
  }
  const sourceFiles = [...physicalSourceFiles, ...figmaSourceFiles];
  const existingAssets = files.filter(file => (
    file && file.protectedSource !== true && file.projectRole !== 'source' && file.assetOrigin === 'existing'
  ));
  const addedAssets = files.filter(file => (
    file && file.protectedSource !== true && file.projectRole !== 'source' &&
    file.assetOrigin !== 'existing'
  ));

  renderAssetPanelList($('#working-assets-list'), project, sourceFiles, {
    protectedSource: true,
    emptyMessage: 'No working files tracked yet.',
    previewPriority: state.assetReviewOpen ? 10 : 0,
    loadVisual: false,
  });
  setAssetPanelCount($('#working-assets-count'), sourceFiles.length);

  renderAssetPanelList($('#project-file-list'), project, sourceFiles, {
    protectedSource: true,
    emptyMessage: 'Add a project file to begin.',
    previewPriority: state.assetReviewOpen ? 10 : 0,
    loadVisual: false,
  });
  renderAssetPanelList($('#existing-assets-list'), project, existingAssets, {
    virtualized: true,
    emptyMessage: 'No existing assets found.',
    previewPriority: state.assetReviewOpen ? 0 : 10,
    loadVisual: false,
    selectable: true,
  });
  renderAssetPanelList($('#added-assets-list'), project, addedAssets, {
    virtualized: true,
    emptyMessage: options.hasActiveCandidates
      ? 'No package-ready assets yet. Review the files Crate observed.'
      : 'New package-ready assets will appear here as you work.',
    previewPriority: state.assetReviewOpen ? 0 : 10,
    loadVisual: false,
    selectable: true,
  });

  setAssetPanelCount($('#project-file-count'), sourceFiles.length);
  const includedExistingCount = existingAssets.filter(file => file.excluded !== true).length;
  setAssetPanelCount($('#existing-assets-count'), includedExistingCount, existingAssets.length);
  const includedAddedCount = addedAssets.filter(file => file.excluded !== true).length;
  setAssetPanelCount($('#added-assets-count'), includedAddedCount, addedAssets.length);

  const pendingFiles = state.assetWorkspace?.projectId === project.id
    ? (state.assetWorkspace.pendingFiles || []).filter(file => file.excluded !== true)
    : [];
  const pendingReviewFiles = $('#pending-file-list')?.__assetReviewAllItems || [];
  state.assetReviewLogicalItems = {
    working: sourceFiles,
    existing: existingAssets,
    added: addedAssets,
    missing: pendingReviewFiles,
  };
  renderAssetDashboard(project, sourceFiles, existingAssets, addedAssets, pendingFiles);
  applyAssetReviewFilter();

  $('#existing-assets-section')?.classList.toggle('hidden', existingAssets.length === 0);
  $('#working-assets-section')?.classList.toggle('hidden', sourceFiles.length === 0);
  updateAssetReviewBatchControls(project, existingAssets, includedExistingCount);
  $('#project-dashboard')?.classList.toggle('hidden', state.assetReviewOpen === true);
  $('#asset-review-workspace')?.classList.toggle('hidden', state.assetReviewOpen !== true);
}

// Compatibility helper retained for focused renderer tests and non-project empty states.
function renderFileList(files, options = {}) {
  const container = $('#file-list');
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(files) || files.length === 0) {
    const message = options.hasActiveCandidates
      ? 'No package-ready files yet. Review the files Crate observed during this session.'
      : 'No files tracked yet. Files will appear as you work.';
    container.innerHTML = `<div class="files-empty">${escapeHtml(message)}</div>`;
    return;
  }
  const project = state.projects.find(item => item.id === state.selectedProjectId) || {
    id: state.selectedProjectId,
    files,
    excludedAssetKeys: [],
  };
  for (const file of files) container.appendChild(createAssetFileRow(project, file, {
    protectedSource: file?.protectedSource === true || file?.projectRole === 'source',
  }));
}

const PENDING_APP_LABELS = {
  illustrator: 'Illustrator',
  photoshop: 'Photoshop',
  indesign: 'InDesign',
  figma: 'Figma',
  powerpoint: 'PowerPoint',
  presentation: 'Presentation',
  keynote: 'Keynote',
  sketch: 'Sketch',
  'adobe-xd': 'Adobe XD',
  affinity: 'Affinity',
};

const FILE_APP_PRESENTATION = {
  illustrator: { label: 'Illustrator', mark: 'Ai', className: 'illustrator' },
  photoshop: { label: 'Photoshop', mark: 'Ps', className: 'photoshop' },
  indesign: { label: 'InDesign', mark: 'Id', className: 'indesign' },
  figma: { label: 'Figma', mark: 'F', className: 'figma' },
  powerpoint: { label: 'PowerPoint', mark: 'P', className: 'powerpoint' },
  presentation: { label: 'Presentation', mark: 'P', className: 'powerpoint' },
  keynote: { label: 'Keynote', mark: 'K', className: 'keynote' },
  sketch: { label: 'Sketch', mark: 'S', className: 'sketch' },
  'adobe-xd': { label: 'Adobe XD', mark: 'Xd', className: 'adobe-xd' },
  affinity: { label: 'Affinity', mark: 'Af', className: 'affinity' },
  generic: { label: '', mark: '', className: 'generic' },
};

function getAppFamilyFromExtension(file) {
  const ext = getFileExtension(file);
  if (['.ai', '.eps', '.svg'].includes(ext)) return 'illustrator';
  if (['.psd', '.psb', '.pxd'].includes(ext)) return 'photoshop';
  if (['.indd', '.idml'].includes(ext)) return 'indesign';
  if (ext === '.fig') return 'figma';
  if (['.ppt', '.pptx', '.pptm'].includes(ext)) return 'powerpoint';
  if (['.key', '.keynote'].includes(ext)) return 'keynote';
  if (ext === '.sketch') return 'sketch';
  if (ext === '.xd') return 'adobe-xd';
  if (['.afdesign', '.afphoto', '.afpub'].includes(ext)) return 'affinity';
  return null;
}

function getFileAppPresentation(file, project = null) {
  let family = file && typeof file.appFamily === 'string' ? file.appFamily : null;
  if (family === 'presentation') {
    const sourceFamily = getAppFamilyFromExtension({
      name: sanitizeRendererSourceName(file?.sourceName),
    });
    const fileFamily = getAppFamilyFromExtension(file);
    family = ['keynote', 'powerpoint'].includes(sourceFamily)
      ? sourceFamily
      : (['keynote', 'powerpoint'].includes(fileFamily) ? fileFamily : 'presentation');
  }
  if (!family && projectHasFigmaContext(project) && file?.projectRole === 'asset' && file?.assetOrigin) {
    family = file.sourceName ? null : getAppFamilyFromExtension(file);
  }
  family = family || getAppFamilyFromExtension(file) || 'generic';
  return { family, ...(FILE_APP_PRESENTATION[family] || FILE_APP_PRESENTATION.generic) };
}

function createAppOriginLabel(file, project, { includeSource = true } = {}) {
  const app = getFileAppPresentation(file, project);
  const safeSourceName = sanitizeRendererSourceName(file?.sourceName);
  if (app.family === 'generic' && !safeSourceName) return null;
  const wrapper = document.createElement('div');
  wrapper.className = `file-origin${app.family === 'generic' ? ' file-origin-context-only' : ''}`;
  const label = document.createElement('span');
  label.className = 'file-origin-label';
  if (app.family !== 'generic') {
    const mark = document.createElement('span');
    mark.className = `file-origin-mark ${app.className}`;
    mark.textContent = app.mark;
    mark.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(mark);
  }
  const sourceName = includeSource && app.family !== 'figma' && safeSourceName
    ? ` · ${safeSourceName}`
    : '';
  const figmaScope = app.family === 'figma' && projectHasFigmaContext(project)
    ? ` · ${getProjectFigmaScopeMode(project) === 'entire-file' ? 'Entire File' : 'Current Page'}`
    : '';
  label.textContent = app.family === 'generic'
    ? safeSourceName
    : `${app.label}${sourceName || figmaScope}`;
  label.title = label.textContent;
  wrapper.appendChild(label);
  return wrapper;
}

function appendAppOriginLabel(parent, file, project, options = {}) {
  const originLabel = createAppOriginLabel(file, project, options);
  if (originLabel) parent.appendChild(originLabel);
}

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
    const safeSourceName = sanitizeRendererSourceName(evidence.sourceName);
    if (safeSourceName) return `Linked asset observed from ${safeSourceName}. Save to make package-ready.`;
    if (appLabel) return `Observed in ${appLabel}. Save to make package-ready.`;
    return 'Save to make package-ready.';
  }

  if (stateValue === 'observed') {
    return appLabel ? `Observed in ${appLabel}.` : 'Opened during this session.';
  }

  return appLabel ? `Needs review before packaging. Observed in ${appLabel}.` : 'Needs review before packaging.';
}

function createFileRow(file) {
  const project = state.projects.find(item => item.id === state.selectedProjectId) || {
    id: state.selectedProjectId,
  };
  return createAssetFileRow(project, file, {
    protectedSource: file && (file.protectedSource === true || file.projectRole === 'source'),
  });
}

// ===== Render Pending (Tier 2) Files =====
function renderPendingFiles(project, presentedPendingFiles = null) {
  const section = $('#pending-section');
  const list = $('#pending-file-list');
  if (!section || !list) return;
  setAssetReviewProject(project.id);

  const presentations = Array.isArray(presentedPendingFiles)
    ? presentedPendingFiles.filter(file => file.excluded !== true)
    : [];
  // Compose once against authoritative raw entries; filtering must reuse these
  // objects rather than attempt to rebind a cloned presentation by its name.
  const pending = getVisiblePendingAssetEntries(project).map(({ rawFile, sourceIndex }) => {
    const presentation = getPendingWorkspacePresentation(rawFile, sourceIndex, presentations);
    const file = presentation
      ? { ...rawFile, ...presentation }
      : { ...rawFile, protectedSource: true, visualIdentity: null, sourceName: null };
    rendererFallbackItemKeys.set(file, getRendererItemKey(rawFile));
    return file;
  });
  pending.forEach(getRendererItemKey);

  if (pending.length === 0) {
    section.classList.add('hidden');
    resetVirtualAssetList(list);
    reconcileKeyedList(list, [], () => null);
    return;
  }

  section.classList.remove('hidden');
  const buildPendingRow = file => {
    const row = document.createElement('div');
    row.className = 'pending-file';
    row.setAttribute('role', 'listitem');
    row.dataset.assetCategory = 'missing';
    row.dataset.assetSearch = getAssetReviewSearchText(file);
    const selected = state.assetReviewSelectedKey === getRendererItemKey(file);
    row.tabIndex = 0;
    row.setAttribute('aria-selected', String(selected));
    row.classList.toggle('is-selected', selected);
    const select = () => {
      state.assetReviewSelectedKey = row.dataset.renderKey || getRendererItemKey(file);
      renderVirtualAssetList(list, list.__assetReviewVirtualState.items, list.__assetReviewVirtualState.build);
    };
    row.addEventListener('click', event => {
      if (event.target?.closest?.('button')) return;
      select();
    });
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select();
    });
    const reason = getPendingFileReason(file);
    const stateLabel = getPendingCaptureState(file) === 'needs-save'
      ? 'Needs Save'
      : (getPendingCaptureState(file) === 'observed' ? 'Opened' : 'Needs Review');

    row.appendChild(createFileVisual(project.id, file, { loadVisual: false }));
    const copy = document.createElement('span');
    copy.className = 'pending-file-copy';
    const name = document.createElement('span');
    name.className = 'app-file-name pending-file-name';
    name.textContent = file.name || 'Untitled file';
    name.title = name.textContent;
    const reasonElement = document.createElement('span');
    reasonElement.className = 'pending-file-reason';
    reasonElement.textContent = reason;
    copy.appendChild(name);
    copy.appendChild(reasonElement);
    row.appendChild(copy);

    const stateBadge = document.createElement('span');
    stateBadge.className = 'pending-state-badge';
    stateBadge.textContent = stateLabel;
    row.appendChild(stateBadge);

    return row;
  };
  list.__assetReviewAllItems = pending;
  renderVirtualAssetList(list, pending, buildPendingRow);
}

// ===== Render Settings =====
function renderSettingsControls() {
  $('#input-naming-template').value = state.settings.namingTemplate || DEFAULT_NAMING_TEMPLATE;
  $('#toggle-notifications').checked = state.settings.notifications || false;
  $('#toggle-diagnostic-report').checked = state.settings.includeDiagnosticReport === true;
  $('#toggle-package-details').checked = state.settings.showPackageDetails !== false;
  $('#toggle-package-folders').checked = getPackageOutputLayoutMode() === PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION;

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
  if (!modal) return;
  modal.classList.add('hidden');
  modal.removeEventListener('keydown', handlePackageLimitKeydown);
  releaseModalLease('modal-upgrade');
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
  const lease = claimModalLease('modal-upgrade');
  if (!lease) return false;
  const packageLimit = Number(result.packageLimit || state.usage.packageLimit || state.usage.limit) || 10;
  const title = $('#upgrade-title');
  if (title) title.textContent = `You've used all ${packageLimit} packages`;
  $('#upgrade-days-left').textContent = result.daysLeft;
  const modal = $('#modal-upgrade');
  if (!modal) {
    releaseModalLease('modal-upgrade', lease.sessionId);
    return false;
  }
  state.packageReviewToken = null;
  upgradeModalOpener = opener;
  setModalBackgroundState(true);
  modal.classList.remove('hidden');
  modal.removeEventListener('keydown', handlePackageLimitKeydown);
  modal.addEventListener('keydown', handlePackageLimitKeydown);
  const focusTarget = $('#btn-dismiss-upgrade') || getPackageLimitFocusableElements()[0] || modal;
  focusTarget.focus();
  return true;
}

// ===== Package Flow =====
const PACKAGE_REVIEW_CHANGED_MESSAGE = 'Your project changed. Review the updated files before packaging.';
const PACKAGE_REVIEW_UNAVAILABLE_MESSAGE = 'Some files are unavailable. Resolve them before packaging.';
const PACKAGE_REVIEW_RECOVERY_MESSAGE = 'Packaging could not finish. Review the files and try again.';
const PACKAGE_SCAN_INCOMPLETE_MESSAGE = 'Crate could not finish checking project files. No package was created. Record the diagnostic below before retrying.';
const PACKAGE_LAYOUT_CHANGED_MESSAGE = 'Package organization changed. Review the updated destinations before packaging.';
const PACKAGE_REVIEW_DIAGNOSTIC_PHASES = new Set([
  'pre-package-discovery',
  'pre-package-app-scan',
  'pre-package-scan-in-flight',
  'package-input-scan-wait',
  'prepare-package-review',
]);

function setModalBackgroundState(blocked) {
  const shouldBlock = Boolean(blocked) || getVisibleBlockingModalIds().length > 0;
  for (const id of ['app-sidebar', 'app-main']) {
    const element = $(`#${id}`);
    if (!element) continue;
    element.inert = shouldBlock;
    if (shouldBlock) element.setAttribute('aria-hidden', 'true');
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
  const reviewDialog = document.querySelector('.package-review-modal');
  if (reviewDialog) reviewDialog.scrollTop = 0;
  const reviewMessage = $('#modal-package-review-message');
  if (reviewMessage && !reviewMessage.classList.contains('hidden') && !reviewMessage.classList.contains('is-empty')) {
    reviewMessage.focus({ preventScroll: true });
    return;
  }
  const cancelButton = $('#btn-cancel-package');
  const focusTarget = cancelButton && !cancelButton.disabled
    ? cancelButton
    : getPackageReviewFocusableElements()[0] || $('#modal-package');
  focusTarget?.focus?.({ preventScroll: true });
}

function openPackageReviewDialog(suppliedLease = null) {
  const modal = $('#modal-package');
  if (!modal || !packageReviewModalProjectId || (state.selectedProjectId && packageReviewModalProjectId !== state.selectedProjectId)) return false;
  const lease = suppliedLease || claimModalLease('modal-package');
  if (!lease) return false;
  if (suppliedLease) {
    if (
      packageReviewModalSessionId !== suppliedLease.sessionId ||
      !isCurrentModalLease('modal-package', suppliedLease.sessionId)
    ) return false;
  } else {
    packageReviewModalSessionId = lease.sessionId;
  }
  packageReviewModalSessionId = lease.sessionId;
  setModalBackgroundState(true);
  modal.classList.remove('hidden');
  focusPackageReviewDialog();
  return true;
}

function hidePackageReviewDialog({ restoreFocus = false, preserveOpener = false } = {}) {
  $('#modal-package')?.classList.add('hidden');
  releaseModalLease('modal-package', packageReviewModalSessionId);
  packageReviewModalSessionId = null;
  packageReviewModalProjectId = null;
  packageReviewModalSelectionEpoch = null;
  packageReviewModalRequestId = null;
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
  if (!modal) return;
  modal.classList.add('hidden');
  modal.removeEventListener('keydown', handlePackageSuccessKeydown);
  releaseModalLease('modal-success');
  setModalBackgroundState(false);
  const opener = packageReviewOpener;
  packageReviewOpener = null;
  switchTab('projects');
  const projectsTab = document.querySelector('.app-tab[data-tab="projects"]');
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
  if (!modal) return false;
  const lease = claimModalLease('modal-progress');
  if (!lease) return false;
  setModalBackgroundState(true);
  modal.classList.remove('hidden');
  modal.focus();
  return true;
}

function hidePackageProgressModal() {
  $('#modal-progress')?.classList.add('hidden');
  releaseModalLease('modal-progress');
  setModalBackgroundState(false);
}

function showPackageSuccessModal() {
  const modal = $('#modal-success');
  if (!modal) return false;
  const lease = claimModalLease('modal-success');
  if (!lease) return false;
  setModalBackgroundState(true);
  modal.classList.remove('hidden');
  modal.removeEventListener('keydown', handlePackageSuccessKeydown);
  modal.addEventListener('keydown', handlePackageSuccessKeydown);
  const focusTarget = $('#btn-success-done') || getPackageSuccessFocusableElements()[0] || modal;
  focusTarget.focus();
  return true;
}

function cancelPackageReview() {
  if (packageReviewConfirmationInFlight) return;
  state.packageReviewToken = null;
  hidePackageReviewDialog({ restoreFocus: true });
}

function changePackageReviewSelection() {
  if (packageReviewConfirmationInFlight) return;
  state.packageReviewToken = null;
  state.assetReviewOpen = true;
  hidePackageReviewDialog();
  switchTab('current-project');
  openAssetReviewWorkspace();
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

function getPackageDestinationLabel(outputPath) {
  return typeof outputPath === 'string' && outputPath ? 'Selected output folder' : '~/Desktop/';
}

function getPackageOutputLayoutMode(settings = state.settings) {
  if (
    settings &&
    Object.prototype.hasOwnProperty.call(settings, 'packageOutputLayoutMode')
  ) {
    return settings.packageOutputLayoutMode === PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
      ? PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
      : PACKAGE_OUTPUT_LAYOUT_MODES.FLAT;
  }
  return PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION;
}

function syncPackageOutputLayoutControls(layoutMode = getPackageOutputLayoutMode()) {
  const organized = layoutMode === PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION;
  const settingsToggle = $('#toggle-package-folders');
  const reviewToggle = $('#toggle-package-review-folders');
  const reviewStatus = $('#package-review-organization-status');
  if (settingsToggle) settingsToggle.checked = organized;
  if (reviewToggle) reviewToggle.checked = organized;
  if (reviewStatus) reviewStatus.textContent = organized ? 'Folders by file type' : 'Keep files together';
}

async function updatePackageOutputLayoutMode(organized, { refreshReview = false } = {}) {
  const previousMode = getPackageOutputLayoutMode();
  const nextMode = organized ? PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION : PACKAGE_OUTPUT_LAYOUT_MODES.FLAT;
  const controls = [$('#toggle-package-folders'), $('#toggle-package-review-folders')].filter(Boolean);
  const confirmButton = $('#btn-confirm-package');
  controls.forEach(control => { control.disabled = true; });
  if (refreshReview) {
    state.packageReviewToken = null;
    if (confirmButton) confirmButton.disabled = true;
  }
  try {
    const updatedSettings = await window.crate.updateSetting('packageOutputLayoutMode', nextMode);
    state.settings = updatedSettings && typeof updatedSettings === 'object'
      ? updatedSettings
      : { ...state.settings, packageOutputLayoutMode: nextMode };
    const savedMode = getPackageOutputLayoutMode();
    syncPackageOutputLayoutControls(savedMode);
    if (savedMode !== nextMode) throw new Error('Package organization preference was not saved');
    if (refreshReview) {
      await showPackageModal({
        successMessage: PACKAGE_LAYOUT_CHANGED_MESSAGE,
        runPreScan: false,
        outputPath: state.packageOutputPath || undefined,
      });
    }
  } catch (error) {
    logRendererError('Package organization update failed', error);
    state.settings.packageOutputLayoutMode = previousMode;
    syncPackageOutputLayoutControls(previousMode);
    if (refreshReview) {
      await showPackageModal({ message: PACKAGE_REVIEW_RECOVERY_MESSAGE, runPreScan: false });
    }
  } finally {
    controls.forEach(control => { control.disabled = false; });
  }
}

function renderPackageReview(project, review, message = '', suppliedLease = null) {
  if (!project?.id || review?.projectId !== project.id) return false;
  const lease = suppliedLease || claimModalLease('modal-package');
  if (!lease) return false;
  setActiveFileVisualProject(project && project.id);
  packageReviewModalProjectId = project?.id || null;
  packageReviewModalSelectionEpoch = projectSelectionEpoch;
  packageReviewModalRequestId = packageReviewRequestId;
  packageReviewModalSessionId = lease.sessionId;
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
    const retryAt = getProjectFigmaRateLimitRetryAt(project);
    const failureCategory = getProjectFigmaFailureCategory(project);
    const displayWarning = getFigmaWarningDisplayText(warning, retryAt, failureCategory);
    const recoveryAction = warning ? getFigmaFailureAction(failureCategory || 'unknown', retryAt) : '';
    modalWarning.textContent = [displayWarning, recoveryAction]
      .filter(Boolean)
      .join(' ');
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
    reviewMessage.classList.remove('hidden');
    reviewMessage.classList.toggle('is-empty', !visibleMessage);
  }
  const confirmButton = $('#btn-confirm-package');
  if (confirmButton) confirmButton.disabled = !canPackage;
  const ready = $('#package-review-ready');
  if (ready) {
    ready.textContent = canPackage ? 'Ready to package' : 'Review required';
    ready.classList.toggle('is-blocked', !canPackage);
  }

  // File list
  const fileListEl = $('#modal-file-list');
  fileListEl.innerHTML = '';

  const reviewFiles = Array.isArray(review.files) ? review.files : [];
  const presentedReviewFiles = reviewFiles;
  const visibleFiles = presentedReviewFiles.slice(0, 8);
  for (const file of visibleFiles) {
    const item = document.createElement('div');
    item.className = 'modal-file-item package-review-file-card';
    item.appendChild(createFileVisual(project.id, file));
    const name = document.createElement('div');
    name.className = 'modal-file-name';
    name.textContent = file.name || 'Unavailable file';
    item.appendChild(name);
    appendAppOriginLabel(item, file, project);
    if (typeof file.packageFolder === 'string' && file.packageFolder) {
      const destination = document.createElement('div');
      destination.className = 'package-review-file-destination';
      destination.textContent = file.packageFolder === 'Package root'
        ? 'Package root'
        : `${file.packageFolder} folder`;
      item.appendChild(destination);
    }
    fileListEl.appendChild(item);
  }

  if (reviewFiles.length > visibleFiles.length) {
    const more = document.createElement('div');
    more.className = 'modal-file-item package-review-more';
    more.textContent = `+${Math.max(0, reviewFiles.length - visibleFiles.length)} more`;
    fileListEl.appendChild(more);
  }

  const total = $('#package-review-total');
  if (total) total.textContent = `${reviewFiles.length} visual asset${reviewFiles.length === 1 ? '' : 's'}`;
  const appChips = $('#package-review-apps');
  if (appChips) {
    appChips.innerHTML = '';
    const seenApps = new Set();
    for (const file of presentedReviewFiles) {
      const app = getFileAppPresentation(file, project);
      if (app.family === 'generic' || seenApps.has(app.family)) continue;
      seenApps.add(app.family);
      const chip = document.createElement('span');
      chip.className = `package-app-chip ${app.className}`;
      chip.textContent = app.label;
      appChips.appendChild(chip);
    }
    if (hasFigmaContext && !seenApps.has('figma')) {
      const chip = document.createElement('span');
      chip.className = 'package-app-chip figma';
      chip.textContent = `Figma · ${getProjectFigmaScopeLabel(project)}`;
      appChips.appendChild(chip);
    }
  }

  const summaryList = $('#package-review-summary-list');
  if (summaryList) {
    summaryList.innerHTML = '';
    const existingCount = presentedReviewFiles.filter(file => file.assetOrigin === 'existing' && file.projectRole !== 'source').length;
    const addedCount = presentedReviewFiles.filter(file => file.assetOrigin === 'added' && file.projectRole !== 'source').length;
    const workingCount = presentedReviewFiles.filter(file => file.projectRole === 'source').length;
    const needsLinkingCount = presentedReviewFiles.filter(file => file.status && file.status !== 'ready').length;
    appendDefinitionRow(summaryList, 'Working files', workingCount);
    appendDefinitionRow(summaryList, 'Existing assets', existingCount);
    appendDefinitionRow(summaryList, 'Added while working', addedCount);
    appendDefinitionRow(summaryList, 'Needs Review', needsLinkingCount, needsLinkingCount ? 'warning' : '');
    if (!canPackage && needsLinkingCount === 0) {
      appendDefinitionRow(summaryList, 'Package status', 'Review required', 'warning');
    }
  }

  const reviewLayoutMode = review.planSummary?.outputLayoutMode === PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
    ? PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
    : review.planSummary?.outputLayoutMode === PACKAGE_OUTPUT_LAYOUT_MODES.FLAT
      ? PACKAGE_OUTPUT_LAYOUT_MODES.FLAT
      : getPackageOutputLayoutMode();
  syncPackageOutputLayoutControls(reviewLayoutMode);

  // Folder name preview
  const folderName = resolveNamingTemplate(state.settings.namingTemplate, project.name);
  $('#modal-folder-name').textContent = review.folderName || folderName;

  // Destination
  $('#modal-dest-path').textContent = getPackageDestinationLabel(state.packageOutputPath);

  openPackageReviewDialog(lease);
  return true;
}

async function getUnavailableRendererReviewFiles(project) {
  const workspace = await ensureProjectAssetWorkspace(project);
  if (Array.isArray(workspace?.files)) return workspace.files;
  // A raw project record cannot reliably reproduce stable exclusion identities.
  // Show no guessed inventory when the authoritative workspace is unavailable.
  return [];
}

async function createUnavailableRendererReview(project, message) {
  const excludedKeys = new Set(project?.excludedAssetKeys || []);
  const reviewFiles = await getUnavailableRendererReviewFiles(project);
  const includedFiles = reviewFiles.filter(file => {
    if (file?.excluded === true) return false;
    const exclusionKey = getAssetReviewExclusionKey(file);
    return !(exclusionKey && excludedKeys.has(exclusionKey));
  });
  return {
    projectId: project?.id || state.selectedProjectId,
    files: includedFiles.map(file => {
      const evidence = file?.captureEvidence && typeof file.captureEvidence === 'object'
        ? file.captureEvidence
        : {};
      const dependency = typeof evidence.relationshipSourcePath === 'string' ||
        typeof evidence.sourceDocumentPath === 'string';
      const projectRole = ['source', 'asset'].includes(file?.projectRole)
        ? file.projectRole
        : (dependency || !PRIMARY_WORKING_FILE_EXTS.has(getFileExtension(file)) ? 'asset' : 'source');
      const sourceName = [file?.sourceName, evidence.sourceName, projectRole === 'source' ? file?.name : null]
        .map(sanitizeRendererSourceName)
        .find(Boolean) || null;
      return {
        name: typeof file?.name === 'string' && file.name ? file.name : 'Unavailable file',
        ext: getFileExtension(file),
        embedded: file?.embedded === true,
        linked: dependency,
        appFamily: evidence.appFamily || file?.appFamily || getAppFamilyFromExtension(file),
        sourceName,
        assetOrigin: ['existing', 'added'].includes(file?.assetOrigin)
          ? file.assetOrigin
          : (projectRole === 'source' ? 'added' : 'existing'),
        projectRole,
        protectedSource: file?.protectedSource === true || projectRole === 'source',
        sourceRecoveryAllowed: file?.sourceRecoveryAllowed === true,
        excluded: false,
        visualIdentity: null,
        visualRevision: null,
        status: 'unavailable',
      };
    }),
    totalFiles: includedFiles.length,
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

function getFigmaPackageRecoveryMessage(project) {
  switch (getProjectFigmaFailureCategory(project)) {
    case 'connection':
      return 'Reconnect Figma in Settings, then try packaging again.';
    case 'rate-limited':
      return 'Wait for the Figma cooldown, then try packaging again.';
    case 'file-access':
      return 'Check access or replace the Figma link, then try packaging again.';
    case 'scope':
      return 'Use the exact Figma page or layer link, or replace the Figma link, then try packaging again.';
    case 'unknown':
      return 'Check your Figma connection and try again.';
    default:
      return PACKAGE_REVIEW_RECOVERY_MESSAGE;
  }
}

function getPackageReviewRecoveryMessage(error, diagnostics = null, project = null) {
  let message = PACKAGE_REVIEW_RECOVERY_MESSAGE;
  if (error === 'package_review_changed') message = PACKAGE_REVIEW_CHANGED_MESSAGE;
  else if (error === 'package_review_unavailable') message = PACKAGE_REVIEW_UNAVAILABLE_MESSAGE;
  else if (error === 'package_scan_incomplete') message = PACKAGE_SCAN_INCOMPLETE_MESSAGE;
  else if (error === FIGMA_PACKAGE_TRANSFER_ERROR_MESSAGE) message = getFigmaPackageRecoveryMessage(project);
  const diagnosticSummary = formatPackageReviewDiagnosticSummary(error, diagnostics);
  return diagnosticSummary ? `${message} ${diagnosticSummary}` : message;
}

async function showPackageModal({
  message = '',
  successMessage = '',
  runPreScan = true,
  review: suppliedReview = null,
  outputPath: reviewedOutputPath,
} = {}) {
  const projectId = state.selectedProjectId;
  if (!projectId) return false;
  // A refresh requested by the current package flow is a serialized
  // transition from progress back to review, not a competing modal.
  if (activeModalLease?.id === 'modal-progress' && packageReviewConfirmationInFlight) {
    hidePackageProgressModal();
  }
  const lease = claimModalLease('modal-package', {
    replaceVisible: packageReviewConfirmationInFlight || !state.packageReviewToken,
  });
  if (!lease) return false;
  const modalSessionId = lease.sessionId;
  const requestId = ++packageReviewRequestId;
  const projectRequestGeneration = assetWorkspaceRequestGeneration;
  const selectionEpoch = projectSelectionEpoch;
  const isCurrentRequest = () => (
    packageReviewRequestId === requestId &&
    state.selectedProjectId === projectId &&
    projectSelectionEpoch === selectionEpoch &&
    assetWorkspaceRequestGeneration === projectRequestGeneration &&
    isCurrentModalLease('modal-package', modalSessionId)
  );
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
      if (!isCurrentRequest()) return false;
    }

  const review = suppliedReview || await (
      reviewedOutputPath === undefined
        ? window.crate.preparePackageReview(projectId)
        : window.crate.preparePackageReview(projectId, reviewedOutputPath)
  );
  if (!isCurrentRequest()) return false;
  if (!review || review.error) {
      if (review?.error === 'asset_baseline_decision_required') {
        state.projects = await window.crate.getProjects();
        if (!isCurrentRequest()) return false;
        project = state.projects.find(item => item.id === projectId) || project;
        hidePackageReviewDialog({ restoreFocus: false, preserveOpener: true });
        if (project?.assetBaseline?.status === 'decision-required') {
          await showExistingAssetsDecisionModal(project, requestId);
          return false;
        }
      }
      try {
        state.projects = await window.crate.getProjects();
        if (!isCurrentRequest()) return false;
        project = state.projects.find(item => item.id === projectId) || project;
      } catch (_) {
        // Keep the last safe project snapshot when refresh is unavailable.
      }
      const failureMessage = message || getPackageReviewRecoveryMessage(
        review?.error || 'package_review_unavailable',
        review?.diagnostics,
        project
      );
      const unavailableReview = await createUnavailableRendererReview(project, failureMessage);
      if (!isCurrentRequest()) return false;
      renderPackageReview(project, unavailableReview, failureMessage, lease);
      return false;
    }

    if (review.projectId !== projectId) return false;

    state.projects = await window.crate.getProjects();
    if (!isCurrentRequest()) return false;
    project = state.projects.find(item => item.id === projectId) || project;
    if (!project) return false;
    renderPackageReview(project, review, successMessage || message, lease);
    return true;
  } catch (error) {
    logRendererError('Package Review recovery failed', error);
    const failureMessage = message || PACKAGE_REVIEW_RECOVERY_MESSAGE;
    if (project && isCurrentRequest()) {
      const unavailableReview = await createUnavailableRendererReview(project, failureMessage);
      if (isCurrentRequest()) renderPackageReview(project, unavailableReview, failureMessage, lease);
    }
    return false;
  } finally {
    const modal = $('#modal-package');
    if (
      packageReviewRequestId === requestId &&
      isCurrentModalLease('modal-package', modalSessionId) &&
      modal?.classList.contains('hidden')
    ) {
      releaseModalLease('modal-package', modalSessionId);
    }
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
  let project = state.projects.find(p => p.id === state.selectedProjectId);
  const confirmButton = $('#btn-confirm-package');
  if (
    !project ||
    !state.packageReviewToken ||
    confirmButton?.disabled ||
    packageReviewModalProjectId !== project.id ||
    packageReviewModalSelectionEpoch !== projectSelectionEpoch ||
    packageReviewModalRequestId !== packageReviewRequestId ||
    packageReviewModalSessionId === null
  ) return;

  const reviewToken = state.packageReviewToken;
  const reviewProjectId = project.id;
  const reviewSelectionEpoch = projectSelectionEpoch;
  const reviewRequestId = packageReviewModalRequestId;
  const reviewModalSessionId = packageReviewModalSessionId;
  const confirmationId = ++packageReviewConfirmationId;
  const isCurrentConfirmation = () => (
    packageReviewConfirmationId === confirmationId &&
    state.selectedProjectId === reviewProjectId &&
    projectSelectionEpoch === reviewSelectionEpoch &&
    packageReviewRequestId === reviewRequestId &&
    packageReviewModalRequestId === reviewRequestId &&
    packageReviewModalSessionId === reviewModalSessionId
  );
  if (confirmButton) confirmButton.disabled = true;
  packageReviewConfirmationInFlight = true;
  try {
    hidePackageReviewDialog({ preserveOpener: true });
    packageReviewModalProjectId = reviewProjectId;
    packageReviewModalSelectionEpoch = reviewSelectionEpoch;
    packageReviewModalRequestId = reviewRequestId;
    packageReviewModalSessionId = reviewModalSessionId;

    // M5: Show folder picker FIRST (before progress modal) to avoid flicker on cancel
    let outputPath = state.packageOutputPath;
    if (!outputPath) {
      outputPath = await window.crate.selectOutputFolder();
      if (!outputPath) {
        if (isCurrentConfirmation()) openPackageReviewDialog();
        return;
      }
      state.packageOutputPath = outputPath;
    }

    if (!isCurrentConfirmation()) return;

    if (!showPackageProgressModal()) return;
    const scanResult = await Promise.race([
      window.crate.preScanSession(project.id),
      new Promise(resolve => setTimeout(() => resolve(null), 12000))
    ]);
    if (!isCurrentConfirmation()) return;
    if (scanResult) {
      state.projects = await window.crate.getProjects();
      if (!isCurrentConfirmation()) return;
      project = state.projects.find(p => p.id === project.id) || project;
    }

    state.packageReviewToken = null;
    const result = await window.crate.packageProject(project.id, outputPath, reviewToken);
    if (!isCurrentConfirmation()) return;
    if (!result || result.error) {
      const typedError = result?.error || 'package_failed';
      if (typedError === 'limit_reached') {
        state.packageReviewToken = null;
        const opener = hidePackageReviewDialog();
        hidePackageProgressModal();
        showPackageLimitModal(result, opener);
        return;
      }
      const suppliedReview = typedError === 'package_review_changed' ? result?.review || null : null;
      const destinationReviewRequired = !suppliedReview && (
        typedError === 'package_output_changed' || result?.reason === 'package_destination_changed'
      );
      const recoveryMessage = suppliedReview?.materializable === false
        ? suppliedReview.message || PACKAGE_REVIEW_UNAVAILABLE_MESSAGE
        : getPackageReviewRecoveryMessage(typedError, result?.diagnostics, project);
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
    if (!isCurrentConfirmation()) return;
    state.packageReviewToken = null;
    hidePackageProgressModal();
    await showPackageModal({ message: PACKAGE_REVIEW_RECOVERY_MESSAGE, runPreScan: false });
  } finally {
    if (packageReviewConfirmationId !== confirmationId) return;
    packageReviewConfirmationInFlight = false;
    hidePackageProgressModal();
    if (confirmButton) confirmButton.disabled = !state.packageReviewToken;
  }
}

// ===== Delete Project =====
function showDeleteConfirmation(projectId, projectName) {
  const lease = claimModalLease('modal-delete-confirm');
  if (!lease) return false;
  state.pendingDeleteId = projectId;
  $('#delete-confirm-title').textContent = `Remove ${projectName} from Crate?`;
  $('#delete-confirm-desc').textContent = 'The files on your computer are not affected.';
  $('#modal-delete-confirm').classList.remove('hidden');
  setModalBackgroundState(true);
  return true;
}

async function confirmDeleteProject() {
  if (!state.pendingDeleteId) return;

  await window.crate.deleteProject(state.pendingDeleteId);

  // If we deleted the selected project, clear selection
  if (state.selectedProjectId === state.pendingDeleteId) {
    setSelectedProject(null);
  }

  state.pendingDeleteId = null;
  state.projects = await window.crate.getProjects();
  $('#modal-delete-confirm').classList.add('hidden');
  releaseModalLease('modal-delete-confirm');
  setModalBackgroundState(false);
  renderProjects();
  renderFooter();
}

// ===== Clear All Projects =====
async function confirmClearAll() {
  await window.crate.deleteAllProjects();
  setSelectedProject(null);
  state.projects = await window.crate.getProjects();
  $('#modal-clear-all').classList.add('hidden');
  releaseModalLease('modal-clear-all');
  setModalBackgroundState(false);
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

  // Project name input -> update preview
  $('#input-project-name').addEventListener('input', updateNamingPreview);

  // Enter key in project name
  $('#input-project-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!isProjectCreationLocked()) createProject();
    }
    if (e.key === 'Escape' && !isProjectCreationLocked()) hideNewProjectForm();
  });

  // Project Workspace tab
  $('#btn-add-files').addEventListener('click', async (event) => {
    if (!state.selectedProjectId) {
      showToast('Select a project first');
      return;
    }
    const button = event.currentTarget || $('#btn-add-files');
    const projectId = state.selectedProjectId;
    const selectionEpoch = projectSelectionEpoch;
    try {
      await runRendererAction(`add-files:${projectId}`, button, 'Adding…', async () => {
        const attempt = createRendererDeadlineAttempt(rendererAddFilesOperationTimeoutMs);
        const isCurrent = () => (
          attempt.isCurrent() &&
          state.selectedProjectId === projectId &&
          projectSelectionEpoch === selectionEpoch
        );
        const isSelectionCurrent = () => (
          state.selectedProjectId === projectId &&
          projectSelectionEpoch === selectionEpoch
        );
        try {
          const addOutcome = await runRendererDeadlineAttempt(
            () => window.crate.addFiles(projectId),
            attempt
          );
          if (addOutcome.timedOut) {
            if (isSelectionCurrent()) {
              showToast(`Crate could not finish adding files within ${Math.ceil(attempt.timeoutMs / 1000)} seconds. Selected files were kept; try again.`);
            }
            return;
          }
          if (!isCurrent()) return;
          const result = addOutcome.value;
        if (result?.success === false) {
          const refreshOutcome = await runRendererDeadlineAttempt(
            () => window.crate.getProjects(),
            attempt
          );
          if (refreshOutcome.timedOut || !isCurrent()) {
            if (refreshOutcome.timedOut && isSelectionCurrent()) {
              showToast(`Crate could not refresh the added files within ${Math.ceil(attempt.timeoutMs / 1000)} seconds. Selected files were kept; try again.`);
            }
            return;
          }
          state.projects = refreshOutcome.value;
          const renderOutcome = await runRendererDeadlineAttempt(
            () => renderFiles({ isCurrent }),
            attempt
          );
          if (renderOutcome.timedOut) {
            if (isSelectionCurrent()) {
              showToast(`Crate could not refresh the added files within ${Math.ceil(attempt.timeoutMs / 1000)} seconds. Selected files were kept; try again.`);
            }
            return;
          }
          if (!isCurrent()) return;
          if (result.error === 'add_files_partial_scan_failure') {
            const count = Number.isSafeInteger(result.failedCount) ? result.failedCount : 1;
            showToast(`${count} file${count === 1 ? '' : 's'} could not be scanned. Successful files were kept.`);
          } else if (result.error === 'add_files_timeout') {
            showToast(`Crate could not finish scanning within ${Math.ceil((result.timeoutMs || attempt.timeoutMs) / 1000)} seconds. Selected files were kept; try again.`);
          } else {
            showToast('Crate could not add the selected files. Try again.');
          }
          return;
        }
        if (Array.isArray(result)) {
          const refreshOutcome = await runRendererDeadlineAttempt(
            () => window.crate.getProjects(),
            attempt
          );
          if (refreshOutcome.timedOut || !isCurrent()) {
            if (refreshOutcome.timedOut && isSelectionCurrent()) {
              showToast(`Crate could not refresh the added files within ${Math.ceil(attempt.timeoutMs / 1000)} seconds. Selected files were kept; try again.`);
            }
            return;
          }
          state.projects = refreshOutcome.value;
          const renderOutcome = await runRendererDeadlineAttempt(
            () => renderFiles({ isCurrent }),
            attempt
          );
          if (renderOutcome.timedOut) {
            if (isSelectionCurrent()) {
              showToast(`Crate could not refresh the added files within ${Math.ceil(attempt.timeoutMs / 1000)} seconds. Selected files were kept; try again.`);
            }
            return;
          }
        }
        } finally {
          attempt.dispose();
        }
      }, '+ Add Files');
    } catch (error) {
      logRendererError('Add Files failed', error);
      showToast('Crate could not add files. Try again.');
    }
  });

  $('#btn-package').addEventListener('click', async (event) => {
    const button = event.currentTarget || $('#btn-package');
    const projectId = state.selectedProjectId;
    if (!projectId) return;

    const project = state.projects.find(p => p.id === projectId);
    if (project && project.assetBaseline && project.assetBaseline.status === 'decision-required') {
      await showExistingAssetsDecisionModal(project);
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
    try {
      await runRendererAction(`package-review:${projectId}`, button, 'Preparing…', () => showPackageModal(), 'Package Project');
    } catch (error) {
      logRendererError('Package Review preparation failed', error);
      showToast('Package Review could not open. Try again.');
    }
  });

  // Package modal
  $('#btn-cancel-package').addEventListener('click', changePackageReviewSelection);
  $('#modal-package').addEventListener('keydown', handlePackageReviewKeydown);

  $('#btn-confirm-package').addEventListener('click', confirmPackage);

  $('#btn-include-existing-assets').addEventListener('click', () => submitExistingAssetsDecision('include', { openReview: true }));
  $('#btn-review-existing-assets-later').addEventListener('click', () => submitExistingAssetsDecision('include'));
  $('#btn-include-all-existing').addEventListener('click', () => submitAssetReviewBatchDecision('include'));
  $('#btn-skip-all-existing').addEventListener('click', () => submitAssetReviewBatchDecision('skip'));

  $('#btn-review-assets').addEventListener('click', openAssetReviewWorkspace);
  $('#btn-review-assets-back').addEventListener('click', closeAssetReviewWorkspace);
  $('#btn-review-assets-cancel').addEventListener('click', closeAssetReviewWorkspace);
  $('#btn-review-assets-continue').addEventListener('click', closeAssetReviewWorkspace);
  $$('.asset-filter').forEach(button => {
    button.addEventListener('click', () => {
      state.assetReviewFilter = button.dataset.assetFilter || 'all';
      applyAssetReviewFilter();
    });
  });
  $('#asset-review-search').addEventListener('input', event => {
    state.assetReviewQuery = event.target.value || '';
    applyAssetReviewFilter();
  });

  $('#btn-change-dest').addEventListener('click', async () => {
    const folder = await window.crate.selectOutputFolder();
    if (folder) {
      state.packageOutputPath = folder;
      $('#modal-dest-path').textContent = getPackageDestinationLabel(folder);
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

  $('#toggle-package-folders').addEventListener('change', event => {
    updatePackageOutputLayoutMode(event.target.checked);
  });

  $('#toggle-package-review-folders').addEventListener('change', event => {
    updatePackageOutputLayoutMode(event.target.checked, { refreshReview: true });
  });

  // Clear all projects
  $('#btn-clear-all').addEventListener('click', () => {
    if (state.projects.length === 0) return;
    if (!claimModalLease('modal-clear-all')) return;
    $('#modal-clear-all').classList.remove('hidden');
    setModalBackgroundState(true);
  });

  $('#btn-clear-all-cancel').addEventListener('click', () => {
    $('#modal-clear-all').classList.add('hidden');
    releaseModalLease('modal-clear-all');
    setModalBackgroundState(false);
  });

  $('#btn-clear-all-confirm').addEventListener('click', confirmClearAll);

  // Delete confirmation modal
  $('#btn-delete-cancel').addEventListener('click', () => {
    state.pendingDeleteId = null;
    $('#modal-delete-confirm').classList.add('hidden');
    releaseModalLease('modal-delete-confirm');
    setModalBackgroundState(false);
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
    releaseModalLease('modal-v2-results');
    setModalBackgroundState(false);
    v2LastResult = null; // L8: release reference
  });

  $('#btn-v2-open-folder').addEventListener('click', () => {
    if (v2LastResult && v2LastResult.outputDir) {
      window.crate.openFolder(v2LastResult.outputDir);
    }
    $('#modal-v2-results').classList.add('hidden');
    releaseModalLease('modal-v2-results');
    setModalBackgroundState(false);
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

    const previousLabel = connectButton.textContent;
    setRendererActionBusy(connectButton, true, 'Connecting...', previousLabel);
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
      setRendererActionBusy(connectButton, false, 'Connecting...', previousLabel);
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
          updateFigmaScanStatus({
            phase: 'manual-noop',
            message: 'Figma scan already in progress',
          });
        } else {
          updateFigmaScanStatus({
            phase: 'manual-noop',
            message: 'No active projects to scan',
          });
        }
      }
    } catch (e) {
      updateFigmaScanStatus({
        errors: ['Figma scan could not finish. Try again.'],
        timestamp: Date.now(),
      });
    } finally {
      setFigmaScanButtonLoading(false);
      state.figmaScanStartedAt = null;
    }
  });

}

// ===== Edit Figma Link Modal (per-project) =====
function openEditFigmaLinkModal(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  const modal = $('#modal-edit-figma-link');
  if (!project || !modal) return false;
  const lease = claimModalLease('modal-edit-figma-link');
  if (!lease) return false;
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

  // Capture the triggering control before focusing the URL input. The
  // source-bound dialog controller consumes this marker when it observes opening.
  modal._crateOpener = document.activeElement;
  modal.classList.remove('hidden');
  setModalBackgroundState(true);
  if (urlInput) urlInput.focus();
  return true;
}

function closeEditFigmaLinkModal() {
  state.editFigmaProjectId = null;
  $('#modal-edit-figma-link').classList.add('hidden');
  releaseModalLease('modal-edit-figma-link');
  setModalBackgroundState(false);
}

async function persistFigmaLinkEdit(payload, successMessage) {
  const projectId = state.editFigmaProjectId;
  if (!projectId) return false;
  const editModalSessionId = activeModalLease?.id === 'modal-edit-figma-link'
    ? activeModalLease.sessionId
    : null;
  const editModalSelectionEpoch = projectSelectionEpoch;
  const isCurrentEditModal = () => (
    editModalSessionId !== null &&
    state.editFigmaProjectId === projectId &&
    projectSelectionEpoch === editModalSelectionEpoch &&
    isCurrentModalLease('modal-edit-figma-link', editModalSessionId)
  );
  if (!isCurrentEditModal()) return false;

  const errorEl = $('#edit-figma-error');
  const result = await window.crate.setProjectFigmaLink(projectId, payload);

  if (!result || !result.success) {
    if (isCurrentEditModal() && errorEl) {
      errorEl.textContent = getFigmaLinkErrorMessage(result && result.error) || 'Failed to save Figma link.';
      errorEl.style.display = 'block';
    }
    return false;
  }

  if (!isCurrentEditModal()) return false;
  const projects = await window.crate.getProjects();
  if (!isCurrentEditModal()) return false;
  state.projects = projects;
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
  return persistFigmaLinkEdit(payload, rawUrl ? 'Figma link updated' : 'Figma settings updated');
}

async function removeEditFigmaLinkModal() {
  const scopeInput = $('#edit-figma-scope');
  const scopeMode = scopeInput ? scopeInput.value : 'current-page';
  return persistFigmaLinkEdit({ action: 'remove', scopeMode }, 'Figma link removed');
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
  button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  button.textContent = isLoading ? 'Scanning...' : 'Scan Now';
}

function applyProjectRefresh(projects, refreshGeneration, projectIds, projectListRead) {
  if (
    refreshGeneration !== projectRefreshGeneration ||
    !projectListReadIsCurrent(projectListRead)
  ) return false;
  state.projects = Array.isArray(projects) ? projects : [];
  if (isTabActive('projects')) renderProjects();
  if (state.selectedProjectId && projectIds.has(state.selectedProjectId) && isTabActive('current-project')) {
    renderFiles();
  }
  return true;
}

function refreshProjectState(projectId) {
  if (projectRefreshInFlight) {
    if (projectId) projectRefreshInFlight.projectIds.add(projectId);
    return projectRefreshInFlight;
  }

  const refreshGeneration = ++projectRefreshGeneration;
  const projectListRead = projectListReadEpoch;
  const projectIds = new Set(pendingProjectRefreshIds);
  pendingProjectRefreshIds = new Set();
  if (projectId) projectIds.add(projectId);
  let readResult;
  try {
    readResult = window.crate.getProjects();
  } catch (error) {
    readResult = Promise.reject(error);
  }
  projectRefreshInFlight = Promise.resolve(readResult)
    .then(projects => applyProjectRefresh(projects, refreshGeneration, projectIds, projectListRead))
    .catch(error => logRendererError('project state refresh failed', error))
    .finally(() => {
      projectRefreshInFlight = null;
      if (pendingProjectRefreshIds.size > 0) refreshProjectState();
    });
  projectRefreshInFlight.projectIds = projectIds;
  return projectRefreshInFlight;
}

// ===== Main Process Listeners =====
function setupMainProcessListeners() {
  if (mainProcessListenersBound) return;
  if (!window.crate) {
    logRendererError('preload bridge unavailable for main-process listeners', 'window.crate missing');
    return;
  }
  mainProcessListenersBound = true;

  const captureProjectListRead = () => projectListReadEpoch;

  // File updates from watcher
  window.crate.onFilesUpdated((data) => {
    refreshProjectState(data.projectId);
  });

  // Project updated (e.g. from notification action)
  window.crate.onProjectUpdated((data) => {
    refreshProjectState(data.projectId);
  });

  // Tier 2 pending files updated from main process
  window.crate.onPendingFilesUpdated((data) => {
    refreshProjectState(data.projectId);
  });

  // Notification-triggered packaging still requires the same authoritative review.
  window.crate.onPackageTrigger(async (data) => {
    if (hasModalInteraction() || notificationPackageTriggerInFlight) return;
    const triggerId = ++notificationPackageTriggerId;
    notificationPackageTriggerInFlight = true;
    const projectListRead = captureProjectListRead();
    const notificationInitialProjectId = state.selectedProjectId;
    const notificationInitialSelectionEpoch = projectSelectionEpoch;
    const notificationInitialSelectionIntentEpoch = projectSelectionIntentEpoch;
    try {
      const projectRefreshApplied = await refreshProjectState(data.projectId);
      // refreshProjectState intentionally resolves even when its read was
      // fenced.  Do not inspect the cached project snapshot until the read
      // epoch is still current, or a stale notification can select an old
      // project before the later guard runs.
      // A notification can also join a refresh that began under an older
      // epoch, so the promise result must confirm that this read applied.
      if (projectRefreshApplied !== true || !projectListReadIsCurrent(projectListRead)) return;
      const projects = state.projects;
      const project = projects.find(candidate => candidate && candidate.id === data.projectId);
      // Validate the notification target before changing selection.  A late
      // notification for a deleted project must not clear a valid workspace.
      if (!project) return;
      if (
        state.selectedProjectId !== notificationInitialProjectId ||
        projectSelectionEpoch !== notificationInitialSelectionEpoch ||
        projectSelectionIntentEpoch !== notificationInitialSelectionIntentEpoch
      ) return;
      setSelectedProject(data.projectId);
      const notificationSelectionEpoch = projectSelectionEpoch;
      if (
        triggerId !== notificationPackageTriggerId ||
        !projectListReadIsCurrent(projectListRead) ||
        state.selectedProjectId !== data.projectId ||
        projectSelectionEpoch !== notificationSelectionEpoch ||
        hasModalInteraction()
      ) return;
      if (project.assetBaseline && project.assetBaseline.status === 'decision-required') {
        await showExistingAssetsDecisionModal(project);
        return;
      }
      await showPackageModal();
    } finally {
      if (triggerId === notificationPackageTriggerId) notificationPackageTriggerInFlight = false;
    }
  });

  // Figma auth error notification
  window.crate.onFigmaAuthError((data) => {
    showToast(data.error || 'Figma token expired — reconnect in Settings');
    renderFigmaSettings();
  });

  window.crate.onFigmaScanStarted((data) => {
    // Manual scans announce immediately; the matching bridge event should not
    // cause a second polite announcement for the same start.
    if (state.figmaScanInFlight && state.figmaScanStartedAt) return;
    updateFigmaScanStatus({ ...data, phase: 'started' });
  });

  // Figma scan complete notification
  window.crate.onFigmaScanComplete((data) => {
    state.figmaScanStartedAt = null;
    const displayWarning = getFigmaWarningDisplayText(data.warning, data.retryAt);
    if (displayWarning) {
      state.lastFigmaWarning = displayWarning;
    } else {
      state.lastFigmaWarning = null;
    }
    // Update scan status line
    updateFigmaScanStatus(data);
  });

  // Figma scan error notification
  window.crate.onFigmaScanError((data) => {
    state.figmaScanStartedAt = null;
    updateFigmaScanStatus({
      errors: [data.error || 'Unknown error'],
      timestamp: Date.now(),
    });
  });
}

// ===== Figma Scan Status =====
function updateFigmaScanStatus(data) {
  const el = $('#figma-scan-status');
  if (!el) return;

  const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : 'just now';
  if (data.phase === 'manual-noop') {
    el.style.color = '#9ca3af';
    el.textContent = data.message || '';
    return;
  }
  if (data.phase === 'started') {
    state.figmaScanStartedAt = data.timestamp || Date.now();
    el.style.color = '#60a5fa';
    el.textContent = `Scan started (${time})...`;
    return;
  }

  const warning = getFigmaWarningDisplayText(data.warning, data.retryAt);
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
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.setAttribute('aria-atomic', 'true');
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// ===== V2 Results Modal =====
let v2LastResult = null;

function showV2Results(result) {
  if (!claimModalLease('modal-v2-results')) return false;
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
  setModalBackgroundState(true);
  return true;
}

let v2PackageInFlight = false;
async function handleV2FileDrop(filePath, droppedFile = null) {
  if ((!filePath && !droppedFile) || v2PackageInFlight) return;
  v2PackageInFlight = true;

  try {
    if (!showPackageProgressModal()) return;

    let result;
    try {
      result = droppedFile
        ? await window.crate.v2PackageDroppedFile(droppedFile)
        : await window.crate.v2PackageFile(filePath);
    } catch (_) {
      showToast('Crate could not package that file. Try again.');
      return;
    } finally {
      hidePackageProgressModal();
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

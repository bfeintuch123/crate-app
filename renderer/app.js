// ===== Constants =====
const MAX_PROJECTS = 7;
const MAX_VISIBLE_FILES = 4;

// ===== State =====
let state = {
  projects: [],
  selectedProjectId: null,
  settings: {},
  usage: {},
  packageOutputPath: null,
  lastPackagedPath: null,
  pendingDeleteId: null,
  projectType: 'branding'
};

// ===== DOM Helpers =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ===== Init =====
async function init() {
  state.projects = await window.crate.getProjects();
  state.settings = await window.crate.getSettings();
  state.usage = await window.crate.getUsage();

  renderProjects();
  renderSettings();
  renderFooter();
  setupEventListeners();
  setupMainProcessListeners();
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
    return `Watching \u00B7 ${filesText}`;
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
  $$('.type-pill').forEach(p => p.classList.remove('active'));
  const defaultPill = document.querySelector('.type-pill[data-type="branding"]');
  if (defaultPill) defaultPill.classList.add('active');

  // Update template display from current settings
  const templateDisplay = $('#naming-template-display');
  if (templateDisplay) {
    templateDisplay.textContent = state.settings.namingTemplate || '{Project}_{Date}';
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

  const result = await window.crate.createProject(name, state.projectType);
  if (result && result.error === 'max_projects_reached') {
    return;
  }

  state.projects = await window.crate.getProjects();
  state.selectedProjectId = result.id;
  hideNewProjectForm();
  renderProjects();
  switchTab('files');
}

// ===== Naming Preview =====
function cleanName(s) {
  const cleaned = s.replace(/[^a-zA-Z0-9 ._\-()]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || 'Untitled';
}

function resolveNamingTemplate(template, name) {
  const dateStr = new Date().toISOString().split('T')[0];
  // Use the full project name — no client/project splitting.
  return template
    .replace('{Project}', cleanName(name || 'Project'))
    .replace('{Date}', dateStr);
}

function updateNamingPreview() {
  const template = state.settings.namingTemplate || '{Project}_{Date}';
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

  if (!state.selectedProjectId) {
    noProject.classList.remove('hidden');
    filesView.classList.add('hidden');
    return;
  }

  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) {
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
  const fileCount = project.files.length;

  statusBar.className = `app-status ${project.status !== 'watching' ? project.status : ''}`;
  statusDot.className = `app-dot ${project.status !== 'watching' ? project.status : ''}`;

  if (project.status === 'watching') {
    statusText.textContent = `Watching \u00B7 ${fileCount} file${fileCount !== 1 ? 's' : ''} tracked`;
  } else if (project.status === 'paused') {
    statusText.textContent = `Paused \u00B7 ${fileCount} file${fileCount !== 1 ? 's' : ''}`;
  } else {
    statusText.textContent = `Packaged \u2713 \u00B7 ${fileCount} file${fileCount !== 1 ? 's' : ''}`;
  }

  // Pending files (Tier 2)
  renderPendingFiles(project);

  // File list
  renderFileList(project.files);

  // Package button — always enabled; click handler shows toast if no files
  const packageBtn = $('#btn-package');
  packageBtn.disabled = false;
}

function renderFileList(files) {
  const container = $('#file-list');
  container.innerHTML = '';

  if (files.length === 0) {
    container.innerHTML = '<div class="files-empty">No files tracked yet. Files will appear as you work.</div>';
    return;
  }

  const visibleFiles = files.slice(0, MAX_VISIBLE_FILES);
  const remainingCount = files.length - MAX_VISIBLE_FILES;

  for (const file of visibleFiles) {
    const row = document.createElement('div');
    row.className = 'app-file';
    const emoji = getFileEmoji(file.ext);

    row.innerHTML = `
      <span class="app-file-icon">${emoji}</span>
      <span class="app-file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span>
      <button class="app-file-remove" data-path="${escapeHtml(file.path)}" title="Remove">&times;</button>
    `;

    const removeBtn = row.querySelector('.app-file-remove');
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.crate.removeFile(state.selectedProjectId, file.path);
      state.projects = await window.crate.getProjects();
      renderFiles();
    });

    container.appendChild(row);
  }

  if (remainingCount > 0) {
    const divider = document.createElement('hr');
    divider.className = 'app-file-divider';
    container.appendChild(divider);

    const meta = document.createElement('div');
    meta.className = 'app-file-meta';
    meta.innerHTML = `
      <span class="app-file-count">+ ${remainingCount} more file${remainingCount !== 1 ? 's' : ''}</span>
      <span class="app-file-add" id="files-add-more">+ Add files</span>
    `;
    container.appendChild(meta);

    meta.querySelector('#files-add-more').addEventListener('click', async () => {
      if (!state.selectedProjectId) return;
      const files = await window.crate.addFiles(state.selectedProjectId);
      if (files) {
        state.projects = await window.crate.getProjects();
        renderFiles();
      }
    });
  }
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

    row.innerHTML = `
      <span class="app-file-icon">${getFileEmoji(file.ext)}</span>
      <span class="app-file-name pending-file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span>
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
async function renderSettings() {
  state.settings = await window.crate.getSettings();
  state.usage = await window.crate.getUsage();

  $('#input-naming-template').value = state.settings.namingTemplate;
  $('#toggle-notifications').checked = state.settings.notifications || false;

  const used = state.usage.packagesThisMonth;
  $('#plan-info').textContent = `Free Plan \u00B7 ${used}/10 packages`;

  updateSettingsNamingPreview();
}

function updateSettingsNamingPreview() {
  const template = $('#input-naming-template').value;
  const preview = resolveNamingTemplate(template, 'BrandRefresh');
  $('#settings-naming-preview').textContent = preview;
}

// ===== Render Footer =====
async function renderFooter() {
  state.usage = await window.crate.getUsage();
  const used = state.usage.packagesThisMonth;
  $('#footer-usage').textContent = `${used} of 10 packages used this month`;
}

// ===== Package Flow =====
function showPackageModal() {
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) return;

  $('#modal-project-name').textContent = project.name;

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

async function confirmPackage() {
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) return;

  $('#modal-package').classList.add('hidden');
  $('#modal-progress').classList.remove('hidden');

  // Run pre-scan now (user already confirmed, progress spinner is showing)
  // Hard 5s timeout so it never hangs
  const scanResult = await Promise.race([
    window.crate.preScanSession(project.id),
    new Promise(resolve => setTimeout(() => resolve(null), 5000))
  ]);
  if (scanResult) {
    state.projects = await window.crate.getProjects();
  }

  let outputPath = state.packageOutputPath;
  if (!outputPath) {
    outputPath = await window.crate.selectOutputFolder();
    if (!outputPath) {
      $('#modal-progress').classList.add('hidden');
      return;
    }
    state.packageOutputPath = outputPath;
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

  // Show success
  $('#success-message').textContent = `${result.copiedCount} file${result.copiedCount !== 1 ? 's' : ''} gathered and renamed. Your project is ready to archive or hand off.`;
  $('#success-path').textContent = result.folderPath;
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
    if (!state.selectedProjectId) return;
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

  $('#input-naming-template').addEventListener('change', () => {
    const template = $('#input-naming-template').value;
    window.crate.updateSetting('namingTemplate', template);
    state.settings.namingTemplate = template;
  });

  $('#toggle-notifications').addEventListener('change', () => {
    const checked = $('#toggle-notifications').checked;
    window.crate.updateSetting('notifications', checked);
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

}

// ===== Tab State Helper =====
const isFilesTabActive = () => {
  const tab = document.querySelector("#tab-files");
  return tab && tab.classList.contains("active");
};

// ===== Main Process Listeners =====
function setupMainProcessListeners() {
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
  window.crate.onPackageTrigger(async (data) => {
    const project = state.projects.find(p => p.id === data.projectId);
    if (project) {
      state.selectedProjectId = data.projectId;
      const outputPath = await window.crate.selectOutputFolder();
      if (outputPath) {
        await window.crate.packageProject(data.projectId, outputPath);
        state.projects = await window.crate.getProjects();
        renderProjects();
        renderFiles();
      }
    }
  });
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

// ===== Helpers =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Start =====
document.addEventListener('DOMContentLoaded', init);

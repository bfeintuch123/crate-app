'use strict';

/**
 * Phase 4B — Explicit Project Lifecycle State Machine
 *
 * Centralizes Crate's project lifecycle states, valid transitions, and the
 * single-active-watching-project invariant into a pure, auditable module so
 * state transitions are validated uniformly across IPC handlers, watchers,
 * and packaging flows.
 */

const PROJECT_LIFECYCLE_STATES = Object.freeze({
  PAUSED: 'paused',
  WATCHING: 'watching',
  PACKAGING: 'packaging',
  PACKAGED: 'packaged',
});

const PROJECT_LIFECYCLE_EVENTS = Object.freeze({
  START_WATCHING: 'START_WATCHING',
  PAUSE: 'PAUSE',
  BEGIN_PACKAGE: 'BEGIN_PACKAGE',
  FINISH_PACKAGE: 'FINISH_PACKAGE',
  FAIL_PACKAGE: 'FAIL_PACKAGE',
  RESTORE_WATCHING: 'RESTORE_WATCHING',
  DELETE: 'DELETE',
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [PROJECT_LIFECYCLE_STATES.PAUSED]: Object.freeze({
    [PROJECT_LIFECYCLE_EVENTS.START_WATCHING]: PROJECT_LIFECYCLE_STATES.WATCHING,
    [PROJECT_LIFECYCLE_EVENTS.PAUSE]: PROJECT_LIFECYCLE_STATES.PAUSED,
    [PROJECT_LIFECYCLE_EVENTS.BEGIN_PACKAGE]: PROJECT_LIFECYCLE_STATES.PACKAGING,
    [PROJECT_LIFECYCLE_EVENTS.DELETE]: null,
  }),
  [PROJECT_LIFECYCLE_STATES.WATCHING]: Object.freeze({
    [PROJECT_LIFECYCLE_EVENTS.START_WATCHING]: PROJECT_LIFECYCLE_STATES.WATCHING,
    [PROJECT_LIFECYCLE_EVENTS.PAUSE]: PROJECT_LIFECYCLE_STATES.PAUSED,
    [PROJECT_LIFECYCLE_EVENTS.BEGIN_PACKAGE]: PROJECT_LIFECYCLE_STATES.PACKAGING,
    [PROJECT_LIFECYCLE_EVENTS.DELETE]: null,
  }),
  [PROJECT_LIFECYCLE_STATES.PACKAGING]: Object.freeze({
    [PROJECT_LIFECYCLE_EVENTS.FINISH_PACKAGE]: PROJECT_LIFECYCLE_STATES.PACKAGED,
    [PROJECT_LIFECYCLE_EVENTS.FAIL_PACKAGE]: PROJECT_LIFECYCLE_STATES.PAUSED,
    [PROJECT_LIFECYCLE_EVENTS.RESTORE_WATCHING]: PROJECT_LIFECYCLE_STATES.WATCHING,
    [PROJECT_LIFECYCLE_EVENTS.PAUSE]: PROJECT_LIFECYCLE_STATES.PAUSED,
    [PROJECT_LIFECYCLE_EVENTS.DELETE]: null,
  }),
  [PROJECT_LIFECYCLE_STATES.PACKAGED]: Object.freeze({
    [PROJECT_LIFECYCLE_EVENTS.START_WATCHING]: PROJECT_LIFECYCLE_STATES.WATCHING,
    [PROJECT_LIFECYCLE_EVENTS.PAUSE]: PROJECT_LIFECYCLE_STATES.PAUSED,
    [PROJECT_LIFECYCLE_EVENTS.BEGIN_PACKAGE]: PROJECT_LIFECYCLE_STATES.PACKAGING,
    [PROJECT_LIFECYCLE_EVENTS.DELETE]: null,
  }),
});

function normalizeProjectState(status) {
  if (
    status === PROJECT_LIFECYCLE_STATES.WATCHING ||
    status === PROJECT_LIFECYCLE_STATES.PAUSED ||
    status === PROJECT_LIFECYCLE_STATES.PACKAGING ||
    status === PROJECT_LIFECYCLE_STATES.PACKAGED
  ) {
    return status;
  }
  return PROJECT_LIFECYCLE_STATES.PAUSED;
}

function canTransitionProjectState(currentStatus, event) {
  const normalized = normalizeProjectState(currentStatus);
  const table = ALLOWED_TRANSITIONS[normalized];
  if (!table || !Object.prototype.hasOwnProperty.call(table, event)) return false;
  return true;
}

function nextProjectState(currentStatus, event) {
  const normalized = normalizeProjectState(currentStatus);
  const table = ALLOWED_TRANSITIONS[normalized];
  if (!table || !Object.prototype.hasOwnProperty.call(table, event)) {
    throw new Error(`invalid_project_transition:${normalized}->${String(event)}`);
  }
  return table[event];
}

/**
 * Enforce Crate's single-watching-project invariant across a project collection.
 * Returns `{ pausedProjectIds, activeProjectId }` without mutating anything
 * other than clearing `watching` -> `paused` on displaced projects.
 */
function enforceSingleWatchingInvariant(projects, targetProjectId) {
  const pausedProjectIds = [];
  let activeProjectId = null;
  if (!Array.isArray(projects)) return { pausedProjectIds, activeProjectId };

  for (const project of projects) {
    if (!project || typeof project.id !== 'string') continue;
    if (project.id === targetProjectId) {
      activeProjectId = project.id;
      continue;
    }
    if (project.status === PROJECT_LIFECYCLE_STATES.WATCHING) {
      project.status = PROJECT_LIFECYCLE_STATES.PAUSED;
      pausedProjectIds.push(project.id);
    }
  }
  return { pausedProjectIds, activeProjectId };
}

class ProjectLifecycleController {
  constructor({ maxHistory = 64 } = {}) {
    this.maxHistory = Number.isInteger(maxHistory) && maxHistory > 0 ? maxHistory : 64;
    this.history = [];
    this.activationCounter = 0;
    this.activeTokens = new Map(); // projectId -> monotonic numeric token
  }

  transition(project, event, { now = Date.now(), reason = null } = {}) {
    if (!project || typeof project.id !== 'string') {
      throw new Error('invalid_project_record');
    }
    const from = normalizeProjectState(project.status);
    const to = nextProjectState(from, event);
    if (to !== null) {
      project.status = to;
    }

    let activationToken = this.activeTokens.get(project.id) || null;
    if (to === PROJECT_LIFECYCLE_STATES.WATCHING) {
      activationToken = ++this.activationCounter;
      this.activeTokens.set(project.id, activationToken);
    } else if (from === PROJECT_LIFECYCLE_STATES.WATCHING && to !== PROJECT_LIFECYCLE_STATES.WATCHING) {
      this.activeTokens.delete(project.id);
      activationToken = null;
    }

    const record = {
      projectId: project.id,
      from,
      to,
      event,
      reason,
      activationToken,
      at: now,
    };
    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    return record;
  }

  getActiveToken(projectId) {
    return this.activeTokens.get(projectId) || null;
  }

  isTokenCurrent(projectId, token) {
    if (token === null || token === undefined) return true;
    return this.activeTokens.get(projectId) === token;
  }

  getRecentHistory(projectId = null) {
    if (!projectId) return [...this.history];
    return this.history.filter(entry => entry.projectId === projectId);
  }
}

module.exports = {
  ALLOWED_TRANSITIONS,
  PROJECT_LIFECYCLE_EVENTS,
  PROJECT_LIFECYCLE_STATES,
  ProjectLifecycleController,
  canTransitionProjectState,
  enforceSingleWatchingInvariant,
  nextProjectState,
  normalizeProjectState,
};

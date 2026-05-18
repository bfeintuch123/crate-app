const crypto = require('crypto');

const PROVENANCE_SCHEMA_VERSION = 1;
const ID_HASH_LENGTH = 20;

const NODE_TYPES = Object.freeze({
  SESSION: 'session',
  FILE: 'file',
  CONTAINER: 'container',
  APP: 'app',
  APP_PROCESS: 'appProcess',
  CLOUD_DOCUMENT: 'cloudDocument',
  EMBEDDED_RESOURCE: 'embeddedResource',
  PACKAGE: 'package',
});

const EDGE_TYPES = Object.freeze({
  SESSION_OBSERVED_FILE: 'session_observed_file',
  APP_OPENED_FILE: 'app_opened_file',
  CONTAINER_REFERENCES_FILE: 'container_references_file',
  CONTAINER_EMBEDS_RESOURCE: 'container_embeds_resource',
  RESOURCE_MATERIALIZED_AS_FILE: 'resource_materialized_as_file',
  FILE_DERIVED_FROM_RESOURCE: 'file_derived_from_resource',
  FILE_POSSIBLE_SOURCE_FOR_RESOURCE: 'file_possible_source_for_resource',
  PACKAGE_INCLUDES_FILE: 'package_includes_file',
  PACKAGE_EXTRACTS_RESOURCE: 'package_extracts_resource',
  PACKAGE_WRITES_MANIFEST: 'package_writes_manifest',
});

const OBSERVER_KINDS = Object.freeze({
  CHOKIDAR: 'chokidar',
  LSOF: 'lsof',
  SPOTLIGHT_LAST_USED: 'spotlight_last_used',
  APP_SCRIPT: 'app_script',
  PARSER: 'parser',
  FIGMA_API: 'figma_api',
  PACKAGE_RECOVERY: 'package_recovery',
  PACKAGE_COPY: 'package_copy',
  MANUAL_USER_ACTION: 'manual_user_action',
});

const CONFIDENCE_BANDS = Object.freeze({
  CONFIRMED: 'confirmed',
  LIKELY: 'likely',
  CANDIDATE: 'candidate',
  WEAK: 'weak',
});

const CONFIDENCE_RANGES = Object.freeze({
  [CONFIDENCE_BANDS.CONFIRMED]: Object.freeze({ min: 0.9, max: 1, defaultScore: 0.95 }),
  [CONFIDENCE_BANDS.LIKELY]: Object.freeze({ min: 0.7, max: 0.89, defaultScore: 0.8 }),
  [CONFIDENCE_BANDS.CANDIDATE]: Object.freeze({ min: 0.45, max: 0.69, defaultScore: 0.6 }),
  [CONFIDENCE_BANDS.WEAK]: Object.freeze({ min: 0, max: 0.44, defaultScore: 0.25 }),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeForHash(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(item => normalizeForHash(item) ?? null);
  if (isPlainObject(value)) {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      const nextValue = normalizeForHash(value[key]);
      if (nextValue !== undefined) normalized[key] = nextValue;
    }
    return normalized;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean') return value;
  return String(value);
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeForHash(value) ?? null))
    .digest('hex')
    .slice(0, ID_HASH_LENGTH);
}

function sanitizeIdPrefix(prefix, fallback = 'id') {
  const cleaned = `${prefix || ''}`
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function createDeterministicId(prefix, identity) {
  return `${sanitizeIdPrefix(prefix)}_${stableHash(identity)}`;
}

function createNodeId(type, identity) {
  const nodeType = sanitizeIdPrefix(type, 'node');
  return createDeterministicId(nodeType, { type: nodeType, identity });
}

function createEdgeId(relationType, subjectNodeId, objectNodeId, dedupeKey = null) {
  return createDeterministicId('edge', {
    relationType,
    subjectNodeId,
    objectNodeId,
    dedupeKey,
  });
}

function createObservationId(dedupeKey) {
  return createDeterministicId('obs', { dedupeKey });
}

function createEvidenceId(kind, identity) {
  return createDeterministicId('ev', { kind, identity });
}

function normalizeDedupePart(part) {
  if (part === undefined || part === null) return '';
  if (Array.isArray(part) || isPlainObject(part)) return stableHash(part);
  return `${part}`.trim().replace(/\s+/g, ' ');
}

function createDedupeKey(...parts) {
  return parts.flat()
    .map(normalizeDedupePart)
    .filter(Boolean)
    .join(':');
}

function createObservationDedupeKey(input = {}) {
  if (typeof input.dedupeKey === 'string' && input.dedupeKey.trim()) {
    return input.dedupeKey.trim();
  }
  const observerKind = input.observer && input.observer.kind;
  return createDedupeKey(
    'observation',
    observerKind || 'unknown_observer',
    input.kind || 'unknown_kind',
    input.projectId || 'unknown_project',
    input.sessionId || 'no_session',
    input.subjectNodeId || 'no_subject',
    input.objectNodeId || 'no_object',
    input.relationType || input.kind || 'unknown_relation'
  );
}

function inferConfidenceBand(score) {
  const normalizedScore = normalizeScore(score, CONFIDENCE_RANGES[CONFIDENCE_BANDS.WEAK].defaultScore);
  if (normalizedScore >= CONFIDENCE_RANGES[CONFIDENCE_BANDS.CONFIRMED].min) return CONFIDENCE_BANDS.CONFIRMED;
  if (normalizedScore >= CONFIDENCE_RANGES[CONFIDENCE_BANDS.LIKELY].min) return CONFIDENCE_BANDS.LIKELY;
  if (normalizedScore >= CONFIDENCE_RANGES[CONFIDENCE_BANDS.CANDIDATE].min) return CONFIDENCE_BANDS.CANDIDATE;
  return CONFIDENCE_BANDS.WEAK;
}

function normalizeScore(score, fallback) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return fallback;
  return Math.max(0, Math.min(1, score));
}

function normalizeStringArray(value) {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const result = [];
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function createConfidence(input = CONFIDENCE_BANDS.WEAK, reasons = []) {
  if (typeof input === 'number') {
    const score = normalizeScore(input, CONFIDENCE_RANGES[CONFIDENCE_BANDS.WEAK].defaultScore);
    return { score, band: inferConfidenceBand(score), reasons: normalizeStringArray(reasons) };
  }

  if (typeof input === 'string') {
    const band = Object.values(CONFIDENCE_BANDS).includes(input)
      ? input
      : CONFIDENCE_BANDS.WEAK;
    return {
      score: CONFIDENCE_RANGES[band].defaultScore,
      band,
      reasons: normalizeStringArray(reasons),
    };
  }

  if (isPlainObject(input)) {
    const score = typeof input.score === 'number'
      ? normalizeScore(input.score, CONFIDENCE_RANGES[CONFIDENCE_BANDS.WEAK].defaultScore)
      : null;
    const band = score !== null
      ? inferConfidenceBand(score)
      : (Object.values(CONFIDENCE_BANDS).includes(input.band) ? input.band : CONFIDENCE_BANDS.WEAK);
    return {
      score: score !== null ? score : CONFIDENCE_RANGES[band].defaultScore,
      band,
      reasons: normalizeStringArray([...normalizeStringArray(input.reasons), ...normalizeStringArray(reasons)]),
    };
  }

  return createConfidence(CONFIDENCE_BANDS.WEAK, reasons);
}

function normalizeTimestamp(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? fallback : time;
  }
  if (typeof value === 'string' && value.trim()) {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? fallback : time;
  }
  return fallback;
}

function normalizeJsonObject(value) {
  return isPlainObject(value) ? JSON.parse(JSON.stringify(normalizeForHash(value))) : {};
}

function normalizeObserver(observer) {
  const normalized = normalizeJsonObject(observer);
  if (typeof normalized.kind !== 'string' || !normalized.kind.trim()) {
    normalized.kind = 'unknown';
  } else {
    normalized.kind = normalized.kind.trim();
  }
  return normalized;
}

function normalizeTimeWindow(timeWindow, observedAt) {
  if (!isPlainObject(timeWindow)) return null;
  const start = normalizeTimestamp(timeWindow.start, observedAt);
  const end = normalizeTimestamp(timeWindow.end, start);
  const precisionMs = normalizeTimestamp(timeWindow.precisionMs, 0);
  return { start, end, precisionMs };
}

function createObservationRecord(input = {}) {
  const observedAt = normalizeTimestamp(input.observedAt, Date.now());
  const dedupeKey = createObservationDedupeKey(input);
  const relationType = typeof input.relationType === 'string' && input.relationType.trim()
    ? input.relationType.trim()
    : (typeof input.kind === 'string' ? input.kind.trim() : 'unknown');

  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : createObservationId(dedupeKey),
    projectId: typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : null,
    sessionId: typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null,
    observedAt,
    observer: normalizeObserver(input.observer),
    kind: typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim() : relationType,
    subjectNodeId: typeof input.subjectNodeId === 'string' && input.subjectNodeId.trim() ? input.subjectNodeId.trim() : null,
    objectNodeId: typeof input.objectNodeId === 'string' && input.objectNodeId.trim() ? input.objectNodeId.trim() : null,
    relationType,
    evidenceIds: normalizeStringArray(input.evidenceIds),
    confidence: createConfidence(input.confidence === undefined ? CONFIDENCE_BANDS.WEAK : input.confidence),
    timeWindow: normalizeTimeWindow(input.timeWindow, observedAt),
    dedupeKey,
    payload: normalizeJsonObject(input.payload),
  };
}

function createEvidenceRecord(input = {}) {
  const kind = typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim() : 'unknown';
  const observer = normalizeObserver(input.observer);
  const observedAt = normalizeTimestamp(input.observedAt, Date.now());
  const identity = input.identity || {
    kind,
    observer,
    observedAt,
    summary: input.summary || '',
    payload: input.payload || {},
  };

  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : createEvidenceId(kind, identity),
    kind,
    observer,
    observedAt,
    summary: typeof input.summary === 'string' ? input.summary.trim() : '',
    payload: normalizeJsonObject(input.payload),
  };
}

function normalizeProvenanceShape(provenance = {}, options = {}) {
  const existing = isPlainObject(provenance) ? provenance : {};
  const existingVersion = Number.isInteger(existing.schemaVersion) && existing.schemaVersion > 0
    ? existing.schemaVersion
    : PROVENANCE_SCHEMA_VERSION;
  const sessionId = typeof existing.sessionId === 'string' && existing.sessionId.trim()
    ? existing.sessionId.trim()
    : (typeof options.sessionId === 'string' && options.sessionId.trim() ? options.sessionId.trim() : null);

  return {
    ...existing,
    schemaVersion: Math.max(PROVENANCE_SCHEMA_VERSION, existingVersion),
    sessionId,
    nodes: isPlainObject(existing.nodes) ? existing.nodes : {},
    edges: isPlainObject(existing.edges) ? existing.edges : {},
    observations: Array.isArray(existing.observations) ? existing.observations : [],
    evidence: isPlainObject(existing.evidence) ? existing.evidence : {},
  };
}

function createEmptyProvenance(options = {}) {
  return normalizeProvenanceShape({}, options);
}

function ensureProjectProvenance(project, options = {}) {
  if (!isPlainObject(project)) return null;
  project.provenance = normalizeProvenanceShape(project.provenance, {
    projectId: project.id,
    sessionId: options.sessionId,
  });
  return project.provenance;
}

function appendObservation(provenance, input = {}) {
  if (!isPlainObject(provenance)) return { observation: createObservationRecord(input), added: false };
  Object.assign(provenance, normalizeProvenanceShape(provenance));
  const observation = createObservationRecord(input);
  const existing = provenance.observations.find(item => item && item.dedupeKey === observation.dedupeKey);
  if (existing) return { observation: existing, added: false };
  provenance.observations.push(observation);
  return { observation, added: true };
}

function upsertEvidence(provenance, input = {}) {
  if (!isPlainObject(provenance)) return createEvidenceRecord(input);
  Object.assign(provenance, normalizeProvenanceShape(provenance));
  const evidence = createEvidenceRecord(input);
  provenance.evidence[evidence.id] = {
    ...(provenance.evidence[evidence.id] || {}),
    ...evidence,
  };
  return provenance.evidence[evidence.id];
}

module.exports = {
  PROVENANCE_SCHEMA_VERSION,
  NODE_TYPES,
  EDGE_TYPES,
  OBSERVER_KINDS,
  CONFIDENCE_BANDS,
  CONFIDENCE_RANGES,
  createConfidence,
  inferConfidenceBand,
  createDeterministicId,
  createNodeId,
  createEdgeId,
  createObservationId,
  createEvidenceId,
  createDedupeKey,
  createObservationDedupeKey,
  createObservationRecord,
  createEvidenceRecord,
  createEmptyProvenance,
  ensureProjectProvenance,
  appendObservation,
  upsertEvidence,
};

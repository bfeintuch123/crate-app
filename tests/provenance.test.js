const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVENANCE_SCHEMA_VERSION,
  NODE_TYPES,
  EDGE_TYPES,
  OBSERVER_KINDS,
  CONFIDENCE_BANDS,
  createConfidence,
  createNodeId,
  createEdgeId,
  createObservationId,
  createEvidenceId,
  createObservationRecord,
  createEvidenceRecord,
  createEmptyProvenance,
  ensureProjectProvenance,
  appendObservation,
  upsertEvidence,
} = require('../provenance');

test('ensureProjectProvenance initializes and repairs legacy sidecar shape', () => {
  const project = {
    id: 'project_1',
    provenance: {
      schemaVersion: 0,
      sessionId: ' ',
      nodes: [],
      edges: null,
      observations: {},
      evidence: [],
      extraField: 'preserved',
    },
  };

  const provenance = ensureProjectProvenance(project);

  assert.equal(provenance.schemaVersion, PROVENANCE_SCHEMA_VERSION);
  assert.equal(provenance.sessionId, null);
  assert.deepEqual(provenance.nodes, {});
  assert.deepEqual(provenance.edges, {});
  assert.deepEqual(provenance.observations, []);
  assert.deepEqual(provenance.evidence, {});
  assert.equal(provenance.extraField, 'preserved');
  assert.equal(project.provenance, provenance);
});

test('ensureProjectProvenance preserves existing valid provenance records', () => {
  const existingObservation = { id: 'obs_existing', dedupeKey: 'manual:file' };
  const project = {
    id: 'project_2',
    provenance: {
      schemaVersion: 2,
      sessionId: 'session_existing',
      nodes: { file_1: { id: 'file_1' } },
      edges: { edge_1: { id: 'edge_1' } },
      observations: [existingObservation],
      evidence: { ev_1: { id: 'ev_1' } },
    },
  };

  const provenance = ensureProjectProvenance(project, { sessionId: 'session_new' });

  assert.equal(provenance.schemaVersion, 2);
  assert.equal(provenance.sessionId, 'session_existing');
  assert.equal(provenance.nodes.file_1.id, 'file_1');
  assert.equal(provenance.edges.edge_1.id, 'edge_1');
  assert.equal(provenance.observations[0], existingObservation);
  assert.equal(provenance.evidence.ev_1.id, 'ev_1');
});

test('deterministic ID helpers are stable and type-prefixed', () => {
  const fileIdentity = { path: '/Users/example/Brand/logo.ai', size: 1024, mtimeMs: 10 };
  const reorderedIdentity = { mtimeMs: 10, size: 1024, path: '/Users/example/Brand/logo.ai' };

  const fileId = createNodeId(NODE_TYPES.FILE, fileIdentity);
  assert.match(fileId, /^file_[a-f0-9]{20}$/);
  assert.equal(fileId, createNodeId(NODE_TYPES.FILE, reorderedIdentity));
  assert.notEqual(fileId, createNodeId(NODE_TYPES.FILE, { ...fileIdentity, size: 2048 }));

  const edgeId = createEdgeId(EDGE_TYPES.SESSION_OBSERVED_FILE, 'session_1', fileId, 'watch:file');
  assert.match(edgeId, /^edge_[a-f0-9]{20}$/);
  assert.equal(edgeId, createEdgeId(EDGE_TYPES.SESSION_OBSERVED_FILE, 'session_1', fileId, 'watch:file'));
  assert.notEqual(edgeId, createEdgeId(EDGE_TYPES.APP_OPENED_FILE, 'session_1', fileId, 'watch:file'));

  assert.match(createObservationId('manual:file'), /^obs_[a-f0-9]{20}$/);
  assert.match(createEvidenceId(OBSERVER_KINDS.PARSER, { parser: 'idml' }), /^ev_[a-f0-9]{20}$/);
});

test('confidence helpers map scores and bands deterministically', () => {
  assert.deepEqual(createConfidence(CONFIDENCE_BANDS.LIKELY, 'parser evidence'), {
    score: 0.8,
    band: CONFIDENCE_BANDS.LIKELY,
    reasons: ['parser evidence'],
  });

  const candidate = createConfidence(0.68, ['lsof observed app process']);
  assert.equal(candidate.band, CONFIDENCE_BANDS.CANDIDATE);
  assert.equal(candidate.score, 0.68);
  assert.deepEqual(candidate.reasons, ['lsof observed app process']);

  const scoreWins = createConfidence({ score: 0.95, band: CONFIDENCE_BANDS.WEAK, reasons: ['package copy'] });
  assert.equal(scoreWins.band, CONFIDENCE_BANDS.CONFIRMED);
  assert.equal(scoreWins.score, 0.95);
});

test('createObservationRecord produces normalized observation schema', () => {
  const observation = createObservationRecord({
    projectId: 'project_1',
    sessionId: 'session_1',
    observedAt: 1760000000000,
    observer: {
      kind: OBSERVER_KINDS.LSOF,
      version: 1,
      method: 'poll',
    },
    kind: EDGE_TYPES.APP_OPENED_FILE,
    subjectNodeId: 'process_1',
    objectNodeId: 'file_1',
    evidenceIds: ['ev_1', 'ev_1', ''],
    confidence: {
      score: 0.68,
      reasons: ['lsof observed app process with regular file'],
    },
    timeWindow: {
      start: 1760000000000,
      end: 1760000003000,
      precisionMs: 3000,
    },
    payload: {
      source: 'unit-test',
    },
  });

  assert.equal(observation.id, createObservationId(observation.dedupeKey));
  assert.equal(observation.projectId, 'project_1');
  assert.equal(observation.sessionId, 'session_1');
  assert.equal(observation.kind, EDGE_TYPES.APP_OPENED_FILE);
  assert.equal(observation.relationType, EDGE_TYPES.APP_OPENED_FILE);
  assert.deepEqual(observation.evidenceIds, ['ev_1']);
  assert.equal(observation.confidence.band, CONFIDENCE_BANDS.CANDIDATE);
  assert.deepEqual(observation.payload, { source: 'unit-test' });
  assert.deepEqual(observation.timeWindow, {
    start: 1760000000000,
    end: 1760000003000,
    precisionMs: 3000,
  });
});

test('appendObservation dedupes by deterministic dedupeKey', () => {
  const provenance = createEmptyProvenance({ sessionId: 'session_1' });
  const input = {
    projectId: 'project_1',
    sessionId: 'session_1',
    observedAt: 1760000000000,
    observer: { kind: OBSERVER_KINDS.MANUAL_USER_ACTION },
    kind: EDGE_TYPES.SESSION_OBSERVED_FILE,
    objectNodeId: 'file_1',
    dedupeKey: 'manual_user_action:project_1:file_1',
    confidence: CONFIDENCE_BANDS.CONFIRMED,
  };

  const first = appendObservation(provenance, input);
  const second = appendObservation(provenance, { ...input, observedAt: 1760000003000 });

  assert.equal(first.added, true);
  assert.equal(second.added, false);
  assert.equal(provenance.observations.length, 1);
  assert.equal(second.observation, first.observation);
});

test('evidence helpers create compact stable records and upsert by id', () => {
  const provenance = createEmptyProvenance();
  const input = {
    kind: OBSERVER_KINDS.PARSER,
    observer: { kind: OBSERVER_KINDS.PARSER, parser: 'idml' },
    observedAt: 1760000000000,
    identity: { parser: 'idml', field: 'LinkResourceURI', path: '/tmp/logo.ai' },
    summary: 'IDML parser found linked asset path',
    payload: { field: 'LinkResourceURI' },
  };

  const evidence = createEvidenceRecord(input);
  const upserted = upsertEvidence(provenance, input);

  assert.equal(evidence.id, upserted.id);
  assert.equal(provenance.evidence[evidence.id], upserted);
  assert.equal(upserted.kind, OBSERVER_KINDS.PARSER);
  assert.deepEqual(upserted.payload, { field: 'LinkResourceURI' });
});

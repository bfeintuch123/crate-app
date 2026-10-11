'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkingSourceWitnessTracker, createKeynoteWitnessObservation } = require('../parsers/working-source-witness');
const doc = (handle = 'doc-1', file = '/synthetic/A.key', extra = {}) => ({ id: handle, file, modified: false, current: true, ...extra });
const observe = (sequence, docs = [doc()], extra = {}) => createKeynoteWitnessObservation({
  projectId: 'project-1', activationToken: 'watch-1', version: '15.1.1', complete: true,
  sequence, documentCount: docs.length, processBefore: { pid: 42, startToken: 'OS-observed-start-1' },
  processAfter: { pid: 42, startToken: 'OS-observed-start-1' }, ...extra }, docs);
function pair(next) { const t = createWorkingSourceWitnessTracker(); t.observe(observe(1)); return t.observe(next); }

test('Save As-shaped same-handle transition stays disabled, even with caller enable flags', () => {
  const r = pair(observe(2, [doc('doc-1', '/synthetic/B.key')], { qualified: true, automaticSelectionAllowed: true }));
  assert.equal(r.kind, 'candidate'); assert.equal(r.automaticSelectionAllowed, false);
  assert.equal(r.transition.predecessorPath, '/synthetic/A.key');
});
for (const [name, docs, reason] of [
  ['ordinary save or cancelled Save As', [doc()], 'no-path-transition'],
  ['Save a Copy leaving original active', [doc()], 'no-path-transition'],
  ['copy-close-open', [doc('doc-2', '/synthetic/B.key')], 'document-set-changed'],
  ['duplicate then save', [doc('doc-1', '/synthetic/A.key', {current:false}), doc('doc-2','/synthetic/B.key')], 'document-set-changed'],
  ['modified successor / failed save', [doc('doc-1','/synthetic/B.key',{modified:true})], 'unsaved-first-save-or-background-transition'],
  ['background document transition', [doc('doc-1','/synthetic/B.key',{current:false})], 'unsaved-first-save-or-background-transition'],
]) test(name + ' cannot grant continuity', () => { const r=pair(observe(2,docs));assert.equal(r.kind,'none');assert.equal(r.reason,reason);assert.equal(r.automaticSelectionAllowed,false); });

test('restart, PID reuse, project/watch/version boundaries invalidate history', () => {
  for (const extra of [
    {processBefore:{pid:43,startToken:'new'},processAfter:{pid:43,startToken:'new'}},
    {processBefore:{pid:42,startToken:'new'},processAfter:{pid:42,startToken:'new'}},
    {activationToken:'watch-2'}, {projectId:'project-2'}, {version:'15.2'},
  ]) assert.equal(pair(observe(2,[doc('doc-1','/synthetic/B.key')],extra)).reason,'scope-or-process-changed');
});
test('restart during bridge read and missing process evidence reject observation', () => {
  assert.equal(observe(2,[doc()],{processAfter:{pid:43,startToken:'new'}}),null);
  assert.equal(observe(2,[doc()],{processBefore:{pid:42}}),null);
});
test('failed poll, sequence gap, replay and out-of-order poll cannot bridge history', () => {
  for (const bad of [null, observe(3), observe(1)]) {
    const t=createWorkingSourceWitnessTracker();t.observe(observe(1));assert.equal(t.observe(bad).kind,'invalidate');
    const next=t.observe(observe(4,[doc('doc-1','/synthetic/B.key')]));assert.notEqual(next.kind,'candidate');
  }
});
test('observed close/reopen ID reuse quarantines the process session', () => {
  const t=createWorkingSourceWitnessTracker();t.observe(observe(1));t.observe(observe(2,[]));
  assert.equal(t.observe(observe(3,[doc('doc-1','/synthetic/B.key')])).reason,'closed-handle-reused');
  assert.equal(t.observe(observe(4,[doc('doc-1','/synthetic/C.key')])).reason,'session-handle-contract-failed');
});
test('switching between documents is not a path transition', () => {
  const t=createWorkingSourceWitnessTracker();t.observe(observe(1,[doc(),doc('doc-2','/synthetic/B.key',{current:false})]));
  assert.equal(t.observe(observe(2,[doc('doc-1','/synthetic/A.key',{current:false}),doc('doc-2','/synthetic/B.key')])).reason,'no-path-transition');
});
test('first save of untitled document supplies no predecessor', () => {
  const t=createWorkingSourceWitnessTracker();t.observe(observe(1,[doc('doc-1',null,{modified:true})]));
  assert.equal(t.observe(observe(2)).reason,'unsaved-first-save-or-background-transition');
});
test('partial/malformed counts, duplicate handles/paths, unsafe paths and oversized inventory fail closed', () => {
  for (const snapshot of [observe(1,[doc()],{complete:false}), observe(1,[doc()],{documentCount:2}),
    observe(1,[doc(),doc()]),observe(1,[doc(),doc('doc-2')]),observe(1,[doc('doc-1','relative')]),
    observe(1,Array.from({length:65},(_,i)=>doc(String(i),'/synthetic/'+i,{current:false}))),
    observe(1,[doc('doc-1','/synthetic/../A.key')]),observe(1,[doc('doc-1','/synthetic/A\n.key')])]) assert.equal(snapshot,null);
});
test('two path transitions in one poll are ambiguous; filename changes and revert never become automatic', () => {
  const t=createWorkingSourceWitnessTracker();t.observe(observe(1,[doc(),doc('doc-2','/synthetic/B.key',{current:false})]));
  assert.equal(t.observe(observe(2,[doc('doc-1','/synthetic/C.key'),doc('doc-2','/synthetic/D.key',{current:false})])).reason,'multiple-path-transitions');
  for(const target of ['/synthetic/Renamed.key','/synthetic/A.key'])assert.equal(pair(observe(2,[doc('doc-1',target)])).automaticSelectionAllowed,false);
});
test('snapshots are copied so caller mutation cannot rewrite previous evidence', () => {
  const t=createWorkingSourceWitnessTracker(), first=observe(1);t.observe(first);first.documents[0].path='/synthetic/Forged.key';
  assert.equal(t.observe(observe(2,[doc('doc-1','/synthetic/B.key')])).transition.predecessorPath,'/synthetic/A.key');
});

for (const interruption of ['gap', 'invalid-poll', 'malformed-poll', 'replay']) {
  test(`v19 complete closure after ${interruption} permanently quarantines reused handles`, () => {
    const t = createWorkingSourceWitnessTracker(), results = [t.observe(observe(1))];
    if (interruption === 'invalid-poll') results.push(t.observe(null));
    if (interruption === 'malformed-poll') results.push(t.observe({ ...observe(2), documentCount: 99 }));
    if (interruption === 'replay') results.push(t.observe(observe(1)));
    const closureSequence = interruption === 'gap' ? 3 : 2;
    results.push(t.observe(observe(closureSequence, [])));
    results.push(t.observe(observe(closureSequence + 1, [doc('doc-1', '/synthetic/B.key')])));
    assert.equal(results.at(-1).reason, 'closed-handle-reused');
    results.push(t.observe(observe(closureSequence + 2, [doc('doc-1', '/synthetic/C.key')])));
    assert.equal(results.at(-1).reason, 'session-handle-contract-failed');
    assert.ok(results.every(result => result.automaticSelectionAllowed === false));
  });
}

for (const interruption of ['gap', 'invalid-poll']) {
  test(`v19 genuinely new handle can establish fresh disabled evidence after ${interruption}`, () => {
    const t = createWorkingSourceWitnessTracker(); t.observe(observe(1));
    if (interruption === 'invalid-poll') t.observe(null);
    const sequence = interruption === 'gap' ? 3 : 2;
    assert.notEqual(t.observe(observe(sequence, [])).kind, 'candidate');
    assert.notEqual(t.observe(observe(sequence + 1, [doc('new-2', '/synthetic/B.key')])).kind, 'candidate');
    const result = t.observe(observe(sequence + 2, [doc('new-2', '/synthetic/C.key')]));
    assert.equal(result.kind, 'candidate'); assert.equal(result.automaticSelectionAllowed, false);
    assert.equal(t.observe(observe(sequence + 3, [doc('doc-1', '/synthetic/D.key')])).reason, 'closed-handle-reused');
  });
}

test('v19 out-of-order empty inventory cannot retire a still-live handle', () => {
  const t = createWorkingSourceWitnessTracker(); t.observe(observe(2));
  assert.equal(t.observe(observe(1, [])).reason, 'replayed-or-out-of-order-poll');
  assert.notEqual(t.observe(observe(3)).kind, 'candidate');
  assert.equal(t.observe(observe(4, [doc('doc-1', '/synthetic/B.key')])).kind, 'candidate');
});

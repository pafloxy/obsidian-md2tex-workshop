/**
 * Exercise shared host/worker contracts with immutable fixtures and adversarial revisions.
 * Usage from root: node --test --test-isolation=none testing/protocol.test.cjs
 * No Obsidian, compiler, filesystem source writes or model dispatch occurs here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { protocolVersion, limits, sourceHash, documentId, validateBuildRequest, validateBuildEvent, validateBuildResult, validateRepairContext, validateRepairProposal } = require('../src/core/protocol.cjs');
const requestFixture = require('./fixtures/protocol/build-request.json');
const contextFixture = require('./fixtures/protocol/repair-context.json');
const proposalFixture = require('./fixtures/protocol/repair-proposal.json');

/** Clone a JSON fixture so individual tests cannot mutate another test's base. */
function clone(value) { return JSON.parse(JSON.stringify(value)); }

/** Return the result/event owner fields derived from the captured source, never live UI state. */
function owner(request = requestFixture) {
  return { protocolVersion, jobId: request.jobId, documentId: request.documentId, sourceHash: request.source.sha256 };
}

test('captured source retains Unicode and CRLF and cannot be mutated after validation', () => {
  const raw = clone(requestFixture);
  const result = validateBuildRequest(raw);
  assert.equal(result.source.text, requestFixture.source.text);
  assert.match(result.source.text, /α\r\n/);
  assert.equal(result.documentId, documentId(result.source.canonicalPath));
  assert.ok(Object.isFrozen(result.source));
  raw.source.text = 'new editor revision';
  assert.equal(result.source.text, requestFixture.source.text);
});

test('body/hash, path/identity and cached metadata mismatches are refused', () => {
  const changed = clone(requestFixture);
  changed.source.text += 'new text';
  assert.throws(() => validateBuildRequest(changed), { code: 'SOURCE_HASH_MISMATCH' });
  const moved = clone(requestFixture);
  moved.source.canonicalPath = '/scratch/random-input.md';
  assert.throws(() => validateBuildRequest(moved), { code: 'PROTOCOL_OWNER_MISMATCH' });
  const mixed = clone(requestFixture);
  mixed.cachedFrontmatter = { 'tex-workshop-engine': 'pdflatex' };
  assert.throws(() => validateBuildRequest(mixed), /Unknown field/);
});

test('requests reject incompatible versions, implicit paths, unknown execution fields and invalid recipes', () => {
  for (const change of [
    value => { value.protocolVersion = 'workshop-worker.v99'; },
    value => { value.outputRoot = './relative'; },
    value => { value.execution.shell = true; },
    value => { value.recipeOverrides.engine = 'invented-engine'; },
    value => { value.recipeOverrides = { noBib: true, bib: [] }; },
    value => { value.execution.timeoutMs = 0; },
    value => { value.source.editorRevision = null; },
  ]) {
    const value = clone(requestFixture);
    change(value);
    assert.throws(() => validateBuildRequest(value));
  }
  const disk = clone(requestFixture);
  disk.source.origin = 'disk';
  disk.source.editorRevision = null;
  assert.equal(validateBuildRequest(disk).source.origin, 'disk');
});

test('snapshot limits count UTF-8 bytes rather than character count', () => {
  const value = clone(requestFixture);
  value.source.text = 'α'.repeat(limits.sourceBytes / 2 + 1);
  value.source.sha256 = sourceHash(value.source.text);
  assert.throws(() => validateBuildRequest(value), /bounded text/);
});

test('malformed Unicode cannot pass as an exact source or repair, while BOM and complete pairs survive', () => {
  for (const text of ['\ud800', '\udfff']) {
    const request = clone(requestFixture);
    request.source.text = text;
    request.source.sha256 = sourceHash(text);
    assert.equal(request.source.sha256, sourceHash('\ufffd'), 'The wire guard must reject this UTF-8 replacement collision');
    assert.throws(() => validateBuildRequest(request), { code: 'INVALID_UNICODE' });
    const proposal = clone(proposalFixture);
    proposal.edits[0].after = text;
    assert.throws(() => validateRepairProposal(proposal, contextFixture), { code: 'INVALID_UNICODE' });
  }
  const valid = clone(requestFixture);
  valid.source.text = '\ufeff' + valid.source.text + '😀';
  valid.source.sha256 = sourceHash(valid.source.text);
  assert.equal(validateBuildRequest(valid).source.text, valid.source.text);
});

test('progress is bound to captured job/revision and rejects invalid sequencing data', () => {
  const progress = { ...owner(), kind: 'progress', sequence: 1, stage: 'compilation' };
  assert.equal(validateBuildEvent(progress, requestFixture).stage, 'compilation');
  for (const changed of [{ jobId: 'job-b' }, { documentId: 'a'.repeat(64) }, { sourceHash: 'b'.repeat(64) }]) {
    assert.throws(() => validateBuildEvent({ ...progress, ...changed }, requestFixture), { code: 'PROTOCOL_OWNER_MISMATCH' });
  }
  assert.throws(() => validateBuildEvent({ ...progress, sequence: -1 }, requestFixture));
});

test('results preserve the core envelope but refuse another note or source revision', () => {
  const result = { ...owner(), kind: 'result', resolvedRecipeHash: '1'.repeat(64), toolchainFingerprint: '2'.repeat(64), result: {
    schemaVersion: 'workshop-result.v1', command: 'build', status: 'success', diagnostics: [],
    source: { path: requestFixture.source.canonicalPath, sha256: requestFixture.source.sha256 },
  } };
  assert.equal(validateBuildResult(result, requestFixture).result.status, 'success');
  result.result.source.path = '/vault/other.md';
  assert.throws(() => validateBuildResult(result, requestFixture), { code: 'PROTOCOL_OWNER_MISMATCH' });
  result.result.status = 'error';
  delete result.result.source;
  result.resolvedRecipeHash = null;
  assert.equal(validateBuildResult(result, requestFixture).result.status, 'error');
});

test('repair contracts accept an exact bounded candidate and non-edit outcomes', () => {
  const context = validateRepairContext(contextFixture);
  const proposal = validateRepairProposal(proposalFixture, context);
  assert.equal(proposal.edits[0].after, '[ref{eq:square}]');
  assert.ok(Object.isFrozen(proposal.edits[0]));
  for (const outcome of ['no-fix', 'needs-human']) {
    assert.equal(validateRepairProposal({ ...proposalFixture, outcome, edits: [] }, context).outcome, outcome);
  }
});

test('stale repair identities and provider-selected files or commands are refused', () => {
  for (const field of ['jobId', 'documentId', 'sourceHash', 'failureId', 'resolvedRecipeHash', 'toolchainFingerprint']) {
    const proposal = clone(proposalFixture);
    proposal[field] = field === 'jobId' || field === 'failureId' ? 'different-owner' : 'a'.repeat(64);
    assert.throws(() => validateRepairProposal(proposal, contextFixture), { code: 'PROTOCOL_OWNER_MISMATCH' });
  }
  for (const addition of [{ file: 'other.md' }, { command: 'sh' }]) {
    const proposal = clone(proposalFixture);
    Object.assign(proposal.edits[0], addition);
    assert.throws(() => validateRepairProposal(proposal, contextFixture), /Unknown field/);
  }
});

test('ambiguous, empty, unknown-region and repeated-region edits never become candidates', () => {
  for (const change of [
    value => { value.edits[0].before = ''; },
    value => { value.edits[0].before = 'missing text'; },
    value => { value.edits[0].regionId = 'another-file'; },
    value => { value.edits.push(clone(value.edits[0])); },
    value => { value.outcome = 'needs-human'; },
    value => { value.edits[0].after = value.edits[0].before; },
  ]) {
    const proposal = clone(proposalFixture);
    change(proposal);
    assert.throws(() => validateRepairProposal(proposal, contextFixture));
  }
  const repeated = clone(contextFixture);
  repeated.regions[0].text += repeated.regions[0].text;
  assert.throws(() => validateRepairProposal(proposalFixture, repeated), /unambiguous/);
});

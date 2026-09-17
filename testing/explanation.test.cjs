/**
 * Exercise real startup/configuration/target failures and an explanation-only reply contract.
 * Usage from root: node --test --test-isolation=none testing/explanation.test.cjs
 * No model, native Obsidian, source editing by an agent or external installation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ToolchainClient } = require('../src/obsidian/client.cjs');
const { sourceHash, documentId, protocolVersion } = require('../src/core/protocol.cjs');
const { readRecordedFailure } = require('../src/core/failure-record.cjs');
const { readFailurePacket } = require('../src/core/failure-packet.cjs');
const { validateFailurePacket, validateExplanation, responseVersion } = require('../src/core/explanation-contract.cjs');
const { setTarget } = require('../src/core/targets.cjs');
const { execute } = require('./execute.cjs');
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts/workshop.cjs');

/** Capture a note and a complete worker request in project-local scratch space. */
async function fixture(recipeOverrides = {}) {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/explanation-'));
  const input = path.join(dir, 'draft.md');
  const text = '# Draft\n\nOriginal paragraph.\n';
  await fs.writeFile(input, text);
  const request = { protocolVersion, kind: 'build', jobId: randomUUID(), documentId: documentId(input),
    source: { canonicalPath: input, origin: 'editor', text, sha256: sourceHash(text), editorRevision: 'revision-1' },
    vaultRoot: dir, outputRoot: path.join(dir, 'output'), recipeOverrides, execution: { latexmk: 'latexmk', timeoutMs: 30000 } };
  const client = new ToolchainClient({ nodeCommand: process.execPath, cliPath: cli, outputRoot: request.outputRoot });
  return { dir, input, text, request, client };
}
/** Resolve one job's fixed record; never choose a latest result from another note. */
async function recordPath(f, request = f.request) {
  const jobs = path.join(f.request.outputRoot, '.jobs');
  const matches = (await fs.readdir(jobs)).filter(name => name.startsWith(request.jobId + '-'));
  assert.equal(matches.length, 1);
  return path.join(jobs, matches[0], 'failure.json');
}
/** Construct a synthetic explanation response for validator tests; this is not model output. */
function reply(packet) {
  return { schemaVersion: responseVersion, packetId: packet.packetId, failureId: packet.identity.failureId, sourceHash: packet.identity.sourceHash,
    verdict: 'explained', summary: 'The configured tool or resource is unavailable.', evidenceIds: ['diagnostic-1'],
    suggestions: [{ text: 'Check the configured executable or resource and rebuild after correcting it.', evidenceIds: ['diagnostic-1'] }] };
}

test('unavailable Node retains an exact request and a startup packet without an invented attempt', async () => {
  const f = await fixture();
  f.client.nodeCommand = path.join(f.dir, 'missing-node');
  let caught;
  await assert.rejects(() => f.client.invoke(f.request), error => { caught = error; return error.code === 'NODE_UNAVAILABLE'; });
  assert.equal(caught.failureRecord, await recordPath(f));
  await fs.writeFile(f.input, '# New live revision\n');
  const packet = await readRecordedFailure(caught.failureRecord);
  assert.equal(packet.origin, 'startup'); assert.equal(packet.category, 'tool-setup');
  assert.equal(packet.buildStatus, null); assert.equal(packet.identity.attemptId, null);
  assert.equal(packet.identity.jobId, f.request.jobId); assert.equal(packet.identity.sourceHash, f.request.source.sha256);
  assert.equal(packet.identity.toolchainFingerprint, null);
  assert.equal(await fs.readFile(f.input, 'utf8'), '# New live revision\n');
  assert.equal(validateExplanation(reply(packet), packet).verdict, 'explained');
});

test('early worker configuration failure records actual worker identity and validates through both CLI commands', async () => {
  const f = await fixture({ preamble: '/missing-test-preamble.tex' });
  const frame = await f.client.invoke(f.request);
  assert.equal(frame.result.status, 'error'); assert.equal(frame.result.attemptId, undefined);
  const filename = await recordPath(f);
  const packet = await readRecordedFailure(filename);
  assert.equal(packet.category, 'configuration'); assert.equal(packet.origin, 'worker');
  assert.equal(packet.identity.toolchainFingerprint, frame.toolchainFingerprint);
  assert.equal(packet.identity.resolvedRecipeHash, null);
  assert.equal(packet.identity.attemptId, null);
  const invoked = await execute(process.execPath, [cli, 'failure-packet', filename], { cwd: root });
  assert.deepEqual(JSON.parse(invoked.stdout), packet);
  const packetPath = path.join(f.dir, 'packet.json'); const responsePath = path.join(f.dir, 'response.json');
  await fs.writeFile(packetPath, JSON.stringify(packet)); await fs.writeFile(responsePath, JSON.stringify(reply(packet)));
  const accepted = await execute(process.execPath, [cli, 'explanation-validate', packetPath, responsePath], { cwd: root });
  assert.equal(JSON.parse(accepted.stdout).status, 'success');
  await fs.writeFile(responsePath, JSON.stringify({ ...reply(packet), sourceHash: '0'.repeat(64) }));
  const rejected = await execute(process.execPath, [cli, 'explanation-validate', packetPath, responsePath], { cwd: root }).catch(error => error);
  assert.equal(rejected.code, 1); assert.equal(JSON.parse(rejected.stdout).diagnostics[0].code, 'STALE_EXPLANATION');
  await fs.writeFile(path.join(f.dir, 'demo.json'), JSON.stringify({ filename, packetPath, responsePath }, null, 2));
});

test('a successful PDF with failed target publication produces target evidence and preserves edited TeX', async () => {
  const f = await fixture(); const target = path.join(f.dir, 'paper.tex');
  await setTarget({ input: f.input, target });
  const initial = await f.client.invoke(f.request); assert.equal(initial.result.target.status, 'success');
  await assert.rejects(fs.access(await recordPath(f)), { code: 'ENOENT' });
  const edited = (await fs.readFile(target, 'utf8')).replace('Original paragraph.', 'Independent TeX correction.');
  await fs.writeFile(target, edited);
  const request = { ...f.request, jobId: randomUUID() };
  const frame = await f.client.invoke(request);
  assert.equal(frame.result.status, 'success'); assert.equal(frame.result.target.code, 'TARGET_EDITED');
  const packet = await readRecordedFailure(await recordPath(f, request));
  assert.equal(packet.category, 'target-publication'); assert.equal(packet.buildStatus, 'success');
  assert.equal(packet.evidence[0].sourceLine, null);
  assert.ok(packet.omissions.some(item => /PDF compilation succeeded/.test(item)));
  const attemptPacket = await readFailurePacket(frame.result.artifacts.result);
  assert.equal(attemptPacket.category, 'target-publication'); assert.equal(attemptPacket.buildStatus, 'success');
  assert.equal(await fs.readFile(target, 'utf8'), edited); assert.equal(await fs.readFile(f.input, 'utf8'), f.text);
});

test('request tampering and foreign worker identities are refused', async () => {
  const f = await fixture({ preamble: '/missing-test-preamble.tex' }); await f.client.invoke(f.request);
  const filename = await recordPath(f); const requestPath = path.join(path.dirname(filename), 'request.json');
  const original = await fs.readFile(requestPath);
  await fs.writeFile(requestPath, original.toString() + '\n');
  await assert.rejects(() => readRecordedFailure(filename), { code: 'FAILURE_RECORD_INVALID' });
  await fs.writeFile(requestPath, original);
  const record = JSON.parse(await fs.readFile(filename)); record.outcome.frame.jobId = randomUUID();
  await fs.writeFile(filename, JSON.stringify(record));
  await assert.rejects(() => readRecordedFailure(filename), { code: 'PROTOCOL_OWNER_MISMATCH' });
});

test('failure-record write refusal does not replace the worker outcome or existing evidence', async () => {
  const f = await fixture({ preamble: '/missing-test-preamble.tex' });
  const run = f.client.run.bind(f.client); let filename;
  f.client.run = async (...args) => {
    const result = await run(...args);
    if (args[0][0] === 'worker') { filename = path.join(args[1], 'failure.json'); await fs.writeFile(filename, 'existing evidence'); }
    return result;
  };
  const frame = await f.client.invoke(f.request);
  assert.equal(frame.result.status, 'error'); assert.equal(frame.result.diagnostics[0].code, 'MISSING_PREAMBLE');
  assert.equal(await fs.readFile(filename, 'utf8'), 'existing evidence');
});

test('reply contracts reject stale, invented, oversized and executable fields; accepted text remains inert', async () => {
  const f = await fixture({ preamble: '/missing-test-preamble.tex' }); await f.client.invoke(f.request);
  const packet = await readRecordedFailure(await recordPath(f)); const valid = reply(packet);
  for (const mutate of [
    value => { value.packetId = '0'.repeat(64); }, value => { value.failureId = '0'.repeat(64); },
    value => { value.evidenceIds = ['imaginary']; }, value => { value.command = 'edit source'; },
    value => { value.suggestions[0].path = f.input; }, value => { value.summary = 'x'.repeat(9000); },
    value => { value.summary = '\ud800'; }, value => { value.verdict = 'applied'; },
  ]) { const value = JSON.parse(JSON.stringify(valid)); mutate(value); assert.throws(() => validateExplanation(value, packet)); }
  const accepted = validateExplanation({ ...valid, summary: '<script>untrusted literal text</script>' }, packet);
  assert.ok(Object.isFrozen(accepted.suggestions[0]));
  assert.equal(await fs.readFile(f.input, 'utf8'), f.text);
  const reordered = Object.fromEntries(Object.entries(packet).reverse()); assert.deepEqual(validateFailurePacket(reordered), packet);
  const changed = JSON.parse(JSON.stringify(packet)); changed.summary = 'Different failure';
  assert.throws(() => validateFailurePacket(changed), { code: 'FAILURE_PACKET_CHANGED' });
});

test('malformed startup responses preserve their causal error and failed recording cannot hide it', async () => {
  const f = await fixture(); const broken = path.join(f.dir, 'broken.cjs');
  await fs.writeFile(broken, '/** Synthetic failing companion. */\nprocess.stderr.write("SyntaxError: Unsupported syntax\\n"); process.exitCode = 1;\n');
  f.client.cliPath = broken;
  const run = f.client.run.bind(f.client);
  f.client.run = async (...args) => {
    const value = await run(...args);
    if (args[0][0] === 'capabilities') {
      const filename = await recordPath(f);
      await fs.writeFile(filename, 'preserved failure record');
    }
    return value;
  };
  await assert.rejects(() => f.client.invoke(f.request), error => {
    assert.equal(error.code, 'TOOLCHAIN_START_FAILED'); assert.match(error.message, /Unsupported syntax/);
    assert.equal(error.failureRecordError.code, 'EEXIST'); return true;
  });
  assert.equal(await fs.readFile(await recordPath(f), 'utf8'), 'preserved failure record');
});

test('packet scalar types and phase semantics cannot be forged even by resealing a packet', async () => {
  const { sealPacket } = require('../src/core/explanation-contract.cjs');
  const f = await fixture({ preamble: '/missing-test-preamble.tex' }); await f.client.invoke(f.request);
  const packet = await readRecordedFailure(await recordPath(f));
  for (const mutate of [
    value => { value.identity.sourceHash = [value.identity.sourceHash]; },
    value => { value.identity.jobId = [value.identity.jobId]; },
    value => { value.origin = 'startup'; value.buildStatus = 'success'; },
    value => { value.category = 'target-publication'; },
  ]) {
    const value = JSON.parse(JSON.stringify(packet)); delete value.packetId; mutate(value);
    assert.throws(() => sealPacket(value));
  }
});

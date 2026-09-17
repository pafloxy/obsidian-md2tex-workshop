/**
 * Verify read-only evidence preparation from real failed builds and hostile artifacts.
 * Usage from root: node --test --test-isolation=none testing/failure-packet.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('../src/core/workshop.cjs');
const { readFailurePacket, createFailurePacket, classifyFailure, limits } = require('../src/core/failure-packet.cjs');
const { sourceHash: hash } = require('../src/core/protocol.cjs');
const { execute } = require('./execute.cjs');
const root = path.resolve(__dirname, '..');

/** Build a failed fixture in an isolated directory while preserving the source. */
async function fixture(text = '# Draft\n\n![Measured curve](curve.png)\n') {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/failure packet-'));
  const input = path.join(dir, 'draft.md');
  await fs.writeFile(input, text);
  const result = await build({ input, outDir: path.join(dir, 'output'), vaultRoot: dir });
  return { dir, input, result, text };
}

test('real unsupported image produces a stable packet from the failing snapshot after live edits', async () => {
  const f = await fixture();
  assert.equal(f.result.status, 'error');
  const before = await fs.readFile(f.result.artifacts.result);
  await fs.writeFile(f.input, '# A newer unsaved-equivalent revision\n');
  const packet = await readFailurePacket(f.result.artifacts.result);
  assert.equal(packet.category, 'unsupported-syntax');
  assert.match(packet.summary, /image embeddings are not supported/i);
  assert.doesNotMatch(packet.summary, /M3/);
  assert.equal(packet.evidence[0].code, 'UNSUPPORTED_IMAGE');
  assert.equal(packet.evidence[0].sourceLine, 3);
  assert.match(packet.evidence.find(x => x.kind === 'source').text, /Measured curve/);
  assert.equal(packet.identity.sourceHash, hash(f.text));
  assert.equal(packet.identity.toolchainFingerprint, null);
  assert.ok(Object.isFrozen(packet.evidence[0]));
  assert.deepEqual(await readFailurePacket(f.result.artifacts.result), packet);
  assert.deepEqual(await fs.readFile(f.result.artifacts.result), before);
  assert.equal(await fs.readFile(f.input, 'utf8'), '# A newer unsaved-equivalent revision\n');
  const cli = await execute(process.execPath, [path.join(root, 'scripts/workshop.cjs'), 'failure-packet', f.result.artifacts.result], { cwd: root });
  assert.equal(cli.code, 0); assert.deepEqual(JSON.parse(cli.stdout), packet);
  await fs.writeFile(path.join(f.dir, 'packet.json'), JSON.stringify(packet, null, 2) + '\n');
});

test('actual TeX failure has a mapped diagnostic and bounded causal log evidence', async () => {
  const f = await fixture('# Broken math\n\n$$\n\\WorkshopUndefinedCommand{x}\n$$\n');
  assert.equal(f.result.status, 'error');
  const packet = await readFailurePacket(f.result.artifacts.result);
  assert.equal(packet.category, 'tex');
  assert.ok(packet.evidence[0].sourceEndLine >= packet.evidence[0].sourceLine);
  assert.match(packet.summary, /Undefined control sequence/);
  assert.match(packet.evidence.find(x => x.kind === 'log').text, /Undefined control sequence/);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= limits.packetBytes);
  assert.equal(await fs.readFile(f.input, 'utf8'), f.text);
  await fs.writeFile(path.join(f.dir, 'packet.json'), JSON.stringify(packet, null, 2) + '\n');
});

test('tool failures remain setup failures and source regions are never invented', () => {
  assert.equal(classifyFailure({ code: 'PROCESS_UNAVAILABLE' }, 'compilation'), 'tool-setup');
  assert.equal(classifyFailure({ code: 'PROCESS_TIMEOUT' }, 'conversion'), 'execution');
  assert.equal(classifyFailure({ code: 'UNRESOLVED_CITATION' }, 'validation'), 'bibliography');
  const result = { schemaVersion: 'workshop-result.v1', command: 'build', status: 'error', stage: 'compilation', attemptId: 'case-1',
    source: { path: '/captured/note.md', sha256: hash('hello') }, diagnostics: [{ severity: 'error', code: 'PROCESS_UNAVAILABLE', message: 'Missing executable', path: '/other/note.md', line: 1 }] };
  const a = createFailurePacket({ result, sourceText: 'hello' });
  assert.equal(a.category, 'tool-setup'); assert.equal(a.evidence.length, 1);
  const b = createFailurePacket({ result: { ...result, attemptId: 'case-2' }, sourceText: 'hello' });
  assert.equal(a.identity.failureId, b.identity.failureId); assert.notEqual(a.packetId, b.packetId);
  assert.throws(() => createFailurePacket({ result: { ...result, status: 'success' }, sourceText: 'hello' }), { code: 'FAILURE_REQUIRED' });
});

test('changed snapshots, forged ownership and symlinked evidence are refused', async () => {
  const f = await fixture();
  await fs.writeFile(f.result.artifacts.source, 'changed');
  await assert.rejects(() => readFailurePacket(f.result.artifacts.result), { code: 'FAILURE_SOURCE_CHANGED' });
  await fs.writeFile(f.result.artifacts.source, f.text);
  const result = { ...f.result, artifacts: { ...f.result.artifacts, source: f.input } };
  await fs.writeFile(f.result.artifacts.result, JSON.stringify(result));
  await assert.rejects(() => readFailurePacket(f.result.artifacts.result), { code: 'FAILURE_OWNER_MISMATCH' });
  await fs.writeFile(f.result.artifacts.result, JSON.stringify(f.result));
  await fs.rename(f.result.artifacts.source, f.result.artifacts.source + '.preserved');
  await fs.symlink(f.input, f.result.artifacts.source);
  await assert.rejects(() => readFailurePacket(f.result.artifacts.result));
  assert.equal(await fs.readFile(f.input, 'utf8'), f.text);
});

test('oversized evidence is bounded and huge neighboring lines cannot hide the failing line', async () => {
  const f = await fixture('x'.repeat(12000) + '\n\n![Fail here](a.png)\n');
  await fs.writeFile(f.result.artifacts.log, '! First causal error\n' + 'x'.repeat(limits.logBytes + 1024));
  const packet = await readFailurePacket(f.result.artifacts.result);
  assert.match(packet.evidence.find(x => x.kind === 'source').text, /Fail here/);
  assert.ok(packet.omissions.some(x => /256 KiB/.test(x)));
  for (const item of packet.evidence) if (item.text) assert.ok(Buffer.byteLength(item.text) <= limits.excerptBytes);
  await fs.writeFile(f.result.artifacts.result, 'x'.repeat(limits.resultBytes + 1));
  await assert.rejects(() => readFailurePacket(f.result.artifacts.result), { code: 'FAILURE_EVIDENCE_LIMIT' });
});

test('warnings cannot displace a causal TeX error and supplied validation log lines are respected', async () => {
  const f = await fixture();
  const result = { ...f.result, stage: 'compilation', diagnostics: [{ severity: 'error', code: 'LATEX_ERROR', message: 'Undefined control sequence.' }] };
  const packet = createFailurePacket({ result, sourceText: f.text, logText: 'main.tex:2: Package harmless Warning: Ignore\nnormal\n! Undefined control sequence.\nl.3 \\badcommand\n' });
  assert.equal(packet.evidence.find(x => x.kind === 'log').startLine, 2);
  const validation = createFailurePacket({ result: { ...result, stage: 'validation', diagnostics: [{ severity: 'error', code: 'UNRESOLVED_CITATION', message: 'Citation missing', logLine: 4 }] }, sourceText: f.text, logText: 'header\none\ntwo\nCitation missing\n' });
  assert.equal(validation.evidence.find(x => x.kind === 'log').startLine, 3);
});

test('successful attempts and CLI options are refused without writing packet files', async () => {
  const f = await fixture('# Successful note\n\nA valid paragraph.\n');
  assert.equal(f.result.status, 'success');
  const before = await fs.readdir(f.result.artifacts.attempt);
  const cli = await execute(process.execPath, [path.join(root, 'scripts/workshop.cjs'), 'failure-packet', f.result.artifacts.result], { cwd: root }).catch(error => error);
  assert.equal(cli.code, 1); assert.equal(JSON.parse(cli.stdout).diagnostics[0].code, 'FAILURE_REQUIRED');
  const invalid = await execute(process.execPath, [path.join(root, 'scripts/workshop.cjs'), 'failure-packet', f.result.artifacts.result, '--out-dir', f.dir], { cwd: root }).catch(error => error);
  assert.equal(invalid.code, 2);
  assert.deepEqual(await fs.readdir(f.result.artifacts.attempt), before);
});

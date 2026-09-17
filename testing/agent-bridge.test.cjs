/**
 * Exercise manual agent dispatch with synthetic local executables; no provider is contacted.
 * Usage from root: node --test --test-isolation=none testing/agent-bridge.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { sourceHash } = require('../src/core/protocol.cjs');
const { createFailurePacket } = require('../src/core/failure-packet.cjs');
const { validateAgentProfile, explainWithAgent } = require('../src/core/agent-dispatch.cjs');
const { execute } = require('./execute.cjs');
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts/workshop.cjs');

/** Prepare a failed captured source and a controllable fake agent under project tmp. */
async function fixture() {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/agent-bridge-test-'));
  const sourceText = '# Draft\n\n![missing](./figure.png)\n'; const input = path.join(dir, 'draft.md');
  await fs.writeFile(input, sourceText);
  const packet = createFailurePacket({ result: { schemaVersion: 'workshop-result.v1', command: 'build', status: 'error', stage: 'conversion', attemptId: 'attempt1',
    source: { path: input, sha256: sourceHash(sourceText) }, diagnostics: [{ severity: 'error', code: 'UNSUPPORTED_IMAGE', message: 'Image embedding unsupported.', line: 3 }] }, sourceText });
  const packetPath = path.join(dir, 'packet.json'); await fs.writeFile(packetPath, JSON.stringify(packet));
  const fake = path.join(dir, 'fake.cjs');
  await fs.writeFile(fake, `/** Synthetic agent; usage: node fake.cjs MODE. */
const mode = process.argv[2]; let input = '';
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'flood') process.stdout.write('x'.repeat(300000));
else if (mode === 'exit') process.exitCode = 7;
else process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
  const value = JSON.parse(input); const packet = value.packet;
  if (mode === 'bad') { process.stdout.write('not JSON'); return; }
  const reply = { schemaVersion: 'workshop-explanation.v1', packetId: packet.packetId, failureId: packet.identity.failureId,
    sourceHash: mode === 'stale' ? '0'.repeat(64) : packet.identity.sourceHash, verdict: 'explained',
    summary: 'Image embedding is unsupported.', evidenceIds: ['diagnostic-1'], suggestions: [] };
  process.stdout.write(JSON.stringify(reply));
  if (mode === 'double') process.stdout.write(JSON.stringify(reply));
});
`);
  const profile = { schemaVersion: 'workshop-agent-profile.v1', enabled: true, adapter: 'custom', executable: process.execPath,
    args: [fake, 'valid'], mode: 'trusted', timeoutMs: 1000 };
  const profilePath = path.join(dir, 'profile.json'); await fs.writeFile(profilePath, JSON.stringify(profile));
  return { dir, input, sourceText, packet, packetPath, profile, profilePath, fake };
}
/** Run the public CLI and capture its JSON envelope even for expected failure. */
async function command(f, args = [], profile = f.profile) {
  await fs.writeFile(f.profilePath, JSON.stringify(profile));
  const run = await execute(process.execPath, [cli, 'agent-explain', f.packetPath, '--profile', f.profilePath, ...args], { cwd: root }).catch(error => error);
  return { code: run.code, value: JSON.parse(run.stdout) };
}

test('explicit trusted custom wrapper returns one validated reply from captured evidence', async () => {
  const f = await fixture(); const result = await command(f, ['--allow-trusted-agent']);
  assert.equal(result.code, 0); assert.equal(result.value.status, 'success');
  assert.equal(result.value.explanation.packetId, f.packet.packetId);
  assert.equal(result.value.explanation.evidenceIds[0], 'diagnostic-1');
  assert.equal(await fs.readFile(f.input, 'utf8'), f.sourceText);
});

test('disabled, unapproved and unsupported restricted profiles never start the child', async () => {
  const f = await fixture(); const marker = path.join(f.dir, 'spawned');
  await fs.writeFile(f.fake, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`);
  for (const [profile, args, code] of [
    [{ ...f.profile, enabled: false }, ['--allow-trusted-agent'], 'AGENT_DISABLED'],
    [f.profile, [], 'AGENT_CONSENT_REQUIRED'],
    [{ ...f.profile, mode: 'restricted' }, ['--allow-trusted-agent'], 'AGENT_ISOLATION_UNAVAILABLE'],
  ]) { const result = await command(f, args, profile); assert.equal(result.code, 1); assert.equal(result.value.diagnostics[0].code, code); }
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('invalid profiles, stale replies and malformed output are rejected without touching Markdown', async () => {
  const f = await fixture();
  for (const changed of [{ ...f.profile, executable: 'node' }, { ...f.profile, args: 'shell string' }, { ...f.profile, shell: true },
    { ...f.profile, inheritEnv: ['NODE_OPTIONS', 'NODE_OPTIONS'] }]) assert.throws(() => validateAgentProfile(changed), { code: 'AGENT_PROFILE_INVALID' });
  for (const [mode, code] of [['stale', 'STALE_EXPLANATION'], ['bad', 'AGENT_PROTOCOL'], ['double', 'AGENT_PROTOCOL'], ['exit', 'AGENT_EXIT_FAILED']]) {
    const result = await command(f, ['--allow-trusted-agent'], { ...f.profile, args: [f.fake, mode] });
    assert.equal(result.code, 1); assert.equal(result.value.diagnostics[0].code, code);
  }
  assert.equal(await fs.readFile(f.input, 'utf8'), f.sourceText);
});

test('quiet hangs, output floods and missing executables remain bounded failures', async () => {
  const f = await fixture();
  for (const [profile, code] of [
    [{ ...f.profile, args: [f.fake, 'hang'] }, 'AGENT_TIMEOUT'],
    [{ ...f.profile, args: [f.fake, 'flood'] }, 'AGENT_OUTPUT_LIMIT'],
    [{ ...f.profile, executable: path.join(f.dir, 'missing-agent') }, 'AGENT_NOT_FOUND'],
  ]) { const result = await command(f, ['--allow-trusted-agent'], profile); assert.equal(result.code, 1); assert.equal(result.value.diagnostics[0].code, code); }
});

test('pre-aborted direct dispatch does not start an agent', async () => {
  const f = await fixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(() => explainWithAgent(f.packet, f.profile, { allowTrusted: true, scratchRoot: path.join(root, 'tmp'), signal: abort.signal }), { code: 'AGENT_CANCELLED' });
});

test('active cancellation terminates a hanging child without changing source', async () => {
  const f = await fixture(); const abort = new AbortController();
  const profile = { ...f.profile, args: [f.fake, 'hang'], timeoutMs: 5000 };
  const pending = explainWithAgent(f.packet, profile, { allowTrusted: true, scratchRoot: path.join(root, 'tmp'), signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, { code: 'AGENT_CANCELLED' });
  assert.equal(await fs.readFile(f.input, 'utf8'), f.sourceText);
});

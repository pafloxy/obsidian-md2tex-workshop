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
const { runAgentProcess } = require('../src/core/agent-process.cjs');
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

test('agent output path replacement cannot substitute an unchecked oversized reply', async () => {
  const f = await fixture();
  const fake = path.join(f.dir, 'replace-output.cjs');
  await fs.writeFile(fake, `const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync(0,'utf8')).packet;
fs.renameSync('stdout.json','original-stdout.json');
fs.writeFileSync('stdout.json',' '.repeat(300000)+JSON.stringify({schemaVersion:'workshop-explanation.v1',packetId:p.packetId,failureId:p.identity.failureId,sourceHash:p.identity.sourceHash,verdict:'explained',summary:'Invalid replacement',evidenceIds:['diagnostic-1'],suggestions:[]}));\n`);
  await assert.rejects(explainWithAgent(f.packet, { ...f.profile, args: [fake] }, { allowTrusted: true, scratchRoot: f.dir }), { code: 'AGENT_OUTPUT_FAILED' });
  assert.equal(await fs.readFile(f.input, 'utf8'), f.sourceText);
});

test('agent FIFO replacement settles without waiting on the replacement pathname', async () => {
  const f = await fixture();
  const fake = path.join(f.dir, 'fifo-output.cjs');
  await fs.writeFile(fake, `const fs=require('node:fs');const {spawnSync}=require('node:child_process');
fs.renameSync('stdout.json','original-stdout.json');
if(spawnSync('mkfifo',['stdout.json']).status!==0)process.exit(7);\n`);
  const helper = path.join(f.dir, 'invoke-fifo.cjs');
  await fs.writeFile(helper, `const {runAgentProcess}=require(${JSON.stringify(path.join(root, 'src/core/agent-process.cjs'))});
runAgentProcess({executable:process.execPath,args:[${JSON.stringify(fake)}],inheritEnv:[],timeoutMs:1000},'{}\\n',{cwd:${JSON.stringify(path.join(f.dir,'fifo-job'))}})
  .then(()=>process.exitCode=9,error=>{if(error.code!=='AGENT_OUTPUT_FAILED')process.exitCode=8;});\n`);
  await fs.mkdir(path.join(f.dir, 'fifo-job'));
  const result = await execute(process.execPath, [helper], { cwd: root, timeout: 3500 });
  assert.equal(result.code, 0);
});

test('agent symlink replacement is refused without following its target', async () => {
  const f = await fixture();
  const fake = path.join(f.dir, 'link-output.cjs');
  await fs.writeFile(fake, `const fs=require('node:fs');
fs.renameSync('stdout.json','original-stdout.json');
fs.symlinkSync('original-stdout.json','stdout.json');\n`);
  await assert.rejects(explainWithAgent(f.packet, { ...f.profile, args: [fake] }, { allowTrusted: true, scratchRoot: f.dir }), { code: 'AGENT_OUTPUT_FAILED' });
});

test('missing output pathname is refused without reopening it', async () => {
  const f = await fixture();
  const fake = path.join(f.dir, 'missing-output.cjs');
  await fs.writeFile(fake, `require('node:fs').renameSync('stdout.json','original-stdout.json');\n`);
  await assert.rejects(explainWithAgent(f.packet, { ...f.profile, args: [fake] }, { allowTrusted: true, scratchRoot: f.dir }), { code: 'AGENT_OUTPUT_FAILED' });
});

test('abort during final agent readback revokes a completed child reply', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const original = fs.open;
  let readback = false;
  fs.open = async function(filename, flags, ...args) {
    const handle = await original.call(this, filename, flags, ...args);
    if (typeof filename === 'string' && filename.endsWith('/stdout.json') && flags === 'wx+') {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { readback = true; controller.abort(); return read(...readArgs); };
    }
    return handle;
  };
  try {
    await assert.rejects(explainWithAgent(f.packet, f.profile, { allowTrusted: true, scratchRoot: f.dir, signal: controller.signal }), { code: 'AGENT_CANCELLED' });
    assert.equal(readback, true);
  } finally { fs.open = original; }
});

test('abort after runner readback cannot publish a validated explanation', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const original = JSON.parse;
  let intercepted = false;
  JSON.parse = function(value, ...args) {
    const parsed = original.call(this, value, ...args);
    if (typeof value === 'string' && value.startsWith('{"schemaVersion":"workshop-explanation.v1"')) {
      intercepted = true;
      controller.abort();
    }
    return parsed;
  };
  try {
    await assert.rejects(explainWithAgent(f.packet, f.profile, { allowTrusted: true, scratchRoot: f.dir, signal: controller.signal }), { code: 'AGENT_CANCELLED' });
    assert.equal(intercepted, true);
  } finally { JSON.parse = original; }
});

test('deadline already spent on setup cannot start an agent', async () => {
  const f = await fixture();
  const marker = path.join(f.dir, 'spawned-after-deadline');
  const fake = path.join(f.dir, 'mark-start.cjs');
  await fs.writeFile(fake, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`);
  const original = fs.open;
  fs.open = async function(filename, ...args) {
    if (typeof filename === 'string' && filename.endsWith('/request.json')) await new Promise(resolve => setTimeout(resolve, 1050));
    return original.call(this, filename, ...args);
  };
  try {
    const cwd = await fs.mkdtemp(path.join(f.dir, 'setup-'));
    await assert.rejects(runAgentProcess({ ...f.profile, args: [fake], inheritEnv: [] }, '{}\n', { cwd }), { code: 'AGENT_TIMEOUT' });
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  } finally { fs.open = original; }
});

test('deadline remains active during descriptor readback', async () => {
  const f = await fixture();
  const original = fs.open;
  let readback = false;
  fs.open = async function(filename, flags, ...args) {
    const handle = await original.call(this, filename, flags, ...args);
    if (typeof filename === 'string' && filename.endsWith('/stdout.json') && flags === 'wx+') {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { readback = true; await new Promise(resolve => setTimeout(resolve, 1100)); return read(...readArgs); };
    }
    return handle;
  };
  try {
    await assert.rejects(explainWithAgent(f.packet, f.profile, { allowTrusted: true, scratchRoot: f.dir }), { code: 'AGENT_TIMEOUT' });
    assert.equal(readback, true);
  } finally { fs.open = original; }
});

test('truncated retained output during readback cannot be accepted', async () => {
  const f = await fixture();
  const original = fs.open;
  let intercepted = false;
  fs.open = async function(filename, flags, ...args) {
    const handle = await original.call(this, filename, flags, ...args);
    if (typeof filename === 'string' && filename.endsWith('/stdout.json') && flags === 'wx+') {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { intercepted = true; await handle.truncate(0); return read(...readArgs); };
    }
    return handle;
  };
  try {
    await assert.rejects(explainWithAgent(f.packet, f.profile, { allowTrusted: true, scratchRoot: f.dir }), { code: 'AGENT_OUTPUT_FAILED' });
    assert.equal(intercepted, true);
  } finally { fs.open = original; }
});

test('successful child with failed descriptor cleanup is not reported as success', async () => {
  const f = await fixture();
  const original = fs.open;
  fs.open = async function(filename, flags, ...args) {
    const handle = await original.call(this, filename, flags, ...args);
    if (typeof filename === 'string' && filename.endsWith('/stdout.json') && flags === 'wx+') {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw new Error('Synthetic close failure'); };
    }
    return handle;
  };
  try {
    await assert.rejects(explainWithAgent(f.packet, f.profile, { allowTrusted: true, scratchRoot: f.dir }), { code: 'AGENT_CLEANUP_INCOMPLETE' });
  } finally { fs.open = original; }
});

test('Codex preset fixes read-only noninteractive flags and accepts one matching JSON reply', async () => {
  const f = await fixture();
  const executable = path.join(f.dir, 'codex-fixture.cjs');
  await fs.writeFile(executable, `#!/usr/bin/env node
/** Model only the Codex CLI argument and stdin/stdout contract; usage: ./codex-fixture.cjs [fixed args]. */
const fs = require('node:fs');
const args = process.argv.slice(2);
for (const flag of ['-a', 'never', 'exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--output-schema', '-']) if (!args.includes(flag)) process.exit(7);
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
if (schema.additionalProperties !== false || schema.properties.verdict.enum[0] !== 'explained') process.exit(8);
let text = ''; process.stdin.on('data', chunk => { text += chunk; }).on('end', () => {
  const { packet } = JSON.parse(text);
  process.stdout.write(JSON.stringify({ schemaVersion: 'workshop-explanation.v1', packetId: packet.packetId,
    failureId: packet.identity.failureId, sourceHash: packet.identity.sourceHash, verdict: 'explained',
    summary: 'The image embedding is unsupported.', evidenceIds: ['diagnostic-1'], suggestions: [] }));
});
`);
  await fs.chmod(executable, 0o755);
  const profile = { ...f.profile, adapter: 'codex', executable, args: [], timeoutMs: 3000 };
  const refused = await command(f, [], profile);
  assert.equal(refused.value.diagnostics[0].code, 'AGENT_CONSENT_REQUIRED');
  const accepted = await command(f, ['--allow-trusted-agent'], profile);
  assert.equal(accepted.code, 0);
  assert.equal(accepted.value.explanation.packetId, f.packet.packetId);
  assert.equal(await fs.readFile(f.input, 'utf8'), f.sourceText);
  assert.throws(() => validateAgentProfile({ ...profile, args: ['--dangerously-bypass-approvals-and-sandbox'] }), { code: 'AGENT_PROFILE_INVALID' });
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

test('stderr overflow and invalid UTF-8 retain their typed failures', async () => {
  const f = await fixture();
  const fake = path.join(f.dir, 'output-failures.cjs');
  await fs.writeFile(fake, `if(process.argv[2]==='stderr')process.stderr.write('x'.repeat(70000));
else process.stdout.write(Buffer.from([0xc3,0x28]));\n`);
  for (const [mode, code] of [['stderr', 'AGENT_OUTPUT_LIMIT'], ['utf8', 'AGENT_PROTOCOL']]) {
    const result = await command(f, ['--allow-trusted-agent'], { ...f.profile, args: [fake, mode] });
    assert.equal(result.code, 1);
    assert.equal(result.value.diagnostics[0].code, code);
  }
});

test('TERM-resistant agent is killed after timeout grace', async () => {
  const f = await fixture();
  const fake = path.join(f.dir, 'term-resistant.cjs');
  await fs.writeFile(fake, `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`);
  await fs.writeFile(f.profilePath, JSON.stringify({ ...f.profile, args: [fake], timeoutMs: 1000 }));
  const result = await execute(process.execPath, [cli, 'agent-explain', f.packetPath, '--profile', f.profilePath, '--allow-trusted-agent'],
    { cwd: root, timeout: 4500 }).catch(error => error);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].code, 'AGENT_TIMEOUT');
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

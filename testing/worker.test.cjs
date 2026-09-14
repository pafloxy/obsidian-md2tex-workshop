/**
 * Exercise captured-source execution and real managed worker/process lifetimes.
 * Usage from root: node --test --test-isolation=none testing/worker.test.cjs
 * All generated notes, tools, process logs and outputs stay under project tmp/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execute } = require('./execute.cjs');
const { ToolchainClient } = require('../src/obsidian/client.cjs');
const { executeBuild } = require('../src/core/jobs.cjs');
const { documentDirectory, releaseAbandonedJob } = require('../src/core/artifacts.cjs');
const { protocolVersion, documentId, sourceHash } = require('../src/core/protocol.cjs');
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts/workshop.cjs');

/** Create one isolated job case. */
async function scratch() {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  return fs.mkdtemp(path.join(root, 'tmp/manual worker-'));
}

/** Build a request whose logical source path is independent of its transport JSON filename. */
function request(dir, text, overrides = {}) {
  const canonicalPath = path.join(dir, 'draft.md');
  return { protocolVersion, kind: 'build', jobId: randomUUID(), documentId: documentId(canonicalPath),
    source: { canonicalPath, origin: 'editor', text, sha256: sourceHash(text), editorRevision: 'captured-1' },
    vaultRoot: dir, outputRoot: path.join(dir, 'output'), recipeOverrides: {}, execution: { latexmk: 'latexmk', timeoutMs: 30000 }, ...overrides };
}

/** Construct the actual file-transport client with a known standalone Node executable. */
function client(value) { return new ToolchainClient({ nodeCommand: process.execPath, cliPath: cli, outputRoot: value.outputRoot }); }

/** Create a deliberately defective companion for transport rejection tests. */
async function brokenCompanion(dir, workerBody, capabilityPatch = '') {
  const filename = path.join(dir, 'broken companion.cjs');
  const modulePath = JSON.stringify(path.join(root, 'src/core/capabilities.cjs'));
  await fs.writeFile(filename, `/** Synthetic protocol fixture. Usage: invoked by ToolchainClient tests only. */\n(async () => { if (process.argv[2] === 'capabilities') { const value = await require(${modulePath}).capabilities(); ${capabilityPatch}; process.stdout.write(JSON.stringify(value)); } else { ${workerBody} } })();\n`);
  return filename;
}

/** Write an explicitly synthetic executable for routing and process-lifetime tests. */
async function tool(dir, body) {
  const filename = path.join(dir, 'fake latexmk.cjs');
  await fs.writeFile(filename, `#!/usr/bin/env node\n/** Synthetic test tool. Usage: invoked only by the isolated worker fixture. */\n${body}\n`, { mode: 0o755 });
  return filename;
}

/** Wait for an observable fixture condition with a small fixed deadline. */
async function until(predicate, milliseconds = 8000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error('Timed out waiting for fixture condition');
}

test('captured unsaved text compiles through the shared core and matches terminal TeX', async () => {
  const dir = await scratch();
  const text = '# Captured draft\n\n> [!lemma] A square\n> <!-- [label{lem:square}] -->\n>\n> The value $x^2$ is nonnegative.\n\nSee [ref{lem:square}].\n';
  const value = request(dir, text);
  await fs.writeFile(value.source.canonicalPath, '# Different saved revision\n');
  const events = [];
  const frame = await client(value).invoke(value, { onEvent: event => events.push(event) });
  assert.equal(frame.result.status, 'success', JSON.stringify(frame));
  assert.equal(await fs.readFile(frame.result.artifacts.source, 'utf8'), text);
  assert.equal(await fs.readFile(value.source.canonicalPath, 'utf8'), '# Different saved revision\n');
  assert.ok(events.some(event => event.stage === 'compilation'));
  assert.ok(events.every(event => event.documentId === value.documentId && event.sourceHash === value.source.sha256));
  assert.equal(frame.result.source.path, value.source.canonicalPath);
  assert.equal(path.dirname(path.dirname(frame.result.artifacts.attempt)), documentDirectory(value.source.canonicalPath, value.outputRoot));
  await fs.writeFile(value.source.canonicalPath, text);
  const terminal = await execute(process.execPath, [cli, 'build', value.source.canonicalPath, '--out-dir', path.join(dir, 'terminal'), '--vault-root', dir], { cwd: root });
  const terminalResult = JSON.parse(terminal.stdout);
  assert.equal(await fs.readFile(frame.result.artifacts.body, 'utf8'), await fs.readFile(terminalResult.artifacts.body, 'utf8'));
  assert.deepEqual(frame.result.diagnostics, terminalResult.diagnostics);
});

test('recipe metadata comes from the captured buffer, while the transport filename never owns history', async () => {
  const dir = await scratch();
  const preamble = path.join(dir, 'article.tex');
  await fs.writeFile(preamble, '\\documentclass{article}\n');
  const executable = await tool(dir, "const fs = require('node:fs'); fs.writeFileSync('main.log', 'Synthetic successful tool log.'); fs.writeFileSync('main.pdf', '%PDF-1.4\\n'); fs.writeFileSync('arguments.json', JSON.stringify(process.argv));");
  const value = request(dir, '---\ntex-workshop-engine: xelatex\ntex-workshop-preamble: article.tex\n---\n# Unsaved recipe\n', { recipeOverrides: { engine: 'pdflatex', preamble: path.join(dir, 'missing-control.tex') }, execution: { latexmk: executable, timeoutMs: 3000 } });
  await fs.writeFile(value.source.canonicalPath, '---\ntex-workshop-engine: pdflatex\n---\n# Saved\n');
  const frame = await client(value).invoke(value);
  assert.equal(frame.result.status, 'success', JSON.stringify(frame));
  assert.equal(frame.result.profile.engine, 'xelatex');
  assert.equal(frame.result.profile.preamblePath, preamble);
  assert.equal(frame.result.profile.origins.preamble, 'yaml');
  assert.equal(frame.result.profile.origins.engine, 'yaml');
  assert.ok(JSON.parse(await fs.readFile(path.join(frame.result.artifacts.attempt, 'arguments.json'))).includes('-xelatex'));
  assert.doesNotMatch(await fs.readFile(frame.result.artifacts.body, 'utf8'), /tex-workshop|Saved/);
});

test('a failed captured revision keeps the previous successful artifact and exact failure owner', async () => {
  const dir = await scratch();
  const first = request(dir, '# First revision\n\nValid content.\n');
  const good = await client(first).invoke(first);
  assert.equal(good.result.status, 'success', JSON.stringify(good));
  const bad = request(dir, '# Broken revision\n\nSee [ref{missing}].\n');
  const failed = await client(bad).invoke(bad);
  assert.equal(failed.result.status, 'error');
  assert.equal(failed.sourceHash, bad.source.sha256);
  assert.equal(failed.lastSuccessfulResult.artifacts.pdf, good.result.artifacts.pdf);
  assert.ok(failed.result.diagnostics.some(item => item.code === 'UNRESOLVED_REFERENCE'));
  assert.equal((await fs.readFile(good.result.artifacts.pdf)).subarray(0, 5).toString(), '%PDF-');
});

test('pre-cancelled requests do not create build attempts and missing Node is actionable', async () => {
  const dir = await scratch();
  const value = request(dir, '# Cancelled\n');
  const abort = new AbortController();
  abort.abort();
  const frame = await executeBuild(value, { signal: abort.signal });
  assert.equal(frame.result.status, 'error');
  assert.ok(frame.result.diagnostics.some(item => item.code === 'BUILD_CANCELLED'));
  await assert.rejects(() => fs.access(value.outputRoot), { code: 'ENOENT' });
  const missing = new ToolchainClient({ nodeCommand: path.join(dir, 'no-node'), cliPath: cli, outputRoot: value.outputRoot });
  await assert.rejects(() => missing.invoke(value), { code: 'NODE_UNAVAILABLE' });
});

test('incompatible companions and malformed or foreign progress cannot start/publish a valid job', async () => {
  for (const [body, patch, code] of [
    ['', "value.protocolVersion = 'unsupported.v99'", 'TOOLCHAIN_INCOMPATIBLE'],
    ["process.stdout.write('invalid JSON\\n')", '', 'WORKER_PROTOCOL'],
    ["const request = JSON.parse(require('node:fs').readFileSync(process.argv[3])); process.stdout.write(JSON.stringify({ protocolVersion: request.protocolVersion, kind: 'progress', jobId: 'foreign-job', documentId: request.documentId, sourceHash: request.source.sha256, sequence: 0, stage: 'compilation' }) + '\\n')", '', 'PROTOCOL_OWNER_MISMATCH'],
  ]) {
    const dir = await scratch();
    const value = request(dir, '# Safe source\n');
    const cliPath = await brokenCompanion(dir, body, patch);
    const transport = new ToolchainClient({ nodeCommand: process.execPath, cliPath, outputRoot: value.outputRoot });
    await assert.rejects(() => transport.invoke(value), { code });
    await assert.rejects(() => fs.access(documentDirectory(value.source.canonicalPath, value.outputRoot)), { code: 'ENOENT' });
  }
});

test('the transport bounds quiet hangs and excessive output independently of TeX', async () => {
  for (const [body, code] of [["process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", 'WORKER_TIMEOUT'],
    ["process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1)); setInterval(() => {}, 1000)", 'WORKER_OUTPUT_LIMIT']]) {
    const dir = await scratch();
    const cliPath = await brokenCompanion(dir, body);
    const transport = new ToolchainClient({ nodeCommand: process.execPath, cliPath, outputRoot: path.join(dir, 'output') });
    const directory = await transport.directory('limit');
    const started = Date.now();
    await assert.rejects(() => transport.run(['worker'], directory, { timeoutMs: code === 'WORKER_TIMEOUT' ? 150 : 5000 }), { code });
    assert.ok(Date.now() - started < 6000, 'transport must stop within its deadline and grace period');
  }
});

test('cancelling a worker stops a signal-resistant grandchild and releases the document', async (t) => {
  const dir = await scratch();
  const marker = path.join(dir, 'heartbeat');
  const pidFile = path.join(dir, 'child.pid');
  const childCode = `/** Signal-resistant child fixture. */ const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'.'),30);`;
  const executable = await tool(dir, `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'}); setInterval(()=>{},1000);`);
  const value = request(dir, '# Cancel me\n', { execution: { latexmk: executable, timeoutMs: 10000 } });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const pending = client(value).invoke(value, { signal: abort.signal }).catch(error => error);
  await until(() => fs.stat(marker).then(stat => stat.size > 0, () => false));
  abort.abort();
  const error = await pending;
  assert.equal(error.code, 'BUILD_CANCELLED');
  const size = (await fs.stat(marker)).size;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await fs.stat(marker)).size, size, 'No descendant may continue writing after cancellation finishes');
  await assert.rejects(() => fs.access(path.join(documentDirectory(value.source.canonicalPath, value.outputRoot), '.build.lock')), { code: 'ENOENT' });
});

test('hard worker death kills its remaining group and recovers only its own abandoned lock', async () => {
  const dir = await scratch();
  const executable = await tool(dir, "setTimeout(()=>process.kill(process.ppid,'SIGKILL'),50); setInterval(()=>{},1000);");
  const value = request(dir, '# Crash fixture\n', { execution: { latexmk: executable, timeoutMs: 3000 } });
  const originalKill = process.kill; let delayed = false;
  /** Model a live descendant taking time to disappear after the host's termination request. */
  process.kill = function delayGroupExit(pid, signal) {
    if (pid < 0 && signal === 'SIGKILL') {
      try {
        originalKill(pid, 0); delayed = true;
        setTimeout(() => { try { originalKill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 100);
        return true;
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return originalKill(pid, signal);
  };
  let error;
  try { error = await client(value).invoke(value).catch(cause => cause); }
  finally { process.kill = originalKill; }
  assert.equal(delayed, true);
  assert.equal(error.code, 'WORKER_PROTOCOL');
  assert.equal(error.lockRecovery.released, true, JSON.stringify(error.lockRecovery));
  const lockPath = path.join(documentDirectory(value.source.canonicalPath, value.outputRoot), '.build.lock');
  await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' });
  const termination = JSON.parse(await fs.readFile(path.join(error.directory, 'termination.json')));
  await fs.writeFile(lockPath, JSON.stringify({ pid: termination.workerPid, jobId: 'another-job', source: value.source.canonicalPath }));
  assert.equal((await releaseAbandonedJob(value, termination.workerPid)).reason, 'different-owner');
  assert.equal(JSON.parse(await fs.readFile(lockPath)).jobId, 'another-job');
});

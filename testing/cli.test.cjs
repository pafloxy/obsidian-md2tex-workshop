/**
 * Exercise the workshop's public CLI with real conversion and TeX processes.
 * Usage from the project root: node --test testing/cli.test.cjs
 * All generated fixtures and build results are retained under ./tmp/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('./execute.cjs');

const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'scripts/workshop.cjs');

/** Run the actual CLI and parse its documented JSON result. */
async function invoke(args) {
  const run = await execute(process.execPath, [cliPath, ...args], { cwd: projectRoot }).catch(error => error);
  if (!run.stdout) throw new Error(`CLI did not return JSON: ${run.message || run.stderr}`);
  return { code: run.code, result: JSON.parse(run.stdout), stderr: run.stderr };
}

/** Create a private test case directory beneath the project scratch root. */
async function scratch() {
  await fs.mkdir(path.join(projectRoot, 'tmp'), { recursive: true });
  return fs.mkdtemp(path.join(projectRoot, 'tmp/cli-test-'));
}

test('a terminal build returns a real PDF, source snapshot, and last-success pointer', async () => {
  const dir = await scratch();
  const input = path.join(dir, 'draft.md');
  await fs.writeFile(input, '# Working draft\n\nA sentence with $x^2$.\n');
  const { code, result } = await invoke(['build', input, '--out-dir', path.join(dir, 'output')]);
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.status, 'success');
  assert.equal((await fs.readFile(result.artifacts.pdf)).subarray(0, 5).toString(), '%PDF-');
  assert.equal(await fs.readFile(result.artifacts.source, 'utf8'), await fs.readFile(input, 'utf8'));
  const pointer = JSON.parse(await fs.readFile(result.artifacts.lastSuccess, 'utf8'));
  assert.equal(pointer.attemptId, result.attemptId);
  assert.equal(pointer.artifacts.pdf, result.artifacts.pdf);
});

test('doctor diagnoses an unavailable preamble without creating output files', async () => {
  const dir = await scratch();
  const missing = path.join(dir, 'missing-preamble.tex');
  const { code, result } = await invoke(['doctor', '--preamble', missing, '--out-dir', path.join(dir, 'output')]);
  assert.equal(code, 1);
  assert.equal(result.stage, 'configuration');
  assert.ok(result.diagnostics.some((item) => item.code === 'MISSING_PREAMBLE' && item.path === missing));
  assert.deepEqual(await fs.readdir(dir), []);
});

test('build resolves frontmatter from the same input before control fallbacks', async () => {
  const dir = await scratch();
  const input = path.join(dir, 'draft.md');
  await fs.writeFile(input, '---\ntex-workshop-preamble: ./missing.tex\n---\n# Draft\n\nA complete sentence.\n');
  const failed = await invoke(['build', input, '--vault-root', dir, '--converter', path.join(projectRoot, 'testing/fixtures/cli/external-converter.py'), '--out-dir', path.join(dir, 'output')]);
  assert.equal(failed.code, 1);
  assert.ok(failed.result.diagnostics.some(item => item.code === 'MISSING_PREAMBLE'));
  const preamble = path.join(dir, 'article.tex');
  await fs.writeFile(preamble, '\\documentclass{article}\n');
  const stillMissing = await invoke(['build', input, '--vault-root', dir, '--preamble', preamble, '--out-dir', path.join(dir, 'output')]);
  assert.ok(stillMissing.result.diagnostics.some(item => item.code === 'MISSING_PREAMBLE'));
  await fs.writeFile(input, '---\ntex-workshop-preamble: article.tex\n---\n# Draft\n\nA complete sentence.\n');
  const recovered = await invoke(['build', input, '--vault-root', dir, '--converter', path.join(projectRoot, 'testing/fixtures/cli/external-converter.py'), '--preamble', path.join(dir, 'missing-control.tex'), '--out-dir', path.join(dir, 'output')]);
  assert.equal(recovered.code, 0, JSON.stringify(recovered.result));
  assert.equal(recovered.result.profile.preamblePath, preamble);
  assert.equal(recovered.result.profile.origins.preamble, 'yaml');
  assert.doesNotMatch(await fs.readFile(recovered.result.artifacts.body, 'utf8'), /tex-workshop-preamble/);
});

test('unresolved references and compiler failures preserve the previous successful PDF', async () => {
  const dir = await scratch();
  const input = path.join(dir, 'draft.md');
  const args = ['build', input, '--out-dir', path.join(dir, 'output')];
  await fs.writeFile(input, '# Draft\n\nThis revision is complete.\n');
  const good = await invoke(args);
  assert.equal(good.code, 0, JSON.stringify(good.result));
  const preserved = await fs.readFile(good.result.artifacts.pdf);
  await fs.writeFile(input, '# Draft\n\nSee [add-ref:lem:missing].\n');
  const unresolved = await invoke(args);
  assert.equal(unresolved.code, 1);
  assert.equal(unresolved.result.stage, 'conversion');
  assert.ok(unresolved.result.diagnostics.some(item => item.code === 'UNRESOLVED_REFERENCE'));
  await fs.writeFile(input, '# Draft\n\n\\undefinedworkshopcommand\n');
  const failed = await invoke(args);
  assert.equal(failed.code, 1);
  assert.equal(failed.result.stage, 'compilation');
  assert.ok(failed.result.diagnostics.some(item => item.code === 'LATEX_ERROR' && /Undefined control sequence/.test(item.message) && item.texLine > 0));
  assert.deepEqual(await fs.readFile(good.result.artifacts.pdf), preserved);
  assert.equal(JSON.parse(await fs.readFile(good.result.artifacts.lastSuccess, 'utf8')).attemptId, good.result.attemptId);
  assert.equal(JSON.parse(await fs.readFile(good.result.artifacts.latestAttempt, 'utf8')).attemptId, failed.result.attemptId);
});

test('status exposes completed attempts through a read-only CLI command', async () => {
  const dir = await scratch();
  const input = path.join(dir, 'draft.md');
  const output = path.join(dir, 'output');
  const idle = await invoke(['status', input, '--out-dir', output]);
  assert.equal(idle.code, 0);
  assert.equal(idle.result.busy, false);
  assert.equal(idle.result.lastSuccess, null);
  assert.deepEqual(await fs.readdir(dir), []);
  await fs.writeFile(input, '# Draft\n\nThe first complete version.\n');
  const built = await invoke(['build', input, '--out-dir', output]);
  assert.equal(built.code, 0, JSON.stringify(built.result));
  const status = await invoke(['status', input, '--out-dir', output]);
  assert.equal(status.result.lastSuccess.attemptId, built.result.attemptId);
  assert.equal(status.result.latestAttempt.status, 'success');
  assert.equal(status.result.busy, false);
});

test('concurrent builds are refused and a timed-out converter releases the document', async () => {
  const dir = await scratch();
  const input = path.join(dir, 'draft.md');
  const output = path.join(dir, 'output');
  const converter = path.join(dir, 'slow.py');
  await fs.writeFile(input, '# Draft\n\nA complete sentence.\n');
  await fs.writeFile(converter, '"""Deliberate timeout fixture. Usage: python3 slow.py (terminated by test)."""\nimport time\ntime.sleep(20)\n');
  const pending = invoke(['build', input, '--out-dir', output, '--converter', converter, '--timeout-ms', '2500']);
  let busy = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await invoke(['status', input, '--out-dir', output]);
    if (current.result.busy) { busy = true; break; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  const competing = busy ? await invoke(['build', input, '--out-dir', output]) : null;
  const stopped = await pending;
  assert.equal(busy, true, 'status must expose an active build');
  assert.equal(competing.code, 1);
  assert.ok(competing.result.diagnostics.some(item => item.code === 'BUILD_BUSY'));
  assert.equal(stopped.code, 1);
  assert.ok(stopped.result.diagnostics.some(item => item.code === 'PROCESS_TIMEOUT'));
  const released = await invoke(['status', input, '--out-dir', output]);
  assert.equal(released.result.busy, false);
  assert.equal(released.result.lastSuccess, null);
  const recovered = await invoke(['build', input, '--out-dir', output]);
  assert.equal(recovered.code, 0, JSON.stringify(recovered.result));
});

test('declared bibliography files are staged and citations resolve in an isolated build', async () => {
  const dir = await scratch();
  const input = path.join(dir, 'draft.md');
  const bib = path.join(dir, 'references.bib');
  await fs.writeFile(input, '---\ntex-workshop-bibs:\n  - references.bib\n---\n# Sources\n\nSee [cite{sample}].\n');
  await fs.writeFile(bib, '@book{sample, author={Sample, Ada}, title={An Example Book}, publisher={Example Press}, year={2026}}\n');
  const built = await invoke(['build', input, '--vault-root', dir, '--out-dir', path.join(dir, 'output')]);
  assert.equal(built.code, 0, JSON.stringify(built.result));
  assert.ok(built.result.dependencies.some(item => item.kind === 'bibliography' && item.source === bib));
  assert.match(await fs.readFile(path.join(built.result.artifacts.attempt, 'main.bbl'), 'utf8'), /Example Book/);
  const preamble = path.join(dir, 'article.tex');
  await fs.writeFile(preamble, '\\documentclass{article}\n');
  const unsupported = await invoke(['build', input, '--vault-root', dir, '--converter', path.join(projectRoot, 'testing/fixtures/cli/external-converter.py'), '--preamble', preamble, '--out-dir', path.join(dir, 'output')]);
  assert.equal(unsupported.code, 1);
  assert.ok(unsupported.result.diagnostics.some(item => item.code === 'BIBLIOGRAPHY_MODE_REQUIRED'));
});

test('the explicit legacy adapter retains source-line guards before compilation', async () => {
  const dir = await scratch();
  const input = path.join(dir, 'draft.md');
  for (const [text, expected] of [
    ['[printbibliography]', 'STRUCTURAL_REQUIRED'],
    ['We measured 50% of the sample.', 'UNESCAPED_TEX_CHARACTER'],
    ['Compare [[Related note]] for details.', 'UNSUPPORTED_WIKILINK'],
    ['![A figure](figure.png)', 'UNSUPPORTED_IMAGE'],
  ]) {
    await fs.writeFile(input, `---\ntitle: Demo\n---\n# Draft\n\n${text}\n`);
    const failed = await invoke(['build', input, '--converter', path.join(projectRoot, 'testing/fixtures/cli/external-converter.py'), '--out-dir', path.join(dir, 'output')]);
    assert.equal(failed.code, 1, text);
    assert.equal(failed.result.stage, 'preflight');
    assert.ok(failed.result.diagnostics.some(item => item.code === expected && item.path === input && item.line === 6));
    await assert.rejects(fs.access(failed.result.artifacts.compilationLog));
  }
});

test('compatibility guards still allow established mathematical authoring syntax', async () => {
  const dir = await scratch();
  const input = path.join(projectRoot, 'testing/fixtures/cli/technical.md');
  const built = await invoke(['build', input, '--out-dir', path.join(dir, 'output')]);
  assert.equal(built.code, 0, JSON.stringify(built.result));
  const log = await fs.readFile(built.result.artifacts.log, 'utf8');
  assert.doesNotMatch(log, /undefined references|multiply defined/);
  assert.match(await fs.readFile(built.result.artifacts.body, 'utf8'), /\\label\{lem:identity\}/);
});

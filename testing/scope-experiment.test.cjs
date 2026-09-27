const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('./execute.cjs');
const { prepare } = require('../scripts/scope-experiment.cjs');
const root = path.resolve(__dirname, '..');

async function fixture() {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const vault = await fs.mkdtemp(path.join(root, 'tmp/scope-experiment-'));
  const scope = path.join(vault, 'paper');
  await fs.mkdir(path.join(scope, 'sections'), { recursive: true });
  await fs.mkdir(path.join(scope, 'figures'));
  const input = path.join(vault, 'note.md');
  const target = path.join(scope, 'paper.tex');
  return { vault, scope, input, target, out: path.join(vault, 'out') };
}

async function run(f, extra = []) {
  const run = await execute(process.execPath, [path.join(root, 'scripts/scope-experiment.cjs'), f.input,
    '--vault-root', f.vault, '--project-root', f.scope, '--linked-tex', f.target, '--out-dir', f.out, ...extra], { cwd: root }).catch(error => error);
  return { exitCode: run.exitCode, result: JSON.parse(run.stdout) };
}

test('path-qualified TeX and graphic embeds compile through the existing builder, source remains untouched', async () => {
  const f = await fixture();
  const original = '# Document\n\n![[sections/method.tex]]\n';
  await fs.writeFile(f.input, original);
  await fs.writeFile(path.join(f.scope, 'sections/method.tex'), 'A scoped chapter appears here.\n');
  const first = await run(f);
  assert.equal(first.result.status, 'success', JSON.stringify(first.result.diagnostics || first.result.build?.diagnostics));
  assert.match(await fs.readFile(first.result.build.artifacts.body, 'utf8'), /\\input\{method\.tex\}/);
  assert.equal(await fs.readFile(f.input, 'utf8'), original);
  assert.equal(await fs.stat(f.target).catch(() => null), null, 'the experiment must not publish the linked target');
  const { stdout: extracted } = await execute('pdftotext', [first.result.build.artifacts.pdf, '-']);
  assert.match(extracted, /A scoped chapter appears here/);

  const figure = path.join(f.scope, 'figures/example.pdf');
  await fs.copyFile(first.result.build.artifacts.pdf, figure);
  await fs.writeFile(f.input, '# Figure\n\n![[figures/example.pdf]]\n');
  const preamble = path.join(f.scope, 'graphicx.tex');
  await fs.writeFile(preamble, '\\documentclass{article}\n\\usepackage{graphicx}\n');
  const second = await run(f, ['--preamble', preamble]);
  assert.equal(second.result.status, 'success', JSON.stringify(second.result.diagnostics || second.result.build?.diagnostics));
  assert.match(await fs.readFile(second.result.build.artifacts.body, 'utf8'), /\\includegraphics\{example\.pdf\}/);
  assert.ok((await fs.stat(second.result.build.artifacts.pdf)).size > 0);
});

test('out-of-scope targets, traversal, symlinks and ambiguous stage names are refused before build', async () => {
  const f = await fixture();
  await fs.writeFile(f.input, '![[sections/method.tex]]\n');
  await fs.writeFile(path.join(f.scope, 'sections/method.tex'), 'In scope.\n');
  const invalidTarget = await run({ ...f, target: path.join(f.vault, 'other.tex') });
  assert.equal(invalidTarget.result.diagnostics[0].code, 'TARGET_OUTSIDE_SCOPE');
  await fs.writeFile(f.input, '![[../private.tex]]\n');
  assert.equal((await run(f)).result.diagnostics[0].code, 'UNSUPPORTED_EMBED');
  await fs.symlink(path.join(f.vault, 'private.tex'), path.join(f.scope, 'sections/escape.tex'));
  await fs.writeFile(path.join(f.vault, 'private.tex'), 'Private.\n');
  await fs.writeFile(f.input, '![[sections/escape.tex]]\n');
  assert.equal((await run(f)).result.diagnostics[0].code, 'RESOURCE_OUTSIDE_SCOPE');
  await fs.writeFile(path.join(f.scope, 'figures/method.tex'), 'Same basename.\n');
  await fs.writeFile(f.input, '![[sections/method.tex]]\n\n![[figures/method.tex]]\n');
  assert.equal((await run(f)).result.diagnostics[0].code, 'RESOURCE_NAME_COLLISION');
  assert.equal(await fs.stat(f.out).catch(() => null), null, 'refusals must precede build output');
});

test('unresolved and non-standalone embeds remain explicit errors', async () => {
  const f = await fixture();
  await fs.writeFile(f.input, '![[sections/missing.tex]]\n');
  assert.equal((await run(f)).result.diagnostics[0].code, 'RESOURCE_MISSING');
  await fs.writeFile(f.input, 'See ![[sections/method.tex]] here.\n');
  assert.equal((await run(f)).result.diagnostics[0].code, 'UNSUPPORTED_EMBED');
  await fs.writeFile(f.input, '![[sections/method.tex|alias]]\n');
  assert.equal((await run(f)).result.diagnostics[0].code, 'UNSUPPORTED_EMBED');
});

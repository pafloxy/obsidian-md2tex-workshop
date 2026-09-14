/**
 * Check metadata resolution from unrelated directories and explicit host roots.
 * Usage from root: node --test --test-isolation=none testing/portability.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('./execute.cjs');
const cli = path.resolve(__dirname, '../scripts/workshop.cjs');

test('old Node gets a structured setup failure before the core loads', async () => {
  const vm = require('node:vm');
  const output = [];
  const stopped = new Error('intentional exit');
  const context = { console: { log(value) { output.push(JSON.parse(value)); } },
    process: { versions: { node: '12.22.9' }, exit(code) { assert.equal(code, 1); throw stopped; } },
    require() { assert.fail('Core must not load under the unsupported runtime'); } };
  assert.throws(() => vm.runInNewContext(require('node:fs').readFileSync(cli, 'utf8'), context), error => error === stopped);
  assert.equal(output[0].diagnostics[0].code, 'UNSUPPORTED_NODE');
});

test('default metadata root follows invocation directory; explicit vault root wins', async () => {
  const scratch = path.resolve(__dirname, '../tmp'); await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, 'portable working directory-'));
  const vault = path.join(dir, 'vault'); await fs.mkdir(vault);
  await fs.writeFile(path.join(dir, 'article.tex'), '\\documentclass{article}\n');
  await fs.writeFile(path.join(vault, 'article.tex'), '\\documentclass[11pt]{article}\n');
  const input = path.join(dir, 'draft.md');
  await fs.writeFile(input, '---\ntex-workshop-preamble: article.tex\n---\n# Local paths\n\nA portable sentence.\n');
  for (const [extra, expected] of [[[], dir], [['--vault-root', vault], vault]]) {
    const run = await execute(process.execPath, [cli, 'build', input, '--out-dir', path.join(dir, 'builds'), ...extra], { cwd: dir });
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'success');
    assert.equal(result.profile.preamblePath, path.join(expected, 'article.tex'));
    assert.equal((await fs.readFile(result.artifacts.pdf)).subarray(0, 5).toString(), '%PDF-');
  }
});

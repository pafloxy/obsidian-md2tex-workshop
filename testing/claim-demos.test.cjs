/**
 * Compile the four README claim demos through the real public CLI.
 * Usage, repository root: node --test --test-isolation=none testing/claim-demos.test.cjs
 * Requires the documented TeX and BibTeX tools; evidence stays under tmp/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('./execute.cjs');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts/workshop.cjs');
const demos = [
  '01-readable-academic-markdown.md',
  '02-local-tex-pdf.md',
  '03-note-owned-recipe.md',
  '04-guarded-round-trip.md',
  '05-label-shortcut.md',
];

test('the five advertised Markdown claims produce clean real PDFs', async () => {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const output = await fs.mkdtemp(path.join(root, 'tmp/claim-demos-test-'));
  for (const name of demos) {
    const input = path.join(root, 'examples/claims', name);
    const args = [cli, 'build', input, '--vault-root', root, '--out-dir', output];
    const run = await execute(process.execPath, args, { cwd: root });
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'success', `${name}: ${run.stdout}`);
    assert.deepEqual(result.diagnostics, [], name);
    assert.equal((await fs.readFile(result.artifacts.pdf)).subarray(0, 5).toString(), '%PDF-', name);
    assert.doesNotMatch(await fs.readFile(result.artifacts.log, 'utf8'), /undefined references|multiply defined/i, name);
  }
});

/**
 * Compile note-owned recipes and exercise frozen recovery through real CLI/target paths.
 * Usage, repository root: node --test --test-isolation=none testing/recipe-integration.test.cjs
 * Requires the documented TeX tools; synthetic evidence is retained in tmp/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('./execute.cjs');
const { build } = require('../src/core/workshop.cjs');
const { checkout, sync } = require('../src/core/roundtrip.cjs');
const { setTarget, buildLinked, previewTarget, applyTarget } = require('../src/core/targets.cjs');
const root = path.resolve(__dirname, '..');

/** Create portable YAML paths and an explicitly positioned bibliography. */
async function fixture(mode = 'bibtex') {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/recipe-integration-'));
  const preamble = '\\documentclass{article}\n' + (mode === 'biblatex' ? '\\usepackage[backend=biber]{biblatex}\n' : '');
  const bib = '@book{sample, author={Example, Ada}, title={Frozen bibliography title}, publisher={Sample Press}, year={2026}}\n';
  const source = `---\ntitle: Original title\ntex-workshop-preamble: article.tex\ntex-workshop-bibs:\n  - references.bib\ntex-workshop-bibliography: ${mode}\ntex-workshop-engine: pdflatex\n---\n\n# Sources\n\nBefore bibliography [cite{sample}].\n\n[printbibliography]\n\nAfter bibliography.\n`;
  await fs.writeFile(path.join(dir, 'article.tex'), preamble);
  await fs.writeFile(path.join(dir, 'references.bib'), bib);
  const input = path.join(dir, 'note.md');
  await fs.writeFile(input, source);
  return { dir, input, source, preamble, bib, vaultRoot: dir, outDir: path.join(dir, 'output'), timeoutMs: 60000 };
}

/** Require successful compilation and return the actual PDF text. */
async function pdfText(result) {
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.deepEqual(result.diagnostics, []);
  return (await execute('pdftotext', ['-layout', result.artifacts.pdf, '-'])).stdout;
}

test('the real CLI uses YAML before controls and prints one bibliography at the requested position', async () => {
  const value = await fixture();
  const run = await execute(process.execPath, [path.join(root, 'scripts/workshop.cjs'), 'build', value.input, '--vault-root', value.dir, '--out-dir', value.outDir, '--preamble', path.join(value.dir, 'missing.tex'), '--engine', 'xelatex', '--bibliography', 'none', '--no-bib'], { cwd: value.dir });
  const result = JSON.parse(run.stdout);
  const text = await pdfText(result);
  assert.ok(text.indexOf('Before bibliography') < text.indexOf('Frozen bibliography title'));
  assert.ok(text.indexOf('Frozen bibliography title') < text.indexOf('After bibliography'));
  assert.equal((text.match(/Frozen bibliography title/g) || []).length, 1);
  assert.equal(result.bibliographyPlacement, 'explicit');
  assert.deepEqual(new Set(Object.values(result.profile.origins)), new Set(['yaml']));
  const sourceMap = JSON.parse(await fs.readFile(result.artifacts.sourceMap, 'utf8'));
  const texLines = (await fs.readFile(result.artifacts.tex, 'utf8')).split('\n');
  const mapping = sourceMap.lines.find(item => texLines[item.texLine - 1] === '\\printbibliography');
  assert.equal(mapping.line, value.source.split('\n').indexOf('[printbibliography]') + 1);
  await fs.writeFile(value.input, value.source.replace('[printbibliography]\n\n', ''));
  const automatic = await build(value);
  const tail = await pdfText(automatic);
  assert.equal(automatic.bibliographyPlacement, 'automatic');
  assert.ok(tail.indexOf('After bibliography') < tail.indexOf('Frozen bibliography title'));
});

test('biblatex compiles and replays its YAML recipe through a frozen checkpoint', { skip: process.env.WORKSHOP_TEST_BIBLATEX !== '1' && 'Optional backend: set WORKSHOP_TEST_BIBLATEX=1 with Biber and biblatex available' }, async () => {
  const value = await fixture('biblatex');
  const checked = await checkout(value);
  assert.equal(checked.status, 'success', JSON.stringify(checked));
  const text = await pdfText(checked.build);
  assert.match(text, /Frozen bibliography title/);
  const original = await fs.readFile(checked.artifacts.tex, 'utf8');
  await fs.writeFile(checked.artifacts.tex, original.replace('Before bibliography', 'Revised before bibliography'));
  const preview = await sync({ input: checked.artifacts.session, timeoutMs: 60000 });
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  await pdfText(preview.build);
  assert.equal(await fs.readFile(preview.artifacts.candidate, 'utf8'), value.source.replace('Before bibliography', 'Revised before bibliography'));
});

test('linked recovery moves explicit printing and freezes changed live YAML dependencies', async () => {
  const value = await fixture();
  value.source = '\uFEFF' + value.source.replace(/\n/g, '\r\n').trimEnd();
  await fs.writeFile(value.input, value.source);
  value.target = path.join(value.dir, 'paper.tex');
  await setTarget(value);
  const first = await buildLinked(value);
  assert.equal(first.target?.status, 'success', JSON.stringify(first));
  const originalTex = await fs.readFile(value.target, 'utf8');
  const edited = originalTex.replace(/^\\printbibliography\n\n/m, '').replace('After bibliography.\n\n', 'After bibliography.\n\n\\printbibliography\n\n');
  assert.notEqual(edited, originalTex);
  await fs.writeFile(value.target, edited);
  // Saved title edits survive; recipe metadata stays unchanged.
  const current = value.source.replace('Original title', 'Author title');
  await fs.writeFile(value.input, current);
  await fs.writeFile(path.join(value.dir, 'article.tex'), '\\documentclass{missing-live-class}\n');
  await fs.writeFile(path.join(value.dir, 'references.bib'), value.bib.replace('Frozen bibliography title', 'Changed live title'));
  const preview = await previewTarget(value);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  const text = await pdfText(preview.build);
  assert.match(text, /Frozen bibliography title/);
  assert.doesNotMatch(text, /Changed live title/);
  assert.ok(text.indexOf('After bibliography') < text.indexOf('Frozen bibliography title'));
  assert.deepEqual(new Set(Object.values(preview.build.profile.origins)), new Set(['checkpoint']));
  const candidate = await fs.readFile(preview.artifacts.candidate, 'utf8');
  assert.ok(candidate.startsWith(current.slice(0, current.indexOf('# Sources'))));
  assert.equal(candidate.match(/\[printbibliography\]/g).length, 1);
  assert.ok(candidate.indexOf('After bibliography.') < candidate.indexOf('[printbibliography]'));
  assert.equal(await fs.readFile(value.input, 'utf8'), current);
  assert.equal(await fs.readFile(value.target, 'utf8'), edited);
  const applied = await applyTarget({ ...value, preview: preview.artifacts.report });
  assert.equal(applied.status, 'success', JSON.stringify(applied));
  assert.equal(await fs.readFile(applied.artifacts.backup, 'utf8'), current);
  assert.equal(await fs.readFile(value.input, 'utf8'), candidate);
  await fs.writeFile(path.join(value.dir, 'article.tex'), value.preamble);
  await fs.writeFile(path.join(value.dir, 'references.bib'), value.bib);
  const resumed = await buildLinked(value);
  assert.equal(resumed.target?.status, 'success', JSON.stringify(resumed));
  assert.equal(resumed.target.target, value.target);
  const fresh = await previewTarget(value);
  assert.equal(fresh.status, 'success', JSON.stringify(fresh));
  assert.equal(await fs.readFile(fresh.artifacts.candidate, 'utf8'), candidate);
  await fs.writeFile(path.join(value.dir, 'validation.json'), JSON.stringify({ first, preview, applied, resumed, fresh }, null, 2) + '\n');
});

test('recipe changes and loss of explicit placement require a fresh checkpoint', async () => {
  const value = await fixture();
  const checked = await checkout(value);
  assert.equal(checked.status, 'success', JSON.stringify(checked));
  await fs.writeFile(value.input, value.source.replace('pdflatex', 'xelatex'));
  const changed = await sync({ input: checked.artifacts.session });
  assert.ok(changed.diagnostics.some(item => item.code === 'RECIPE_CHANGED'), JSON.stringify(changed));
  await fs.writeFile(value.input, value.source);
  const tex = await fs.readFile(checked.artifacts.tex, 'utf8');
  await fs.writeFile(checked.artifacts.tex, tex.replace(/^\\printbibliography\n\n/m, ''));
  const removed = await sync({ input: checked.artifacts.session });
  assert.ok(removed.diagnostics.some(item => item.code === 'ROUNDTRIP_MISMATCH'), JSON.stringify(removed));
  assert.equal(await fs.readFile(value.input, 'utf8'), value.source);
});

test('missing resources and incompatible bibliography backends fail before compilation', async () => {
  const value = await fixture();
  for (const [source, expected] of [
    [value.source.replace('tex-workshop-bibs:\n  - references.bib', 'tex-workshop-bibs: []'), 'BIBLIOGRAPHY_RESOURCES_REQUIRED'],
    [value.source.replace('references.bib', 'missing.bib'), 'MISSING_DEPENDENCY'],
    [value.source.replace('tex-workshop-bibliography: bibtex', 'tex-workshop-bibliography: biblatex'), 'BIBLATEX_PACKAGE_REQUIRED'],
    [value.source.replace('[printbibliography]', '```{=latex}\n\\printbibliography\n```'), 'BIBLIOGRAPHY_OWNERSHIP'],
  ]) {
    const result = await build({ ...value, sourceText: source });
    assert.ok(result.diagnostics.some(item => item.code === expected), JSON.stringify(result));
    if (result.artifacts.compilationLog) await assert.rejects(fs.access(result.artifacts.compilationLog));
  }
});

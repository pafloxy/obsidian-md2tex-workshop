/**
 * Verify note-owned settings and bibliography syntax without a TeX subprocess.
 * Usage, repository root: node --test --test-isolation=none testing/recipe.test.cjs
 * Files are synthetic and retained under tmp/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseSnapshot } = require('../src/core/snapshot.cjs');
const { resolveConfiguration } = require('../src/core/config.cjs');
const { convertMarkdown } = require('../src/core/markdown.cjs');
const { render, recover } = require('../src/core/reverse.cjs');
const { bibliography } = require('../src/core/bibliography.cjs');
const root = path.resolve(__dirname, '..');

/** Create two distinct control/YAML resources so precedence failures are observable. */
async function fixture() {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/recipe-test-'));
  await fs.writeFile(path.join(dir, 'note.tex'), '\\documentclass{article}\n');
  await fs.writeFile(path.join(dir, 'controls.tex'), '\\documentclass[11pt]{article}\n');
  await fs.writeFile(path.join(dir, 'note.bib'), '@book{note, title={Note}}\n');
  await fs.writeFile(path.join(dir, 'controls.bib'), '@book{controls, title={Controls}}\n');
  return dir;
}

/** Convert one synthetic note into source-positioned nodes and TeX. */
function convert(source) { return convertMarkdown(parseSnapshot(source), 'draft.md'); }

test('YAML wins for all document settings and ignores unavailable fallback files', async () => {
  const dir = await fixture();
  const metadata = parseSnapshot('---\ntex-workshop-preamble: note.tex\ntex-workshop-bibs: ["note.bib"]\ntex-workshop-engine: xelatex\ntex-workshop-bibliography: bibtex\n---\nText.').metadata;
  const config = await resolveConfiguration({ vaultRoot: dir, preamble: path.join(dir, 'missing.tex'), bib: [path.join(dir, 'missing.bib')], engine: 'pdflatex', bibliography: 'none' }, metadata);
  assert.equal(config.preamblePath, path.join(dir, 'note.tex'));
  assert.equal(config.dependencies[0].source, path.join(dir, 'note.bib'));
  assert.equal(config.engine, 'xelatex');
  assert.equal(config.bibliographyMode, 'bibtex');
  assert.deepEqual(config.origins, { preamble: 'yaml', engine: 'yaml', bibs: 'yaml', bibliography: 'yaml' });
  const noBib = await resolveConfiguration({ vaultRoot: dir, noBib: true }, metadata);
  assert.equal(noBib.dependencies.length, 1);
  const empty = await resolveConfiguration({ vaultRoot: dir, bib: [path.join(dir, 'missing.bib')] }, { 'tex-workshop-bibs': [] });
  assert.equal(empty.dependencies.length, 0);
  assert.equal(empty.origins.bibs, 'yaml');
});

test('absent YAML inherits controls; the default is basic article with no EPTCS support', async () => {
  const dir = await fixture();
  const controlled = await resolveConfiguration({ preamble: path.join(dir, 'controls.tex'), bibliography: 'bibtex', bib: [path.join(dir, 'controls.bib')], engine: 'lualatex' });
  assert.equal(controlled.dependencies[0].source, path.join(dir, 'controls.bib'));
  assert.deepEqual(new Set(Object.values(controlled.origins)), new Set(['controls']));
  const basic = await resolveConfiguration({});
  assert.equal(basic.profile, 'basic-article');
  assert.match(basic.preamble, /\\documentclass\{article\}/);
  assert.equal(basic.dependencies.length, 0);
  assert.equal(basic.bibliographyMode, 'bibtex');
  assert.deepEqual(new Set(Object.values(basic.origins)), new Set(['default']));
  const legacy = await resolveConfiguration({ preamble: path.join(root, 'assets/preambles/default-preamble.tex') });
  assert.equal(legacy.profile, 'legacy-eptcs');
  assert.ok(legacy.dependencies.some(item => item.name === 'eptcs.cls'));
});

test('metadata paths are vault-relative and controls are working-directory-relative', async () => {
  const dir = await fixture();
  const controlled = await resolveConfiguration({ vaultRoot: path.join(dir, 'unrelated'), preamble: path.relative(process.cwd(), path.join(dir, 'controls.tex')) });
  assert.equal(controlled.preamblePath, path.join(dir, 'controls.tex'));
  const yaml = await resolveConfiguration({ vaultRoot: dir }, { 'tex-workshop-preamble': 'note.tex' });
  assert.equal(yaml.preamblePath, path.join(dir, 'note.tex'));
});

test('malformed present metadata never silently inherits a fallback', async () => {
  for (const field of ['tex-workshop-preamble: ""', 'tex-workshop-engine:', 'tex-workshop-bibliography: ""', 'tex-workshop-bibs:', 'tex-workshop-bibs: [""]', 'tex-workshop-bibs:\n  broken: mapping', 'tex-workshop-preamble: |\n  \\documentclass{article}']) {
    assert.throws(() => parseSnapshot(`---\n${field}\n---\nText`), { code: 'INVALID_FRONTMATTER' }, field);
  }
  await assert.rejects(resolveConfiguration({ engine: 'pdflatex' }, { 'tex-workshop-engine': 'unknown' }), { code: 'INVALID_ENGINE' });
  await assert.rejects(resolveConfiguration({ bibliography: 'bibtex' }, { 'tex-workshop-bibliography': 'unknown' }), { code: 'INVALID_BIBLIOGRAPHY_MODE' });
  const dir = await fixture();
  await assert.rejects(resolveConfiguration({ vaultRoot: dir, preamble: path.join(dir, 'controls.tex') }, { 'tex-workshop-preamble': 'missing.tex' }), { code: 'MISSING_PREAMBLE' });
});

test('bibliography lists retain entries across blank lines and comments', () => {
  const snapshot = parseSnapshot('---\ntex-workshop-bibs:\n  - "one.bib"\n\n  # retained ordering\n  - \'two.bib\'\ntitle: Unrelated\n---\nText');
  assert.deepEqual(snapshot.metadata['tex-workshop-bibs'], ['one.bib', 'two.bib']);
  assert.equal(snapshot.body, 'Text');
});

test('explicit bibliography is a source-mapped block, including adjacent prose', () => {
  const converted = convert('---\ntitle: Source locations\n---\nBefore.\n[printbibliography]\nAfter.\n');
  assert.deepEqual(converted.diagnostics, []);
  assert.equal(converted.document.children[1].type, 'bibliography');
  const mapped = converted.lines.find(item => converted.tex.split('\n')[item.bodyLine - 1] === '\\printbibliography');
  assert.equal(mapped.line, 5);
  assert.equal(converted.segments.map(item => item.tex).join(''), converted.tex + '\n');
});

test('duplicate, nested, inline, mathematical and link-like print commands are rejected', () => {
  for (const [source, code] of [
    ['[printbibliography]\n\n[printbibliography]', 'DUPLICATE_BIBLIOGRAPHY'],
    ['> [!note]\n> [printbibliography]', 'BIBLIOGRAPHY_PLACEMENT'],
    ['- [printbibliography]', 'BIBLIOGRAPHY_PLACEMENT'],
    ['Before [printbibliography] after.', 'BIBLIOGRAPHY_PLACEMENT'],
    ['[printbibliography](https://example.org)', 'BIBLIOGRAPHY_PLACEMENT'],
    ['[printbibliography]: https://example.org', 'BIBLIOGRAPHY_PLACEMENT'],
    ['$[printbibliography]$', 'DIRECTIVE_IN_MATH'],
    ['[printbibliography{}]', 'UNKNOWN_DIRECTIVE'],
  ]) assert.ok(convert(source).diagnostics.some(item => item.code === code), source);
});

test('code, comments and raw islands preserve command-looking Markdown literally', () => {
  const source = '`[printbibliography]`\n\n```md\n[printbibliography]\n```\n\n<!-- [printbibliography] -->\n\n%% [printbibliography] %%\n\n```{=latex}\n[printbibliography]\n```\n';
  const converted = convert(source);
  assert.deepEqual(converted.diagnostics, []);
  assert.equal(converted.document.children.filter(node => node.type === 'bibliography').length, 0);
  assert.equal(recover(source, render(source), render(source)).markdown, source);
});

test('print placement has an exact structural inverse when inserted or moved', () => {
  const source = 'Before.\n\n[printbibliography]\n\nAfter.\n';
  const before = render(source);
  assert.equal(recover(source, before, before).markdown, source);
  const after = render('Before.\n\nAfter.\n\n[printbibliography]\n');
  const moved = recover(source, before, after);
  assert.equal(moved.method, 'structural-inverse');
  assert.equal(render(moved.markdown), after);
  assert.ok(moved.markdown.trimEnd().endsWith('[printbibliography]'));
  assert.equal(recover('', '', '\\printbibliography\n\n').markdown, '[printbibliography]\n\n');
});

test('one body command supports both backends and automatic placement stays available', () => {
  const converted = convert('Before.\n\n[printbibliography]\n\nAfter.\n');
  const config = { dependencies: [{ kind: 'bibliography', name: 'bibliography-01.bib' }], visiblePreamble: '' };
  for (const mode of ['bibtex', 'biblatex']) {
    const explicit = bibliography({ ...config, bibliographyMode: mode }, converted.tex, converted.document);
    assert.equal(explicit.placement, 'explicit');
    assert.equal(explicit.tail, '');
    assert.match(explicit.head, mode === 'bibtex' ? /\\newcommand\{\\printbibliography\}\{\\bibliography\{bibliography-01\}\}/ : /\\addbibresource\{bibliography-01.bib\}/);
    assert.equal(bibliography({ ...config, bibliographyMode: mode }, 'Text.', convert('Text.').document).tail, '\\printbibliography');
  }
  assert.throws(() => bibliography({ dependencies: [], bibliographyMode: 'none' }, converted.tex, converted.document), { code: 'BIBLIOGRAPHY_RESOURCES_REQUIRED' });
});

test('raw bibliography commands cannot produce duplicates; verbatim examples remain literal', () => {
  const config = { dependencies: [], bibliographyMode: 'none' };
  for (const command of ['\\printbibliography', '\\bibliography{other}', '\\addbibresource{other.bib}']) {
    const converted = convert('```{=latex}\n' + command + '\n```');
    assert.throws(() => bibliography(config, converted.tex, converted.document), { code: 'BIBLIOGRAPHY_OWNERSHIP' });
  }
  const literal = convert('```tex\n\\printbibliography\n\\bibliography{example}\n```\n\n\\verb|\\printbibliography|\n\n```{=latex}\n% \\printbibliography\n```');
  assert.equal(bibliography(config, literal.tex, literal.document).placement, 'none');
});

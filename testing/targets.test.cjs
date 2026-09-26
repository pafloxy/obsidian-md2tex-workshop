/**
 * Verify one evolving named TeX and its existing guarded reverse pipeline.
 * Usage from root: node --test --test-isolation=none testing/targets.test.cjs
 * All sources and output live under project tmp/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTarget, targetStatus, unlinkTarget, buildLinked, previewTarget, prepareTargetApply, finalizeTargetApply, applyTarget } = require('../src/core/targets.cjs');
const { execute } = require('./execute.cjs');
const root = path.resolve(__dirname, '..');

/** Create a real source with independent blocks for three-way reconciliation. */
async function fixture() {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'tmp/linked tex-'));
  const input = path.join(directory, 'draft.md');
  const target = path.join(directory, 'paper.tex');
  const source = '# Linked draft\n\n> [!lemma] A square\n> <!-- [label{lem:square}] -->\n>\n> The value $x^2$ is nonnegative.\n\nThe first paragraph is editable.\n\nThe control paragraph stays intact.\n\nSee [ref{lem:square}].\n';
  await fs.writeFile(input, source);
  return { directory, input, target, source, outDir: path.join(directory, 'output'), vaultRoot: directory };
}

test('a fixed TeX path evolves with backups and completes TeX to Markdown to TeX again', async () => {
  const value = await fixture();
  const linked = await setTarget(value);
  assert.equal(linked.published, false);
  assert.equal(await fs.readFile(value.input, 'utf8'), value.source);
  const first = await buildLinked(value);
  assert.equal(first.target?.status, 'success', JSON.stringify(first));
  const firstTex = await fs.readFile(value.target, 'utf8');
  assert.match(firstTex, /% md2tex:/);
  assert.equal(first.target.generation, 1);
  await fs.writeFile(value.input, value.source.replace('The first paragraph is editable.', 'The first paragraph was edited in Markdown.'));
  const second = await buildLinked(value);
  assert.equal(second.target.target, value.target);
  assert.equal(second.target.generation, 2);
  assert.equal(await fs.readFile(second.target.backup, 'utf8'), firstTex);
  const secondTex = await fs.readFile(value.target, 'utf8');
  assert.match(secondTex, /edited in Markdown/);
  const edited = secondTex.replace('The first paragraph was edited in Markdown.', 'The first paragraph was improved in TeX.');
  await fs.writeFile(value.target, edited);
  assert.equal((await targetStatus(value)).externallyEdited, true);
  const blocked = await buildLinked(value);
  assert.equal(blocked.status, 'success', 'PDF build is independent of target publication');
  assert.equal(blocked.target.code, 'TARGET_EDITED');
  assert.equal(await fs.readFile(value.target, 'utf8'), edited);
  const preview = await previewTarget(value);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  assert.equal(preview.texPath, value.target);
  assert.match(await fs.readFile(preview.artifacts.candidate, 'utf8'), /improved in TeX/);
  assert.doesNotMatch(await fs.readFile(value.input, 'utf8'), /improved in TeX/);
  const applied = await applyTarget({ ...value, preview: preview.artifacts.report });
  assert.equal(applied.status, 'success', JSON.stringify(applied));
  assert.equal((await targetStatus(value)).externallyEdited, false);
  assert.match(await fs.readFile(value.input, 'utf8'), /improved in TeX/);
  await fs.appendFile(value.input, '\nContinued in Markdown after the round trip.\n');
  const continued = await buildLinked(value);
  assert.equal(continued.target.status, 'success', JSON.stringify(continued));
  const finalTex = await fs.readFile(value.target, 'utf8');
  assert.match(finalTex, /improved in TeX/);
  assert.match(finalTex, /Continued in Markdown/);
  assert.match(finalTex, /The control paragraph stays intact/);
  const compiled = await execute('latexmk', ['-norc', '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', 'paper.tex'], { cwd: value.directory });
  assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr);
  await fs.writeFile(path.join(value.directory, 'validation.json'), JSON.stringify({ first, second, blocked, preview, applied, continued }, null, 2) + '\n');
});

test('a linked target promotes a complex TeX replacement into a durable TeX-owned slot', async () => {
  const value = await fixture();
  await setTarget(value);
  const first = await buildLinked(value);
  assert.equal(first.target.status, 'success', JSON.stringify(first));
  const table = '\\begin{table}[h]\n\\centering\n\\caption{A TeX-owned table}\n\\begin{tabular}{lr}\nName & Value \\\\\nAlpha & 1 \\\\\n\\end{tabular}\n\\end{table}\n';
  const edited = (await fs.readFile(value.target, 'utf8')).replace('The first paragraph is editable.\n', table);
  await fs.writeFile(value.target, edited);
  const preview = await previewTarget(value);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  const candidate = await fs.readFile(preview.artifacts.candidate, 'utf8');
  assert.match(candidate, /<!-- \[tex-slot\{slot-b\d{4}\}\] -->/);
  assert.doesNotMatch(candidate, /\{=latex\}/);
  const applied = await applyTarget({ ...value, preview: preview.artifacts.report });
  assert.equal(applied.status, 'success', JSON.stringify(applied));
  await fs.appendFile(value.input, '\nMarkdown remains editable beside the slot.\n');
  const rebuilt = await buildLinked(value);
  assert.equal(rebuilt.target.status, 'success', JSON.stringify(rebuilt));
  const finalTex = await fs.readFile(value.target, 'utf8');
  assert.ok(finalTex.includes(table));
  assert.match(finalTex, /Markdown remains editable beside the slot\./);
});

test('a linked target recovers complete align TeX as visible native Markdown math', async () => {
  const value = await fixture();
  await setTarget(value);
  assert.equal((await buildLinked(value)).target.status, 'success');
  const align = '\\begin{align}\na &= b + c \\\\\nd &= e\\label{eq:d}\n\\end{align}\n';
  await fs.writeFile(value.target, (await fs.readFile(value.target, 'utf8')).replace('The first paragraph is editable.\n', align));
  const preview = await previewTarget(value);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  assert.ok(preview.changes.some(change => change.method === 'structural-inverse'), JSON.stringify(preview.changes));
  const candidate = await fs.readFile(preview.artifacts.candidate, 'utf8');
  assert.ok(candidate.includes(`$$\n${align.trimEnd()}\n$$`));
  assert.doesNotMatch(candidate, /tex-slot|\{=latex\}/);
  assert.equal((await applyTarget({ ...value, preview: preview.artifacts.report })).status, 'success');
  const rebuilt = await buildLinked(value);
  assert.equal(rebuilt.target.status, 'success', JSON.stringify(rebuilt));
  assert.equal((await targetStatus(value)).slotCount, 0);
  assert.ok((await fs.readFile(value.target, 'utf8')).includes(align));
});

test('a linked target refuses missing or duplicate TeX-owned pointers before publication', async () => {
  const value = await fixture();
  await setTarget(value);
  assert.equal((await buildLinked(value)).target.status, 'success');
  const table = '\\begin{table}[h]\n\\centering\n\\caption{Safety table}\n\\begin{tabular}{lr}\nName & Value \\\\\nAlpha & 1 \\\\\n\\end{tabular}\n\\end{table}\n';
  await fs.writeFile(value.target, (await fs.readFile(value.target, 'utf8')).replace('The first paragraph is editable.\n', table));
  const preview = await previewTarget(value);
  assert.equal((await applyTarget({ ...value, preview: preview.artifacts.report })).status, 'success');
  const source = await fs.readFile(value.input, 'utf8');
  const targetBeforeRefusal = await fs.readFile(value.target, 'utf8');
  const pointer = source.match(/<!-- \[tex-slot\{slot-b\d{4}\}\] -->/)[0];
  await fs.writeFile(value.input, source.replace(pointer + '\n\n', ''));
  const missing = await buildLinked(value);
  assert.equal(missing.status, 'error', JSON.stringify(missing));
  assert.ok(missing.diagnostics.some(item => item.code === 'TEX_SLOT_MISSING'), JSON.stringify(missing));
  assert.equal(await fs.readFile(value.target, 'utf8'), targetBeforeRefusal);
  await fs.writeFile(value.input, source.replace(pointer, pointer + '\n\n' + pointer));
  const duplicate = await buildLinked(value);
  assert.equal(duplicate.status, 'error', JSON.stringify(duplicate));
  assert.ok(duplicate.diagnostics.some(item => item.code === 'DUPLICATE_TEX_SLOT'), JSON.stringify(duplicate));
  assert.equal(await fs.readFile(value.target, 'utf8'), targetBeforeRefusal);
});

test('a linked target refuses foreign and reordered TeX-owned pointers before publication', async () => {
  const value = await fixture();
  await setTarget(value);
  assert.equal((await buildLinked(value)).target.status, 'success');
  const table = '\\begin{table}[h]\n\\centering\n\\caption{First slot}\n\\begin{tabular}{lr}\nName & Value \\\\\nAlpha & 1 \\\\\n\\end{tabular}\n\\end{table}\n';
  const gather = '\\begin{gather}\na = b + c \\\\\nd = e\n\\end{gather}\n';
  let edited = await fs.readFile(value.target, 'utf8');
  edited = edited.replace('The first paragraph is editable.\n', table).replace('The control paragraph stays intact.\n', gather);
  await fs.writeFile(value.target, edited);
  const preview = await previewTarget(value);
  assert.equal((await applyTarget({ ...value, preview: preview.artifacts.report })).status, 'success');
  const source = await fs.readFile(value.input, 'utf8');
  const targetBeforeRefusal = await fs.readFile(value.target, 'utf8');
  const pointers = [...source.matchAll(/<!-- \[tex-slot\{(slot-b\d{4})\}\] -->/g)].map(match => match[0]);
  assert.equal(pointers.length, 2);
  await fs.writeFile(value.input, source.replace(pointers[0], '<!-- [tex-slot{slot-b9999}] -->'));
  const foreign = await buildLinked(value);
  assert.equal(foreign.status, 'error', JSON.stringify(foreign));
  assert.ok(foreign.diagnostics.some(item => item.code === 'UNKNOWN_TEX_SLOT'), JSON.stringify(foreign));
  assert.equal(await fs.readFile(value.target, 'utf8'), targetBeforeRefusal);
  await fs.writeFile(value.input, source.replace(pointers[0], '__FIRST__').replace(pointers[1], pointers[0]).replace('__FIRST__', pointers[1]));
  const reordered = await buildLinked(value);
  assert.equal(reordered.status, 'error', JSON.stringify(reordered));
  assert.ok(reordered.diagnostics.some(item => item.code === 'TEX_SLOT_REORDERED'), JSON.stringify(reordered));
  assert.equal(await fs.readFile(value.target, 'utf8'), targetBeforeRefusal);
});

test('a host writer can commit one prepared candidate before linked state is finalized', async () => {
  const value = await fixture();
  await setTarget(value);
  const built = await buildLinked(value);
  assert.equal(built.target.status, 'success', JSON.stringify(built));
  const tex = await fs.readFile(value.target, 'utf8');
  await fs.writeFile(value.target, tex.replace('The first paragraph is editable.', 'The first paragraph came back through a host writer.'));
  const preview = await previewTarget(value);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  const prepared = await prepareTargetApply({ ...value, preview: preview.artifacts.report });
  assert.equal(prepared.status, 'success', JSON.stringify(prepared));
  assert.equal(await fs.readFile(value.input, 'utf8'), value.source, 'preparation cannot change the note');
  assert.equal(await fs.readFile(prepared.artifacts.backup, 'utf8'), value.source);
  const candidate = await fs.readFile(prepared.artifacts.candidate, 'utf8');
  await fs.writeFile(value.input, candidate);
  assert.equal((await targetStatus(value)).externallyEdited, true, 'host persistence alone cannot acknowledge TeX');
  const finalized = await finalizeTargetApply({ ...value, permit: prepared.artifacts.permit });
  assert.equal(finalized.status, 'success', JSON.stringify(finalized));
  assert.equal(finalized.sourceHash, prepared.candidateHash);
  assert.equal((await targetStatus(value)).externallyEdited, false);
});

test('CLI registration is visible independently of output root and refuses unmanaged targets', async () => {
  const value = await fixture();
  const invoke = args => execute(process.execPath, [path.join(root, 'scripts/workshop.cjs'), ...args], { cwd: root });
  const linked = await invoke(['tex-target', value.input, '--target', value.target]);
  assert.equal(JSON.parse(linked.stdout).target, value.target);
  const status = await invoke(['tex-target-status', value.input]);
  assert.equal(JSON.parse(status.stdout).linked, true);
  assert.equal((await setTarget(value)).target, value.target, 'same binding is idempotent');
  await assert.rejects(() => setTarget({ ...value, target: path.join(value.directory, 'different.tex') }), { code: 'TARGET_ALREADY_LINKED' });
  const other = path.join(value.directory, 'other.md'); await fs.writeFile(other, '# Other\n');
  await assert.rejects(() => setTarget({ input: other, target: value.target }), { code: 'TARGET_ALREADY_CLAIMED' });
  const existing = path.join(value.directory, 'existing.tex'); await fs.writeFile(existing, 'Preserve external manuscript');
  await assert.rejects(() => setTarget({ input: other, target: existing }), { code: 'TARGET_EXISTS' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'Preserve external manuscript');
  await unlinkTarget(value);
  assert.equal((await targetStatus(value)).linked, false);
  assert.ok((await fs.readdir(value.target + '.workshop')).some(name => name.startsWith('unlinked-')));
});

test('failed builds, stale reverse previews and conflicting dependency files never replace the target', async () => {
  const value = await fixture(); await setTarget(value);
  const good = await buildLinked(value); assert.equal(good.target.status, 'success');
  const original = await fs.readFile(value.target);
  await fs.writeFile(value.input, value.source + '\nSee [ref{missing}].\n');
  const failed = await buildLinked(value); assert.equal(failed.status, 'error');
  assert.deepEqual(await fs.readFile(value.target), original);
  await fs.writeFile(value.input, value.source);
  const preview = await previewTarget(value); assert.equal(preview.status, 'success');
  await fs.appendFile(value.target, '% A later external change\n');
  const stale = await applyTarget({ ...value, preview: preview.artifacts.report });
  assert.equal(stale.status, 'error'); assert.equal(stale.diagnostics[0].code, 'STALE_PREVIEW');
  assert.equal(await fs.readFile(value.input, 'utf8'), value.source);
  const dependency = await fixture(); await setTarget(dependency);
  dependency.preamble = path.join(root, 'assets/preambles/default-preamble.tex');
  await fs.writeFile(path.join(dependency.directory, 'eptcs.cls'), 'User-owned class');
  const blocked = await buildLinked(dependency);
  assert.equal(blocked.target.code, 'TARGET_DEPENDENCY_CONFLICT');
  await assert.rejects(() => fs.access(dependency.target), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(dependency.directory, 'eptcs.cls'), 'utf8'), 'User-owned class');
});

test('symlinked target and metadata paths cannot redirect writes', async () => {
  const value = await fixture(); await setTarget(value);
  const victim = path.join(value.directory, 'victim.tex'); await fs.writeFile(victim, 'Untouched');
  await fs.symlink(victim, value.target);
  const result = await buildLinked(value);
  assert.equal(result.target.status, 'error');
  assert.equal(await fs.readFile(victim, 'utf8'), 'Untouched');
});

test('an external edit during dependency staging wins over target publication', async () => {
  const value = await fixture();
  await fs.mkdir(path.join(value.directory, 'resources'));
  const support = path.join(value.directory, 'resources/extra.tex');
  await fs.writeFile(support, '% Explicit dependency for the publication race fixture.\n');
  value.support = [support];
  await setTarget(value); const first = await buildLinked(value); assert.equal(first.target.status, 'success');
  await fs.appendFile(value.input, '\nA new Markdown paragraph.\n');
  const originalCopy = fs.copyFile; let changed = false;
  /** Inject a real external target edit at a publication I/O boundary. */
  fs.copyFile = async function editDuringCopy(...args) {
    if (!changed && path.dirname(args[1]) === value.directory) { changed = true; await fs.writeFile(value.target, 'External edit must survive.'); }
    return originalCopy(...args);
  };
  let result;
  try { result = await buildLinked(value); } finally { fs.copyFile = originalCopy; }
  assert.equal(changed, true); assert.equal(result.target.code, 'TARGET_EDITED');
  assert.equal(await fs.readFile(value.target, 'utf8'), 'External edit must survive.');
});

test('moving a linked pair cannot reverse-preview against its previous Markdown location', async () => {
  const value = await fixture(); await setTarget(value); const built = await buildLinked(value); assert.equal(built.target.status, 'success');
  const moved = value.directory + '-moved'; await fs.rename(value.directory, moved);
  const input = path.join(moved, 'draft.md');
  assert.equal((await targetStatus({ input })).linked, true);
  const preview = await previewTarget({ input });
  assert.equal(preview.status, 'error'); assert.equal(preview.diagnostics[0].code, 'CHECKPOINT_SOURCE_MOVED');
});

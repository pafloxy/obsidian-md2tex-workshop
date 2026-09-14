/**
 * Exercise editing checkpoints through the user-facing CLI, not parser internals.
 * Usage, project root: node --test --test-isolation=none testing/roundtrip.test.cjs
 * Every generated fixture, editing copy, report, backup and PDF stays in tmp/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('./execute.cjs');
const root = path.resolve(__dirname, '..');

/** Invoke the real CLI, retaining diagnostic results on nonzero exits. */
async function invoke(...args) {
  const run = await execute(process.execPath, [path.join(root, 'scripts/workshop.cjs'), ...args], { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }).catch(error => error);
  assert.ok(run.stdout, `CLI returned no JSON: ${run.message || run.stderr}`);
  return JSON.parse(run.stdout);
}

/** Create an isolated authored note and a successful editable checkpoint. */
async function checkout(source, extra = []) {
  const directory = await fs.mkdtemp(path.join(root, 'tmp/roundtrip-test-'));
  const input = path.join(directory, 'draft.md');
  await fs.writeFile(input, source, { flag: 'wx' });
  const result = await invoke('tex-checkout', input, '--out-dir', path.join(directory, 'output'), ...extra);
  assert.equal(result.status, 'success', JSON.stringify(result));
  return { directory, input, result };
}

test('uniform syntax completes checkout, edited preview, backed-up apply and a fresh round trip', async () => {
  const source = await fs.readFile(path.join(root, 'testing/fixtures/cli/uniform-authoring.md'), 'utf8');
  const { input, result, directory } = await checkout(source);
  const original = await fs.readFile(result.artifacts.tex, 'utf8');
  const edited = original.replaceAll('eq:square', 'eq:nonnegative').replaceAll('q_a(x)', 'r_a(x)').replace('Nonnegative square on', 'Nonnegative polynomial on').replace('Check the', 'Verify the');
  assert.notEqual(edited, original);
  await fs.writeFile(result.artifacts.tex, edited);
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  const candidate = await fs.readFile(preview.artifacts.candidate, 'utf8');
  assert.equal(await fs.readFile(input, 'utf8'), source);
  assert.match(candidate, /<!-- \[label\{eq:nonnegative\}\] -->/);
  assert.match(candidate, /\[ref\{eq:nonnegative\}\]/);
  assert.match(candidate, /> \[!lemma\] Nonnegative polynomial on/);
  assert.match(candidate, /> r_a\(x\)/);
  assert.match(candidate, /\[todo\{Verify the/);
  assert.doesNotMatch(candidate, /\{=latex\}|\\label/);
  const body = await fs.readFile(preview.build.artifacts.body, 'utf8');
  const oldBody = await fs.readFile(result.build.artifacts.body, 'utf8');
  assert.equal(body, oldBody.replaceAll('eq:square', 'eq:nonnegative').replaceAll('q_a(x)', 'r_a(x)').replace('Nonnegative square on', 'Nonnegative polynomial on').replace('Check the', 'Verify the'));
  const applied = await invoke('tex-apply', input, '--preview', preview.artifacts.report);
  assert.equal(applied.status, 'success', JSON.stringify(applied));
  assert.equal(await fs.readFile(input, 'utf8'), candidate);
  assert.equal(await fs.readFile(applied.artifacts.backup, 'utf8'), source);
  const fresh = await invoke('tex-checkout', input, '--out-dir', path.join(directory, 'fresh'));
  assert.equal(fresh.status, 'success', JSON.stringify(fresh));
  const unchanged = await invoke('tex-sync', fresh.artifacts.session);
  assert.equal(unchanged.status, 'success', JSON.stringify(unchanged));
  assert.equal(await fs.readFile(unchanged.artifacts.candidate, 'utf8'), candidate);
});

test('unchanged TeX returns exact Markdown including frontmatter, comments and authoring choices', async () => {
  const source = '---\ntitle: Original spelling\n---\n\n# Claim \\label{sec:claim}\n\n%% private drafting comment %%\n\nA **bold** fact about $x_1$.\n\n> [!lem] Named claim\n> label:: lem:one\n> True.\n\nSee [add-ref:lem:one].\n';
  const { input, result } = await checkout(source);
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  assert.equal(await fs.readFile(preview.artifacts.candidate, 'utf8'), source);
  assert.equal(await fs.readFile(input, 'utf8'), source);
  assert.equal((await fs.readFile(preview.artifacts.pdf)).subarray(0, 5).toString(), '%PDF-');
});

test('a TeX prose correction returns to original Markdown without losing an inline drafting comment', async () => {
  const source = '# Draft\n\nA **bold** fact %% keep this %% about $x_1$.\n';
  const { input, result } = await checkout(source);
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, tex.replace('\\textbf{bold}', '\\textbf{careful}'));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  assert.equal(await fs.readFile(preview.artifacts.candidate, 'utf8'), '# Draft\n\nA **careful** fact %% keep this %% about $x_1$.\n');
  assert.equal(await fs.readFile(input, 'utf8'), source);
  assert.ok(preview.changes.some(change => change.method === 'source-patch'));
});

test('a new complex TeX block survives as a visible raw island and regenerates byte-for-byte', async () => {
  const { input, result } = await checkout('# Draft\n\nOriginal paragraph.\n');
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  const target = '\\begingroup\n\\newcommand{\\localword}[1]{\\textsc{#1}}\n% Keep this comment and its exact spacing.\n\\begin{center}\n\\localword{preserved} 50\\% \\& $x_2$\n\\end{center}\n\\endgroup\n';
  await fs.writeFile(result.artifacts.tex, tex.replace('Original paragraph.\n', target));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  const candidate = await fs.readFile(preview.artifacts.candidate, 'utf8');
  assert.match(candidate, /```\{=latex\}/);
  assert.ok(candidate.includes(target));
  const body = await fs.readFile(preview.build.artifacts.body, 'utf8');
  assert.equal(body, '\\section{Draft}\n\n' + target + '\n');
  assert.equal(await fs.readFile(input, 'utf8'), '# Draft\n\nOriginal paragraph.\n');
  assert.ok(preview.changes.some(change => change.method === 'raw-tex'));
});

test('new theorem and proof environments return as editable callouts with math, labels and formatting', async () => {
  const { result } = await checkout('# Draft\n\nOriginal paragraph.\n');
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  const target = '\\begin{lemma}[{New claim}]\n\\label{lem:new}\nA \\textbf{useful} claim for $x_2$.\n\n\\begin{proof}\nIndeed, $x_2=x_2$.\n\n\\end{proof}\n\n\\end{lemma}\n\nSee \\cref{lem:new}.\n';
  await fs.writeFile(result.artifacts.tex, tex.replace('Original paragraph.\n', target));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  const candidate = await fs.readFile(preview.artifacts.candidate, 'utf8');
  assert.match(candidate, /> \[!lemma\] New claim/);
  assert.match(candidate, /> A \*\*useful\*\* claim for \$x_2\$/);
  assert.match(candidate, /> > \[!proof\]/);
  assert.match(candidate, /See \[ref\{lem:new\}\]/);
  assert.doesNotMatch(candidate, /\{=latex\}/);
});

test('disjoint Markdown and TeX edits merge while overlapping edits stop for an explicit choice', async () => {
  const source = '# Draft\n\nFirst version.\n\nSecond version.\n';
  const { input, result } = await checkout(source);
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, tex.replace('First version.', 'First TeX edit.'));
  await fs.writeFile(input, source.replace('Second version.', 'Second MD edit.'));
  const disjoint = await invoke('tex-sync', result.artifacts.session);
  assert.equal(disjoint.status, 'success', JSON.stringify(disjoint));
  assert.equal(await fs.readFile(disjoint.artifacts.candidate, 'utf8'), '# Draft\n\nFirst TeX edit.\n\nSecond MD edit.\n');
  await fs.writeFile(input, source.replace('First version.', 'First MD edit.'));
  const conflict = await invoke('tex-sync', result.artifacts.session);
  assert.equal(conflict.status, 'error');
  assert.ok(conflict.diagnostics.some(item => item.code === 'EDIT_CONFLICT'), JSON.stringify(conflict));
  assert.equal(await fs.readFile(input, 'utf8'), source.replace('First version.', 'First MD edit.'));
  assert.ok(conflict.artifacts.report);
  const preferTex = await invoke('tex-sync', result.artifacts.session, '--prefer', 'tex');
  assert.equal(preferTex.status, 'success', JSON.stringify(preferTex));
  assert.equal(await fs.readFile(preferTex.artifacts.candidate, 'utf8'), source.replace('First version.', 'First TeX edit.'));
  const preferMd = await invoke('tex-sync', result.artifacts.session, '--prefer', 'md');
  assert.equal(preferMd.status, 'success', JSON.stringify(preferMd));
  assert.equal(await fs.readFile(preferMd.artifacts.candidate, 'utf8'), source.replace('First version.', 'First MD edit.'));
});

test('explicit apply backs up the note, rejects stale previews and supports another editing cycle', async () => {
  const source = '# Draft\n\nAn initial sentence.\n';
  const { input, result, directory } = await checkout(source);
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, tex.replace('initial sentence', 'corrected sentence'));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  await fs.writeFile(input, source + '\nA newer edit.\n');
  const stale = await invoke('tex-apply', input, '--preview', preview.artifacts.report);
  assert.equal(stale.status, 'error');
  assert.ok(stale.diagnostics.some(item => item.code === 'STALE_PREVIEW'), JSON.stringify(stale));
  assert.equal(await fs.readFile(input, 'utf8'), source + '\nA newer edit.\n');
  await fs.writeFile(input, source);
  const applied = await invoke('tex-apply', input, '--preview', preview.artifacts.report);
  assert.equal(applied.status, 'success', JSON.stringify(applied));
  assert.equal(await fs.readFile(applied.artifacts.backup, 'utf8'), source);
  assert.equal(await fs.readFile(input, 'utf8'), '# Draft\n\nAn corrected sentence.\n');
  const next = await invoke('tex-checkout', input, '--out-dir', path.join(directory, 'second-cycle'));
  assert.equal(next.status, 'success', JSON.stringify(next));
  const nextPreview = await invoke('tex-sync', next.artifacts.session);
  assert.equal(nextPreview.status, 'success', JSON.stringify(nextPreview));
  assert.equal(await fs.readFile(nextPreview.artifacts.candidate, 'utf8'), await fs.readFile(input, 'utf8'));
});

test('an already-edited untracked TeX document can be rescued without inventing Markdown history', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'tmp/roundtrip-import-'));
  const input = path.join(directory, 'existing.tex');
  const source = '\\documentclass{article}\n\\begin{document}\n\\section{Rescued}\n\nA \\textbf{revised} sentence.\n\n\\begin{verbatim}\n\\end{document}\n\\end{verbatim}\n\\end{document}\n';
  await fs.writeFile(input, source);
  const result = await invoke('tex-import', input, '--out-dir', path.join(directory, 'rescued'));
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.outcome, 'review-required');
  assert.equal(await fs.readFile(input, 'utf8'), source);
  assert.equal(await fs.readFile(result.artifacts.original, 'utf8'), source);
  assert.match(await fs.readFile(result.artifacts.candidate, 'utf8'), /\\begin\{verbatim\}\n\\end\{document\}\n\\end\{verbatim\}/);
  const built = await invoke('build', result.artifacts.candidate, '--out-dir', path.join(directory, 'verified'));
  assert.equal(built.status, 'success', JSON.stringify(built));
  const impossibleApply = await invoke('tex-apply', input, '--preview', result.artifacts.report);
  assert.equal(impossibleApply.status, 'error');
});

test('damaged markers and wrapper edits are diagnosed without changing either input', async () => {
  const source = '# Draft\n\nOriginal paragraph.\n';
  const { input, result } = await checkout(source);
  const original = await fs.readFile(result.artifacts.tex, 'utf8');
  const markers = original.match(/^% md2tex:.*\n/gm);
  const cases = [
    ['missing opening', original.replace(markers[0], ''), 'MARKER_CHANGED'],
    ['missing closing', original.replace(markers[1], ''), 'MARKER_CHANGED'],
    ['duplicated opening', original.replace(markers[0], markers[0] + markers[0]), 'MARKER_CHANGED'],
    ['reordered identity', original.replace(':b0001:begin', ':b0002:begin'), 'MARKER_CHANGED'],
    ['untracked insertion', original.replace(markers[2], 'Untracked text.\n' + markers[2]), 'MARKER_CHANGED'],
    ['preamble edit', '% changed recipe\n' + original, 'WRAPPER_CHANGED'],
    ['document ending', original.replace('\\end{document}', '\\clearpage\n\\end{document}'), 'WRAPPER_CHANGED'],
    ['line endings', original.replace(/\n/g, '\r\n'), 'WRAPPER_CHANGED'],
  ];
  for (const [name, edited, code] of cases) {
    await fs.writeFile(result.artifacts.tex, edited);
    const preview = await invoke('tex-sync', result.artifacts.session);
    assert.equal(preview.status, 'error', name);
    assert.ok(preview.diagnostics.some(item => item.code === code), `${name}: ${JSON.stringify(preview)}`);
    assert.equal(await fs.readFile(input, 'utf8'), source, name);
    assert.equal(await fs.readFile(result.artifacts.tex, 'utf8'), edited, name);
    assert.equal(await fs.readFile(preview.artifacts.edited, 'utf8'), edited, name);
  }
});

test('checkpoint and dependency tampering cannot silently change the reconciliation baseline', async () => {
  const { result } = await checkout('# Draft\n\nA sentence.\n', ['--preamble', path.join(root, 'assets/preambles/default-preamble.tex')]);
  const directory = path.dirname(result.artifacts.session);
  const baselinePath = path.join(directory, '_checkpoint/baseline.json');
  const original = await fs.readFile(baselinePath, 'utf8');
  await fs.writeFile(baselinePath, original.replace('A sentence.', 'Tampered sentence.'));
  const baselineChanged = await invoke('tex-sync', result.artifacts.session);
  assert.ok(baselineChanged.diagnostics.some(item => item.code === 'BASELINE_CHANGED'), JSON.stringify(baselineChanged));
  await fs.writeFile(baselinePath, original);
  const preamble = path.join(directory, '_checkpoint/preamble.tex');
  const preambleText = await fs.readFile(preamble, 'utf8');
  await fs.writeFile(preamble, preambleText + '\n% changed\n');
  const recipeChanged = await invoke('tex-sync', result.artifacts.session);
  assert.ok(recipeChanged.diagnostics.some(item => item.code === 'DEPENDENCY_CHANGED'), JSON.stringify(recipeChanged));
  await fs.writeFile(preamble, preambleText);
  const baseline = JSON.parse(original);
  const support = path.join(directory, baseline.files.find(file => file.editableName).editableName);
  await fs.appendFile(support, '\n% edited support file\n');
  const supportChanged = await invoke('tex-sync', result.artifacts.session);
  assert.ok(supportChanged.diagnostics.some(item => item.code === 'DEPENDENCY_CHANGED'), JSON.stringify(supportChanged));
});

test('apply rejects changed candidates, changed TeX, wrong targets, tampered reports and symlink targets', async () => {
  const source = '# Draft\n\nOriginal sentence.\n';
  const { input, result, directory } = await checkout(source);
  const originalTex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, originalTex.replace('Original sentence.', 'New sentence.'));
  const editedTex = await fs.readFile(result.artifacts.tex, 'utf8');
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  const candidate = await fs.readFile(preview.artifacts.candidate, 'utf8');
  const report = await fs.readFile(preview.artifacts.report, 'utf8');
  const wrong = path.join(directory, 'unrelated.md');
  await fs.writeFile(wrong, source);
  assert.ok((await invoke('tex-apply', wrong, '--preview', preview.artifacts.report)).diagnostics.some(item => item.code === 'WRONG_APPLY_TARGET'));
  await fs.writeFile(preview.artifacts.candidate, candidate + '\nNew unscreened text.\n');
  assert.ok((await invoke('tex-apply', input, '--preview', preview.artifacts.report)).diagnostics.some(item => item.code === 'STALE_PREVIEW'));
  await fs.writeFile(preview.artifacts.candidate, candidate);
  await fs.writeFile(result.artifacts.tex, originalTex);
  assert.ok((await invoke('tex-apply', input, '--preview', preview.artifacts.report)).diagnostics.some(item => item.code === 'STALE_PREVIEW'));
  await fs.writeFile(result.artifacts.tex, editedTex);
  await fs.writeFile(preview.artifacts.report, report.replace('"outcome": "ready"', '"outcome": "forged"'));
  assert.ok((await invoke('tex-apply', input, '--preview', preview.artifacts.report)).diagnostics.some(item => item.code === 'INVALID_PREVIEW'));
  await fs.writeFile(preview.artifacts.report, report);
  const real = path.join(directory, 'actual-note.md');
  await fs.rename(input, real);
  await fs.symlink(real, input);
  assert.ok((await invoke('tex-apply', input, '--preview', preview.artifacts.report)).diagnostics.some(item => item.code === 'UNSAFE_APPLY_TARGET'));
  assert.equal(await fs.readFile(real, 'utf8'), source);
  assert.equal(await fs.readFile(wrong, 'utf8'), source);
});

test('math, nested lists, TODOs, code and literal escapes survive several edits in the acceptance document', async () => {
  const source = await fs.readFile(path.join(root, 'testing/fixtures/cli/m2-acceptance.md'), 'utf8');
  const { result } = await checkout(source);
  const originalTex = await fs.readFile(result.artifacts.tex, 'utf8');
  const edits = [['We measured 50\\%', 'We measured 75\\%'], ['x_1=x_1', 'x_1=1x_1'], ['Third step.', 'Third revised step.'], ['This is literal code', 'This remains literal code']];
  let tex = originalTex;
  let expectedBody = await fs.readFile(result.build.artifacts.body, 'utf8');
  for (const [before, after] of edits) { assert.ok(tex.includes(before), before); tex = tex.replaceAll(before, after); expectedBody = expectedBody.replaceAll(before, after); }
  await fs.writeFile(result.artifacts.tex, tex);
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  assert.equal(await fs.readFile(preview.build.artifacts.body, 'utf8'), expectedBody);
  const candidate = await fs.readFile(preview.artifacts.candidate, 'utf8');
  assert.ok(candidate.includes('```text\n'));
  assert.ok(candidate.includes('%% This comment and its [add-ref:missing] are deliberately not exported. %%'));
  assert.ok(candidate.includes('> > [!proof]'));
  const { stdout } = await execute('pdftotext', ['-layout', preview.artifacts.pdf, '-']);
  assert.match(stdout, /We measured 75%/);
  assert.match(stdout, /Third revised step/);
  assert.match(stdout, /This remains literal code/);
});

test('nonstandard TeX tokenization is refused before a synchronized candidate can execute it', async () => {
  const { result } = await checkout('# Draft\n\nOrdinary text.\n');
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, tex.replace('Ordinary text.', '\\catcode`\\%=12\nOrdinary text.'));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'error', JSON.stringify(preview));
  assert.ok(preview.diagnostics.some(item => item.code === 'UNSUPPORTED_TEX_TOKENIZATION'), JSON.stringify(preview));
  assert.equal(preview.build, undefined);
});

test('malformed or unresolved edited TeX preserves a failed candidate and cannot authorize apply', async () => {
  const source = '# Draft\n\nOriginal sentence.\n';
  const { input, result } = await checkout(source);
  const original = await fs.readFile(result.artifacts.tex, 'utf8');
  const cases = [
    ['undefined command', '\\undefinedworkshoproundtripcommand', 'LATEX_ERROR'],
    ['unclosed group', '\\begingroup\n{unclosed', 'INCOMPLETE_TEX_STATE'],
    ['raw unresolved reference', '\\begingroup\nSee \\ref{missing:target}.\n\\endgroup', 'UNRESOLVED_REFERENCE'],
  ];
  for (const [name, replacement, expected] of cases) {
    await fs.writeFile(result.artifacts.tex, original.replace('Original sentence.', replacement));
    const preview = await invoke('tex-sync', result.artifacts.session);
    assert.equal(preview.status, 'error', name);
    assert.ok(preview.artifacts.candidate, `${name}: ${JSON.stringify(preview.diagnostics)}`);
    assert.ok(preview.build.diagnostics.some(item => item.code === expected), `${name}: ${JSON.stringify(preview.build.diagnostics)}`);
    assert.equal((await invoke('tex-apply', input, '--preview', preview.artifacts.report)).status, 'error');
    assert.equal(await fs.readFile(input, 'utf8'), source);
    const previous = JSON.parse(await fs.readFile(result.build.artifacts.lastSuccess, 'utf8'));
    assert.equal(previous.attemptId, result.build.attemptId);
  }
});

test('uncertain Markdown-only comment placement is a conflict, not silently discarded content', async () => {
  const source = '# Draft\n\nOld words %% keep private drafting note %% and context.\n';
  const { input, result } = await checkout(source);
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, tex.replace('Old words  and context.', 'Entirely different prose.'));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'error');
  assert.ok(preview.diagnostics.some(item => item.code === 'MD_ONLY_CONTENT'), JSON.stringify(preview.diagnostics));
  assert.equal(await fs.readFile(input, 'utf8'), source);
});

test('raw TeX comments are not mistaken for hidden Markdown comments when replacing an environment', async () => {
  const source = '# Draft\n\n```{=latex}\n\\begin{center}\n%% A TeX comment, not a Markdown-only comment.\nOld centered text.\n\\end{center}\n```\n';
  const { result } = await checkout(source);
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, tex.replace('\\begin{center}\n%% A TeX comment, not a Markdown-only comment.\nOld centered text.\n\\end{center}', '\\begin{flushright}\n%% Revised TeX comment.\nNew right-aligned text.\n\\end{flushright}'));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview.diagnostics));
  assert.ok((await fs.readFile(preview.artifacts.candidate, 'utf8')).includes('%% Revised TeX comment.'));
});

test('BOM, CRLF, metadata-only edits and missing final newlines retain their source bytes', async () => {
  const source = '\uFEFF---\r\ntitle: Original\r\n---\r\n\r\n# Draft\r\n\r\nA sentence.';
  const { input, result } = await checkout(source);
  const unchanged = await invoke('tex-sync', result.artifacts.session);
  assert.equal(unchanged.status, 'success', JSON.stringify(unchanged.diagnostics));
  assert.equal(await fs.readFile(unchanged.artifacts.candidate, 'utf8'), source);
  const edited = source.replace('title: Original', 'title: Revised');
  await fs.writeFile(input, edited);
  const changed = await invoke('tex-sync', result.artifacts.session);
  assert.equal(changed.status, 'success', JSON.stringify(changed.diagnostics));
  assert.equal(await fs.readFile(changed.artifacts.candidate, 'utf8'), edited);
});

test('body deletion, identical edits on both sides and a Markdown-only inserted block are safe', async () => {
  const source = '# Draft\n\nFirst sentence.\n\nSecond sentence.\n';
  const { input, result } = await checkout(source);
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, tex.replace('Second sentence.\n\n', ''));
  const deleted = await invoke('tex-sync', result.artifacts.session);
  assert.equal(deleted.status, 'success', JSON.stringify(deleted.diagnostics));
  assert.equal(await fs.readFile(deleted.artifacts.candidate, 'utf8'), '# Draft\n\nFirst sentence.\n\n');
  await fs.writeFile(result.artifacts.tex, tex.replace('First sentence.', 'Same edit.'));
  await fs.writeFile(input, source.replace('First sentence.', 'Same edit.'));
  const same = await invoke('tex-sync', result.artifacts.session);
  assert.equal(same.status, 'success', JSON.stringify(same.diagnostics));
  assert.equal(await fs.readFile(same.artifacts.candidate, 'utf8'), source.replace('First sentence.', 'Same edit.'));
  await fs.writeFile(result.artifacts.tex, tex);
  await fs.writeFile(input, source + '\n## New section\n\nFresh Markdown.\n');
  const inserted = await invoke('tex-sync', result.artifacts.session);
  assert.equal(inserted.status, 'success', JSON.stringify(inserted.diagnostics));
  assert.equal(await fs.readFile(inserted.artifacts.candidate, 'utf8'), await fs.readFile(input, 'utf8'));
});

test('invalid UTF-8 and oversized sources are rejected before creating a checkpoint', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'tmp/roundtrip-input-'));
  const input = path.join(directory, 'invalid.md');
  for (const [bytes, code] of [[Buffer.from([0xff, 0xfe, 0]), 'INVALID_ENCODING'], [Buffer.alloc(4 * 1024 * 1024 + 1, 65), 'INPUT_SIZE_LIMIT']]) {
    await fs.writeFile(input, bytes);
    const result = await invoke('tex-checkout', input, '--out-dir', path.join(directory, 'output'));
    assert.equal(result.status, 'error');
    assert.ok(result.diagnostics.some(item => item.code === code), JSON.stringify(result.diagnostics));
    assert.equal(result.build, undefined);
  }
});

test('literal external file reads require declared checkpoint dependencies', async () => {
  const { result, directory } = await checkout('# Draft\n\nOriginal sentence.\n');
  const external = path.join(directory, 'untracked.tex');
  await fs.writeFile(external, 'External text.\n');
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, tex.replace('Original sentence.', `\\input{${external}}`));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'error');
  assert.ok(preview.diagnostics.some(item => item.code === 'UNTRACKED_RESOURCE'), JSON.stringify(preview.diagnostics));
  assert.equal(preview.build, undefined);
});

test('new nested lists and numbered equations return to Markdown containers', async () => {
  const { result } = await checkout('# Draft\n\nOriginal sentence.\n');
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  const target = '\\begin{enumerate}\n\\setcounter{enumi}{2}\n\\item\nFirst $x_1$.\n\n\\begin{itemize}\n\\item\nNested item.\n\n\\end{itemize}\n\n\\item\nNext item.\n\n\\end{enumerate}\n\n\\begin{equation}\n\\label{eq:new}\nx_1=x_1\n\\end{equation}\n\nSee \\cref{eq:new}.\n';
  await fs.writeFile(result.artifacts.tex, tex.replace('Original sentence.\n', target));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview.diagnostics));
  const candidate = await fs.readFile(preview.artifacts.candidate, 'utf8');
  assert.match(candidate, /3\. First \$x_1\$/);
  assert.match(candidate, /   - Nested item\./);
  assert.ok(candidate.includes('> [!equation]\n> <!-- [label{eq:new}] -->\n> $$\n> x_1=x_1\n> $$'));
  assert.doesNotMatch(candidate, /\{=latex\}/);
});

test('Markdown changing during candidate compilation prevents publication of a ready preview', async () => {
  const source = '# Draft\n\nOriginal sentence.\n';
  const { input, result, directory } = await checkout(source);
  const wrapper = path.join(directory, 'latexmk-edit-fixture.cjs');
  await fs.writeFile(wrapper, `#!/usr/bin/env node\n/** Test-only compiler wrapper; usage: ./latexmk-edit-fixture.cjs [latexmk arguments]. */\nconst { spawnSync } = require('node:child_process');\nconst fs = require('node:fs');\nconst run = spawnSync('/usr/bin/latexmk', process.argv.slice(2), { stdio: 'inherit' });\nfs.appendFileSync(${JSON.stringify(input)}, '\\nAn edit during compilation.\\n');\nprocess.exit(run.status ?? 1);\n`, { mode: 0o700 });
  const preview = await invoke('tex-sync', result.artifacts.session, '--latexmk', wrapper);
  assert.equal(preview.status, 'error');
  assert.ok(preview.diagnostics.some(item => item.code === 'STALE_PREVIEW'), JSON.stringify(preview.diagnostics));
  assert.equal(await fs.readFile(input, 'utf8'), source + '\nAn edit during compilation.\n');
  assert.equal((await invoke('tex-apply', input, '--preview', preview.artifacts.report)).status, 'error');
});

test('round-trip commands reject ignored or misplaced options instead of implying they took effect', async () => {
  for (const args of [
    ['tex-sync', 'unused-session', '--preamble', 'unused.tex'],
    ['tex-apply', 'unused.md', '--preview', 'unused.json', '--prefer', 'tex'],
    ['tex-import', 'unused.tex', '--out-dir', 'tmp/unused', '--engine', 'xelatex'],
    ['tex-checkout', 'unused.md', '--out-dir', 'tmp/unused', '--body-only'],
  ]) {
    const result = await invoke(...args);
    assert.equal(result.status, 'error');
    assert.equal(result.stage, 'arguments', JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(item => item.code === 'INVALID_ARGUMENT'));
  }
});

test('custom recipes, declared includes and bibliography remain frozen and the editable marked TeX compiles', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'tmp/roundtrip-recipe-'));
  const preamble = path.join(directory, 'custom preamble.tex');
  const support = path.join(directory, 'part.tex');
  const bibliography = path.join(directory, 'references.bib');
  await fs.writeFile(preamble, '\\documentclass{article}\n\\usepackage{amsmath,hyperref,cleveref}\n');
  await fs.writeFile(support, 'Declared support stays.\n');
  await fs.writeFile(bibliography, '@book{example, author={Ada Lovelace}, title={A Tested Reference}, year={1843}, publisher={Example}}\n');
  const { result } = await checkout('# Draft\n\nOriginal sentence cites [add-cite:example].\n\n\\input{part.tex}\n', ['--preamble', preamble, '--support', support, '--bib', bibliography, '--bibliography', 'bibtex']);
  await fs.writeFile(support, 'This later external source edit is not the frozen dependency.\n');
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  const edited = tex.replace('Original sentence cites', 'Edited sentence cites');
  await fs.writeFile(result.artifacts.tex, edited);
  const editing = path.dirname(result.artifacts.tex);
  await execute('latexmk', ['-norc', '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-no-shell-escape', 'main.tex'], { cwd: editing, timeout: 30000, env: { ...process.env, TEXMFVAR: path.join(editing, 'tex-cache'), TEXMFCONFIG: path.join(editing, 'tex-config'), VARTEXFONTS: path.join(editing, 'tex-fonts') } });
  assert.equal(await fs.readFile(result.artifacts.tex, 'utf8'), edited);
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'success', JSON.stringify(preview.diagnostics));
  const { stdout } = await execute('pdftotext', ['-layout', preview.artifacts.pdf, '-']);
  assert.match(stdout, /Edited sentence cites/);
  assert.match(stdout, /Declared support stays/);
  assert.match(stdout, /Lovelace/);
  assert.doesNotMatch(stdout, /later external source edit/);
});

test('a verbatim environment spanning checkpoint markers is refused instead of deleting printed marker text', async () => {
  const { result } = await checkout('# Draft\n\nFirst sentence.\n\nSecond sentence.\n');
  const tex = await fs.readFile(result.artifacts.tex, 'utf8');
  await fs.writeFile(result.artifacts.tex, tex.replace('First sentence.', '\\begin{verbatim}\nFirst sentence.').replace('Second sentence.', 'Second sentence.\n\\end{verbatim}'));
  const preview = await invoke('tex-sync', result.artifacts.session);
  assert.equal(preview.status, 'error');
  assert.ok(preview.diagnostics.some(item => item.code === 'MARKER_IN_LITERAL'), JSON.stringify(preview.diagnostics));
  assert.equal(preview.build, undefined);
});

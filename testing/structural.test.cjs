/**
 * Content-preservation contracts through the public CLI, with real TeX builds.
 * Usage from the project root: node testing/structural.test.cjs
 * Generated inputs and evidence stay under ./tmp/; nothing is deployed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('./execute.cjs');
const root = path.resolve(__dirname, '..');

/** Build a fresh note using the user-facing command and retain its evidence. */
async function buildNote(source, extra = []) {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/structural-test-'));
  const input = path.join(dir, 'draft.md');
  await fs.writeFile(input, source);
  const args = [path.join(root, 'scripts/workshop.cjs'), 'build', input, '--out-dir', path.join(dir, 'build'), ...extra];
  const run = await execute(process.execPath, args, { cwd: root }).catch(error => error);
  const result = JSON.parse(run.stdout);
  return { result, input, dir };
}

/** Require a real, validated build and return its emitted TeX and PDF text. */
async function content(result) {
  assert.equal(result.status, 'success', JSON.stringify({ stage: result.stage, diagnostics: result.diagnostics, attempt: result.artifacts.attempt }));
  const body = await fs.readFile(result.artifacts.body, 'utf8');
  const { stdout: pdf } = await execute('pdftotext', ['-layout', result.artifacts.pdf, '-']);
  return { body, pdf };
}

test('prose, math, inline code and fenced code retain distinct literal semantics', async () => {
  const { result } = await buildNote(await fs.readFile(path.join(root, 'testing/fixtures/cli/structural.md'), 'utf8'));
  const { body, pdf } = await content(result);
  assert.match(body, /50\\% and retained this sentence/);
  assert.match(body, /research \\& development/);
  assert.match(body, /\$x_1\^2\$/);
  assert.match(body, /\\texttt\{file\\_name\}/);
  assert.match(body, /\\begin\{verbatim\}\n\[add-ref:ghost\] \$x_1\$ 50% & \\label\{ghost\}\n\\end\{verbatim\}/);
  assert.match(pdf, /50% and retained this sentence/);
  assert.match(pdf, /research & development/);
  assert.match(pdf, /\[add-ref:ghost\]/);
});

test('forward and backward references resolve through metadata and raw labels', async () => {
  const { result } = await buildNote(String.raw`---
title: Label compatibility
---
# Results \label{sec:results}

See [add-ref:lem:identity] and [add-ref:eq:identity] before their declarations.

> [!lemma] Identity
> label:: lem:identity
> \label{lem:identity}
>
> For every $x_1$, we have $x_1=x_1$.
>
> > [!proof]
> > By equality, $x_1=x_1$.

> [!definition] Identity function
> label:: def:identity
> Let $f(x)=x$.

> [!equation]
> <!-- [label{eq:identity}] -->
> $$
> x_1=x_1
> $$

Return to \cref{sec:results,lem:identity,def:identity}.
`);
  const { body, pdf } = await content(result);
  assert.equal((body.match(/\\label\{lem:identity\}/g) || []).length, 1);
  assert.match(body, /\\begin\{lemma\}\[\{Identity\}\]/);
  assert.match(body, /\\label\{def:identity\}/);
  assert.match(body, /\\begin\{equation\}/);
  assert.doesNotMatch(body, /label::|\[!|add-ref/);
  assert.match(pdf, /Lemma 1\.1/);
  assert.match(pdf, /Definition 1\.2/);
  assert.doesNotMatch(pdf, /\?\?/);
  const document = JSON.parse(await fs.readFile(result.artifacts.document, 'utf8'));
  assert.deepEqual(document.labels.map(item => item.id).sort(), ['def:identity', 'eq:identity', 'lem:identity', 'sec:results']);
});

test('opaque raw environments and comments cannot create phantom references or labels', async () => {
  const { result } = await buildNote(String.raw`# Protected regions

%%
[add-ref:missing] \label{eq:real}

[[Not a link]]
%%

This survives %% [add-ref:also-missing] %% after the comment.

\begin{verbatim}
[add-ref:missing] \label{eq:real} $50 & x_y
\end{verbatim}

\begin{align}
\label{eq:real}
x_1 &= x_1 \\
y_1 &= y_1
\end{align}

See [add-ref:eq:real].
`);
  const { body, pdf } = await content(result);
  assert.match(body, /\\begin\{align\}\n\\label\{eq:real\}/);
  assert.doesNotMatch(body, /\\\[\\begin\{align\}/);
  assert.match(pdf, /This survives\s+after the comment/);
  assert.doesNotMatch(pdf, /Not a link|also-missing/);
  const document = JSON.parse(await fs.readFile(result.artifacts.document, 'utf8'));
  assert.deepEqual(document.labels.map(item => item.id), ['eq:real']);
});

test('nested lists, emphasis and generic callouts preserve readable structure and TODOs', async () => {
  const { result } = await buildNote(String.raw`# A **clear** structure

> [!warning] Check & retain
> Keep *every* word and [todo: verify 50% & units].
>
> - First **important** item.
>   - Nested item with $x_1$.
> - Second item.

3. Third step.
4. Fourth step.

An **outer *inner* phrase** stays grouped. An _emphasis_ and file_name coexist.
`);
  const { body, pdf } = await content(result);
  assert.match(body, /\\begin\{itemize\}/);
  assert.match(body, /\\begin\{enumerate\}/);
  assert.match(body, /\\textbf\{outer \\emph\{inner\} phrase\}/);
  assert.match(body, /\\emph\{emphasis\} and file\\_name/);
  assert.match(pdf, /TODO: verify 50% & units/);
  assert.match(pdf, /3\. Third step/);
  assert.doesNotMatch(body, /\\begin\{warning\}|\[todo:/);
});

test('conversion rejects ambiguous IDs and unsupported structures at their source lines', async () => {
  const cases = [
    ['# A \\label{sec:a}\n\n# B \\label{sec:a}\n', 'DUPLICATE_LABEL', 6],
    ['> [!lemma] \\label{lem:a}\n> label:: lem:b\n> Text.\n', 'CONFLICTING_LABEL', 5],
    ['See [add-ref:missing].\n', 'UNRESOLVED_REFERENCE', 4],
    ['label:: orphan\n', 'UNSCOPED_LABEL', 4],
    ['![A figure](missing.png)\n', 'UNSUPPORTED_IMAGE', 4],
    ['Compare [[Related note|display text]].\n', 'UNSUPPORTED_WIKILINK', 4],
    ['| A | B |\n| --- | --- |\n| 1 | 2 |\n', 'UNSUPPORTED_TABLE', 5],
    ['<div>Important content</div>\n', 'UNSUPPORTED_HTML', 4],
  ];
  for (const [source, code, line] of cases) {
    const { result, input } = await buildNote(`---\ntitle: Source locations\n---\n${source}`);
    assert.equal(result.status, 'error', source);
    assert.equal(result.stage, 'conversion', source);
    assert.ok(result.diagnostics.some(item => item.code === code && item.line === line && item.path === input), JSON.stringify(result.diagnostics));
    await assert.rejects(fs.access(result.artifacts.compilationLog));
  }
});

test('compiler diagnostics and emitted block maps point back into the original Markdown', async () => {
  const source = String.raw`---
title: Original line map
---
# Mapping

> [!lemma] Mapped block
> A statement.
>
> \undefinedworkshopcommand
`;
  const { result, input } = await buildNote(source);
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'compilation');
  assert.ok(result.diagnostics.some(item => item.code === 'LATEX_ERROR' && item.path === input && item.line === 9 && item.texLine > 0), JSON.stringify(result.diagnostics));
  const map = JSON.parse(await fs.readFile(result.artifacts.sourceMap, 'utf8'));
  const tex = (await fs.readFile(result.artifacts.tex, 'utf8')).split('\n');
  const mapped = map.lines.find(item => tex[item.texLine - 1].includes('\\undefinedworkshopcommand'));
  assert.equal(mapped.line, 9);
  assert.equal(map.source, input);
  assert.ok(map.lines.every(item => item.line >= 4 && item.texLine > 0));
});

test('Markdown hyperlinks preserve their caption and exact destination without fetching it', async () => {
  const { result } = await buildNote(String.raw`# Links \label{sec:links}

Read [Research & data](https://example.org/a_(b)?q=50%25&key=file_name#part).
Return to [this section](#sec:links).
`);
  const { body, pdf } = await content(result);
  assert.match(body, /\\href\{/);
  assert.match(body, /\\hyperref\[sec:links\]\{this section\}/);
  assert.match(pdf, /Research & data/);
  const { stdout } = await execute('pdfinfo', ['-url', result.artifacts.pdf]);
  assert.ok(stdout.includes('https://example.org/a_(b)?q=50%25&key=file_name#part'), stdout);
});

test('unfinished drafts and unsupported ambiguities fail before TeX instead of losing text', async () => {
  const cases = [
    ['Unclosed $x_1', 'UNCLOSED_MATH'],
    ['```text\nunfinished', 'UNCLOSED_FENCE'],
    ['Literal `unfinished', 'UNCLOSED_CODE'],
    ['%% unfinished', 'UNCLOSED_COMMENT'],
    ['\\begin{align}\nx_1 &= x_1', 'UNCLOSED_ENVIRONMENT'],
    ['\\begin{align}\nx_1 &= x_1\n\\end{gather}', 'MISMATCHED_ENVIRONMENT'],
    ['\\textbf{unfinished', 'UNCLOSED_TEX_ARGUMENT'],
    ['> [!lemma unfinished\n> Body', 'INVALID_CALLOUT'],
    ['A [link](https://example.org/unfinished', 'UNCLOSED_LINK'],
    ['Here \\begin{equation}x_1=1\\end{equation}', 'INLINE_RAW_ENVIRONMENT'],
    ['    code_with_indent & $literal', 'UNSUPPORTED_INDENTED_CODE'],
    ['Title\n=====', 'UNSUPPORTED_SETEXT_HEADING'],
    ['[Read][source]\n\n[source]: https://example.org', 'UNSUPPORTED_REFERENCE_LINK'],
    ['A footnote[^note].', 'UNSUPPORTED_FOOTNOTE'],
  ];
  for (const [source, code] of cases) {
    const { result } = await buildNote(source);
    assert.equal(result.status, 'error', source);
    assert.equal(result.stage, 'conversion', source);
    assert.ok(result.diagnostics.some(item => item.code === code), JSON.stringify(result.diagnostics));
    await assert.rejects(fs.access(result.artifacts.compilationLog));
  }
});

test('multiline literal spans do not shift diagnostics for later source lines', async () => {
  const { result, input } = await buildNote('---\ntitle: Multiline literals\n---\n# Mapping\n\nA `two\nline` code span.\n\\undefinedworkshopcommand\n');
  assert.equal(result.stage, 'compilation');
  assert.ok(result.diagnostics.some(item => item.code === 'LATEX_ERROR' && item.path === input && item.line === 8), JSON.stringify(result.diagnostics));
});

test('callout-looking text inside quoted code stays literal across adjacent callouts', async () => {
  const source = '# Quoted literals\n\n> [!lemma] Outer\n> <!-- [label{lem:outer}] -->\n> ```text\n> [!warning] literal, not a new callout\n> \\label{lem:outer}\n> ```\n> [!proof]\n> The proof follows the literal example.\n\nSee [add-ref:lem:outer].\n';
  const { result } = await buildNote(source);
  const { body, pdf } = await content(result);
  assert.match(body, /\\begin\{verbatim\}\n\[!warning\] literal, not a new callout/);
  assert.equal((body.match(/\\begin\{proof\}/g) || []).length, 1);
  assert.match(pdf, /literal, not a new callout/);
});

test('TODO annotations retain mathematical spans and never require an undeclared todo macro', async () => {
  const { result } = await buildNote(String.raw`# TODO mathematics

[todo: check $[x_1,y_1]$ at 50% & retain the remainder].
`);
  const { body, pdf } = await content(result);
  assert.match(body, /\$\[x_1,y_1\]\$/);
  assert.doesNotMatch(body, /\\todo\{|\\textbackslash\{\}/);
  assert.match(pdf, /50% & retain the remainder/);
});

test('literal heading punctuation and redundant raw callout title labels are preserved', async () => {
  const { result } = await buildNote(String.raw`# C# & costs#

> [!lemma] Named statement \label{lem:title}
> label:: lem:title
> A statement.

See [add-ref:lem:title].
`);
  const { body, pdf } = await content(result);
  assert.match(body, /\\section\{C\\# \\& costs\\#\}/);
  assert.equal((body.match(/\\label\{lem:title\}/g) || []).length, 1);
  assert.match(pdf, /C# & costs#/);
});
